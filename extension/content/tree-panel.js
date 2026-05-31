/*
 * tree-panel.js  —  the injected, collapsible topic-tree panel (Phase 3).
 *
 * Rendered as a git-graph: each node is a coloured dot on a lane (lane = depth),
 * with an SVG layer behind the rows drawing vertical rails and curved branch
 * connectors (parent dot → child dot). Read-only for now: clicking a row label
 * selects the node (→ highlight + scroll); the dot's twisty toggles collapse.
 *
 * DOM is built with createElement (never innerHTML with user titles); every
 * class is `.ctv-` prefixed so we can't collide with claude.ai styles.
 */
(function () {
  "use strict";

  var CTV = (window.CTV = window.CTV || {});
  var SVG_NS = "http://www.w3.org/2000/svg";

  var PANEL_ID = "ctv-panel";
  var FAB_ID = "ctv-fab";

  // Layout geometry (px).
  var ROW_H = 30;
  var LANE_W = 16;
  var LANE_PAD = 12;
  var DOT_R = 4.5;

  // Node colour: a hue across the full spectrum derived from the node's stable
  // id (root is a fixed teal). Full-spectrum hues — rather than a small fixed
  // palette — keep colours both stable per node and distinct (no bucket
  // collisions).
  var ROOT_COLOR = "#0d9488";

  var els = null;            // { panel, fab, tree, empty }
  var lastResult = null;
  var handlers = {};
  var collapsed = new Set(); // UI-only collapse state (node ids)
  var activeNodeId = null;
  var lastColors = {};       // nodeId → palette colour (from last render)
  var dragNodeId = null;     // node being dragged (reparent)

  function dotX(depth) { return LANE_PAD + depth * LANE_W; }
  function textX(depth) { return dotX(depth) + DOT_R + 6; } // clears the current-node ring

  // ---- panel chrome --------------------------------------------------------
  function buildChrome() {
    if (els) return els;

    var panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "ctv-panel ctv-open";

    var header = document.createElement("div");
    header.className = "ctv-panel-header";

    var title = document.createElement("span");
    title.className = "ctv-panel-title";
    title.textContent = "Topic Tree";

    var reset = document.createElement("button");
    reset.className = "ctv-btn ctv-panel-reset";
    reset.type = "button";
    reset.title = "Reset organization — clear all your renames, moves and deletions for this conversation";
    reset.textContent = "Reset";
    reset.addEventListener("click", function () {
      if (typeof handlers.onReset === "function" &&
          window.confirm("Reset organization?\n\nThis clears all your renames, moves and deletions for this conversation. The marker-based tree is rebuilt.")) {
        handlers.onReset();
      }
    });

    var close = document.createElement("button");
    close.className = "ctv-btn ctv-panel-close";
    close.type = "button";
    close.title = "Collapse panel";
    close.textContent = "×";
    close.addEventListener("click", hide);

    header.appendChild(title);
    header.appendChild(reset);
    header.appendChild(close);

    var empty = document.createElement("div");
    empty.className = "ctv-empty";
    empty.textContent = "No topics yet. Type /node Topic > Subtopic in a message to organize.";

    var tree = document.createElement("div");
    tree.className = "ctv-tree";
    tree.setAttribute("role", "tree");

    panel.appendChild(header);
    panel.appendChild(empty);
    panel.appendChild(tree);

    var fab = document.createElement("button");
    fab.id = FAB_ID;
    fab.className = "ctv-fab ctv-hidden";
    fab.type = "button";
    fab.title = "Show topic tree";
    fab.textContent = "Tree";
    fab.addEventListener("click", show);

    document.body.appendChild(panel);
    document.body.appendChild(fab);

    els = { panel: panel, fab: fab, tree: tree, empty: empty };
    return els;
  }

  function show() {
    buildChrome();
    els.panel.classList.add("ctv-open");
    els.fab.classList.add("ctv-hidden");
    // Restore the selected node's highlights + minimap (without re-scrolling),
    // since hide() cleared them.
    if (activeNodeId && CTV.highlighting && CTV.highlighting.highlightNodeMessages) {
      CTV.highlighting.highlightNodeMessages(activeNodeId, true);
    }
  }

  function hide() {
    if (!els) return;
    els.panel.classList.remove("ctv-open");
    els.fab.classList.remove("ctv-hidden");
    // Closing the panel also clears the selection visuals (message highlights
    // + minimap), so nothing is left dangling over the conversation.
    if (CTV.highlighting && CTV.highlighting.clearMessageHighlights) {
      CTV.highlighting.clearMessageHighlights();
    }
  }

  function toggleCollapse(nodeId) {
    if (collapsed.has(nodeId)) collapsed.delete(nodeId);
    else collapsed.add(nodeId);
    rerender();
  }

  // ---- editing helpers -----------------------------------------------------
  function isDescendant(ancestorId, maybeDescId) {
    if (!lastResult) return false;
    var nodes = lastResult.tree.nodes;
    var cur = nodes[maybeDescId];
    var guard = 0;
    while (cur && cur.parentId && guard++ < 100000) {
      if (cur.parentId === ancestorId) return true;
      cur = nodes[cur.parentId];
    }
    return false;
  }

  // A drop is valid if it won't no-op or create a cycle.
  function isValidDrop(dragId, targetId) {
    if (!dragId || !targetId || dragId === targetId || !lastResult) return false;
    if (dragId === lastResult.rootNodeId) return false;        // can't move root
    var node = lastResult.tree.nodes[dragId];
    if (node && node.parentId === targetId) return false;      // already there
    if (isDescendant(dragId, targetId)) return false;          // would cycle
    return true;
  }

  function clearDropTargets() {
    if (!els) return;
    var ds = els.tree.querySelectorAll(".ctv-row-drop");
    Array.prototype.forEach.call(ds, function (r) { r.classList.remove("ctv-row-drop"); });
  }

  // Inline rename: swap the label for an input; Enter/blur saves, Esc cancels.
  function startRename(row, labelWrap, label, nodeId, currentTitle) {
    row.draggable = false; // don't let the drag handler hijack text selection
    var input = document.createElement("input");
    input.className = "ctv-rename-input";
    input.value = currentTitle;
    labelWrap.replaceChild(input, label);
    input.focus();
    input.select();

    var done = false;
    function finish(save) {
      if (done) return;
      done = true;
      if (save && typeof handlers.onRename === "function") {
        handlers.onRename(nodeId, input.value); // controller re-renders
      } else {
        rerender(); // restore
      }
    }
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", function () { finish(true); });
    input.addEventListener("click", function (e) { e.stopPropagation(); });
    input.addEventListener("dblclick", function (e) { e.stopPropagation(); });
  }

  // ---- layout --------------------------------------------------------------
  // Pre-order DFS over the visible tree (collapsed subtrees skipped).
  function flatten(result) {
    var rows = [];
    (function walk(nodeId, depth) {
      var node = result.tree.nodes[nodeId];
      if (!node) return;
      rows.push({ nodeId: nodeId, depth: depth });
      if (!collapsed.has(nodeId)) {
        node.childIds.forEach(function (cid) { walk(cid, depth + 1); });
      }
    })(result.rootNodeId, 0);
    return rows;
  }

  // Stable colour per node: hash the (stable) id to a hue, so it stays constant
  // when the node is reparented, collapsed, or its siblings change — while
  // spanning the full spectrum so distinct nodes get distinct tones.
  function colorForId(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return "hsl(" + (h % 360) + ", 68%, 45%)";
  }
  function assignColors(result) {
    var color = {};
    Object.keys(result.tree.nodes).forEach(function (id) {
      color[id] = id === result.rootNodeId ? ROOT_COLOR : colorForId(id);
    });
    return color;
  }

  // ---- render --------------------------------------------------------------
  function rerender() {
    if (!lastResult) return;
    var result = lastResult;
    var tree = els.tree;
    tree.textContent = "";

    var root = result.tree.nodes[result.rootNodeId];
    var hasAnything = root && (root.childIds.length > 0 || root.messageUuids.length > 0);
    els.empty.style.display = hasAnything ? "none" : "block";
    if (!root) return;

    var rows = flatten(result);
    var colors = assignColors(result);
    lastColors = colors; // expose for message highlighting
    var rowIndex = {};
    rows.forEach(function (item, i) { rowIndex[item.nodeId] = i; });

    // The "you are here" pointer — where the next un-marked message lands. Fall
    // back to root if that node was deleted via the UI.
    var pointerId = result.pointerNodeId;
    if (!pointerId || !result.tree.nodes[pointerId]) pointerId = result.rootNodeId;

    var maxDepth = rows.reduce(function (m, r) { return Math.max(m, r.depth); }, 0);
    var W = dotX(maxDepth) + LANE_W;
    var H = rows.length * ROW_H;

    var graph = document.createElement("div");
    graph.className = "ctv-graph";
    graph.style.height = H + "px";

    // SVG layer (behind rows): rails + branch connectors.
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "ctv-graph-svg");
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    svg.style.width = W + "px";
    svg.style.height = H + "px";

    // Each connector is two strokes so the colour changes AT the branch point:
    // a vertical rail in the PARENT's colour, then a peel-off curve in the
    // CHILD's colour into the child dot.
    function stroke(d, color) {
      var p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", color);
      p.setAttribute("stroke-width", "2");
      p.setAttribute("stroke-linecap", "round");
      svg.appendChild(p);
    }

    rows.forEach(function (item, idx) {
      var node = result.tree.nodes[item.nodeId];
      if (collapsed.has(item.nodeId)) return;
      var parentColor = colors[item.nodeId] || ROOT_COLOR;
      (node.childIds || []).forEach(function (cid) {
        var cr = rowIndex[cid];
        if (cr == null) return;
        var x1 = dotX(item.depth), y1 = idx * ROW_H + ROW_H / 2;
        var x2 = dotX(item.depth + 1), y2 = cr * ROW_H + ROW_H / 2;
        var bend = Math.min(LANE_W, y2 - y1);
        stroke("M " + x1 + " " + y1 + " V " + (y2 - bend), parentColor);
        stroke("M " + x1 + " " + (y2 - bend) + " Q " + x1 + " " + y2 + " " + x2 + " " + y2,
          colors[cid] || ROOT_COLOR);
      });
    });
    graph.appendChild(svg);

    // HTML rows (on top): dot + label + count, interactive.
    rows.forEach(function (item, idx) {
      var node = result.tree.nodes[item.nodeId];
      var col = colors[item.nodeId] || ROOT_COLOR;
      var hasKids = node.childIds && node.childIds.length > 0;
      var isColl = collapsed.has(item.nodeId);

      var isRoot = item.nodeId === result.rootNodeId;

      var row = document.createElement("div");
      row.className = "ctv-row";
      row.dataset.nodeId = item.nodeId;
      row.style.height = ROW_H + "px";
      if (item.nodeId === activeNodeId) row.classList.add("ctv-row-active");

      // Drag to reparent: any row can be a drop target; root can't be dragged.
      if (!isRoot) {
        row.draggable = true;
        row.addEventListener("dragstart", function (e) {
          dragNodeId = item.nodeId;
          row.classList.add("ctv-row-dragging");
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", item.nodeId);
          }
        });
        row.addEventListener("dragend", function () {
          dragNodeId = null;
          row.classList.remove("ctv-row-dragging");
          clearDropTargets();
        });
      }
      row.addEventListener("dragover", function (e) {
        if (!isValidDrop(dragNodeId, item.nodeId)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        row.classList.add("ctv-row-drop");
      });
      row.addEventListener("dragleave", function () {
        row.classList.remove("ctv-row-drop");
      });
      row.addEventListener("drop", function (e) {
        e.preventDefault();
        row.classList.remove("ctv-row-drop");
        if (isValidDrop(dragNodeId, item.nodeId) && typeof handlers.onReparent === "function") {
          handlers.onReparent(dragNodeId, item.nodeId);
        }
        dragNodeId = null;
      });

      var dot = document.createElement("span");
      dot.className = "ctv-dot";
      dot.style.left = (dotX(item.depth) - DOT_R) + "px";
      dot.style.background = col; // always filled
      dot.style.borderColor = col;
      if (item.nodeId === pointerId) {
        // "You are here": outer ring in the node's colour.
        dot.classList.add("ctv-dot-current");
        dot.style.boxShadow = "0 0 0 2px #fff, 0 0 0 4px " + col;
        dot.title = "Current — new messages land here";
      }
      row.appendChild(dot);

      var labelWrap = document.createElement("div");
      labelWrap.className = "ctv-row-label";
      labelWrap.style.marginLeft = textX(item.depth) + "px";

      // Leading slot: a chevron for parents, an equal-width spacer for leaves
      // (so titles line up). Chevron sits snug to the dot (see textX).
      if (hasKids) {
        var tw = document.createElement("span");
        tw.className = "ctv-twisty";
        tw.textContent = isColl ? "▶" : "▼";
        tw.title = isColl ? "Expand" : "Collapse";
        tw.addEventListener("click", function (e) {
          e.stopPropagation();
          toggleCollapse(item.nodeId);
        });
        labelWrap.appendChild(tw);
      } else {
        var sp = document.createElement("span");
        sp.className = "ctv-twisty ctv-twisty-spacer";
        labelWrap.appendChild(sp);
      }

      var label = document.createElement("span");
      label.className = "ctv-node-title";
      label.textContent = node.title;
      label.title = "Double-click to rename";
      if (node.titleSource === "fallback") label.classList.add("ctv-node-fallback");
      if (item.nodeId === pointerId) label.classList.add("ctv-node-current");
      label.addEventListener("dblclick", function (e) {
        e.stopPropagation();
        startRename(row, labelWrap, label, item.nodeId, node.title);
      });
      labelWrap.appendChild(label);

      var n = node.messageUuids ? node.messageUuids.length : 0;
      if (n) {
        var count = document.createElement("span");
        count.className = "ctv-node-count";
        count.textContent = String(n);
        labelWrap.appendChild(count);
      }

      if (!isRoot) {
        var del = document.createElement("button");
        del.className = "ctv-row-del";
        del.type = "button";
        del.title = "Delete topic — its messages and sub-topics move up to the parent topic";
        del.textContent = "🗑";
        del.addEventListener("click", function (e) {
          e.stopPropagation();
          if (typeof handlers.onDelete === "function" &&
              window.confirm("Delete topic “" + node.title + "”?\n\nIts messages and any sub-topics move up to the parent topic.")) {
            handlers.onDelete(item.nodeId);
          }
        });
        labelWrap.appendChild(del);
      }

      labelWrap.addEventListener("click", function () {
        setActiveNode(item.nodeId);
        if (typeof handlers.onNodeSelect === "function") handlers.onNodeSelect(item.nodeId);
      });

      row.appendChild(labelWrap);
      graph.appendChild(row);
    });

    tree.appendChild(graph);
  }

  function render(result, opts) {
    buildChrome();
    handlers = opts || {};
    lastResult = result;
    collapsed.forEach(function (id) { if (!result.tree.nodes[id]) collapsed.delete(id); });
    if (activeNodeId && !result.tree.nodes[activeNodeId]) activeNodeId = null;
    rerender();
  }

  // Mark a node active (message → node) and scroll its row into view.
  function setActiveNode(nodeId) {
    activeNodeId = nodeId;
    if (!els) return;
    var rows = els.tree.querySelectorAll(".ctv-row");
    Array.prototype.forEach.call(rows, function (r) {
      var on = r.dataset.nodeId === nodeId;
      r.classList.toggle("ctv-row-active", on);
      if (on) r.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  function getNodeColor(nodeId) {
    return lastColors[nodeId] || ROOT_COLOR;
  }

  function getActiveNode() {
    return activeNodeId;
  }

  CTV.treePanel = {
    render: render,
    setActiveNode: setActiveNode,
    getNodeColor: getNodeColor,
    getActiveNode: getActiveNode,
    show: show,
    hide: hide
  };
})();
