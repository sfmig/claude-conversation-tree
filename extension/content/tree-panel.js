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

  // Per-branch colour palette (cycled in tree DFS order; root = first).
  var PALETTE = [
    "#0d9488", "#7c3aed", "#ea580c", "#2563eb",
    "#db2777", "#16a34a", "#ca8a04", "#dc2626"
  ];

  var els = null;            // { panel, fab, tree, empty }
  var lastResult = null;
  var handlers = {};
  var collapsed = new Set(); // UI-only collapse state (node ids)
  var activeNodeId = null;
  var lastColors = {};       // nodeId → palette colour (from last render)

  function dotX(depth) { return LANE_PAD + depth * LANE_W; }
  function textX(depth) { return dotX(depth) + DOT_R + 6; }

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

    var close = document.createElement("button");
    close.className = "ctv-btn ctv-panel-close";
    close.type = "button";
    close.title = "Collapse panel";
    close.textContent = "×";
    close.addEventListener("click", hide);

    header.appendChild(title);
    header.appendChild(close);

    var empty = document.createElement("div");
    empty.className = "ctv-empty";
    empty.textContent = "No topics yet. Use /child or /sibling in a message to branch.";

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
  }

  function hide() {
    if (!els) return;
    els.panel.classList.remove("ctv-open");
    els.fab.classList.remove("ctv-hidden");
  }

  function toggleCollapse(nodeId) {
    if (collapsed.has(nodeId)) collapsed.delete(nodeId);
    else collapsed.add(nodeId);
    rerender();
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

  // Stable colour per node: DFS order over the FULL tree, so colours don't
  // shift when subtrees collapse.
  function assignColors(result) {
    var color = {};
    var i = 0;
    (function walk(id) {
      var n = result.tree.nodes[id];
      if (!n) return;
      color[id] = PALETTE[i++ % PALETTE.length];
      n.childIds.forEach(walk);
    })(result.rootNodeId);
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

    // Each connector blends from the parent's colour (top) to the child's
    // colour (bottom), so a branch's colour flows as it descends.
    var defs = document.createElementNS(SVG_NS, "defs");
    svg.appendChild(defs);
    var gradId = 0;

    rows.forEach(function (item, idx) {
      var node = result.tree.nodes[item.nodeId];
      if (collapsed.has(item.nodeId)) return;
      (node.childIds || []).forEach(function (cid) {
        var cr = rowIndex[cid];
        if (cr == null) return;
        var x1 = dotX(item.depth), y1 = idx * ROW_H + ROW_H / 2;
        var x2 = dotX(item.depth + 1), y2 = cr * ROW_H + ROW_H / 2;
        var bend = Math.min(LANE_W, y2 - y1);
        // down the parent lane, then a quarter-curve into the child lane.
        var d = "M " + x1 + " " + y1 + " V " + (y2 - bend) + " Q " + x1 + " " + y2 + " " + x2 + " " + y2;

        var gid = "ctv-grad-" + (gradId++);
        var grad = document.createElementNS(SVG_NS, "linearGradient");
        grad.setAttribute("id", gid);
        grad.setAttribute("gradientUnits", "userSpaceOnUse");
        grad.setAttribute("x1", x1);
        grad.setAttribute("y1", y1);
        grad.setAttribute("x2", x2);
        grad.setAttribute("y2", y2);
        var s0 = document.createElementNS(SVG_NS, "stop");
        s0.setAttribute("offset", "0");
        s0.setAttribute("stop-color", colors[item.nodeId] || PALETTE[0]);
        var s1 = document.createElementNS(SVG_NS, "stop");
        s1.setAttribute("offset", "1");
        s1.setAttribute("stop-color", colors[cid] || PALETTE[0]);
        grad.appendChild(s0);
        grad.appendChild(s1);
        defs.appendChild(grad);

        var p = document.createElementNS(SVG_NS, "path");
        p.setAttribute("d", d);
        p.setAttribute("fill", "none");
        p.setAttribute("stroke", "url(#" + gid + ")");
        p.setAttribute("stroke-width", "2");
        p.setAttribute("stroke-linecap", "round");
        svg.appendChild(p);
      });
    });
    graph.appendChild(svg);

    // HTML rows (on top): dot + label + count, interactive.
    rows.forEach(function (item, idx) {
      var node = result.tree.nodes[item.nodeId];
      var col = colors[item.nodeId] || PALETTE[0];
      var hasKids = node.childIds && node.childIds.length > 0;
      var isColl = collapsed.has(item.nodeId);

      var row = document.createElement("div");
      row.className = "ctv-row";
      row.dataset.nodeId = item.nodeId;
      row.style.height = ROW_H + "px";
      if (item.nodeId === activeNodeId) row.classList.add("ctv-row-active");

      var dot = document.createElement("span");
      dot.className = "ctv-dot";
      dot.style.left = (dotX(item.depth) - DOT_R) + "px";
      if (hasKids && isColl) {
        dot.style.background = "#fff";
        dot.style.borderColor = col;
        dot.classList.add("ctv-dot-hollow");
      } else {
        dot.style.background = col;
        dot.style.borderColor = col;
      }
      row.appendChild(dot);

      var labelWrap = document.createElement("div");
      labelWrap.className = "ctv-row-label";
      labelWrap.style.marginLeft = textX(item.depth) + "px";

      if (hasKids) {
        var tw = document.createElement("span");
        tw.className = "ctv-twisty";
        tw.textContent = isColl ? "▸" : "▾";
        tw.title = isColl ? "Expand" : "Collapse";
        tw.addEventListener("click", function (e) {
          e.stopPropagation();
          toggleCollapse(item.nodeId);
        });
        labelWrap.appendChild(tw);
      }

      var label = document.createElement("span");
      label.className = "ctv-node-title";
      label.textContent = node.title;
      if (node.titleSource === "fallback") label.classList.add("ctv-node-fallback");
      labelWrap.appendChild(label);

      var n = node.messageUuids ? node.messageUuids.length : 0;
      if (n) {
        var count = document.createElement("span");
        count.className = "ctv-node-count";
        count.textContent = String(n);
        labelWrap.appendChild(count);
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
    return lastColors[nodeId] || PALETTE[0];
  }

  CTV.treePanel = {
    render: render,
    setActiveNode: setActiveNode,
    getNodeColor: getNodeColor,
    show: show,
    hide: hide
  };
})();
