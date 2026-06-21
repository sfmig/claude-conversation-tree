/*
 * highlighting.js  —  bidirectional node ↔ message highlighting.
 *
 *   node → messages : highlightNodeMessages(nodeId) highlights the node's
 *       messages and scrolls the first into view. Because claude.ai virtualizes
 *       off-screen turns, highlights are STICKY (re-applied as messages render
 *       during scroll, via dom-mapper's onRecorrelate) and the initial scroll
 *       HUNTS for a target that isn't currently rendered.
 *   message → node : a delegated click maps the clicked message's
 *       [data-ctv-uuid] to a node and activates it in the tree panel.
 *
 * We never preventDefault / stopPropagation on page clicks, so Claude's own UI
 * keeps working — we only add highlight classes.
 */
(function () {
  "use strict";

  var CTV = (window.CTV = window.CTV || {});
  var TAG = "[CTV hl]";
  var MSG_CLASS = "ctv-msg-highlight";

  var result = null;        // current parse result
  var activeNodeId = null;  // node whose messages are currently highlighted
  var activeColor = null;
  var listenerInstalled = false;
  var minimapEl = null;     // right-edge tick strip for the active node
  var stickySuspendedUntil = 0; // sticky repaint paused while an edit's re-parse is in flight

  // The re-parse outcome always lands here (directly or via
  // highlightNodeMessages), so reaching it also ends any edit suspension.
  function clearMessageHighlights() {
    activeNodeId = null; // stop sticky re-apply
    stickySuspendedUntil = 0;
    removeMinimap();
    var hl = document.querySelectorAll("." + MSG_CLASS);
    Array.prototype.forEach.call(hl, function (el) {
      el.classList.remove(MSG_CLASS);
      el.style.removeProperty("--ctv-hl-color");
    });
  }

  // The mapped element is the full-width turn wrapper. For user turns that's far
  // wider than the right-aligned bubble, so highlight the bubble itself when
  // present; assistant turns span the column, so the wrapper is fine.
  function highlightTarget(el) {
    return el.querySelector('[data-user-message-bubble], [data-testid="user-message"]') || el;
  }

  // Apply the active node's highlight to whatever of its messages are currently
  // mapped (rendered). Safe to call repeatedly — idempotent per element.
  function applyHighlights() {
    if (!result || !activeNodeId) return;
    var node = result.tree.nodes[activeNodeId];
    if (!node) return;
    node.messageUuids.forEach(function (uuid) {
      var el = CTV.domMapper.getElement(uuid);
      if (!el) return;
      var target = highlightTarget(el);
      target.classList.add(MSG_CLASS);
      if (activeColor) target.style.setProperty("--ctv-hl-color", activeColor);
    });
  }

  // ---- scrolling to a (possibly virtualized) message ----------------------
  function scrollContainerFor(el) {
    var n = el && el.parentElement;
    while (n && n !== document.body) {
      var oy = getComputedStyle(n).overflowY;
      if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 20) return n;
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }
  function firstMappedElement(ordered) {
    for (var i = 0; i < ordered.length; i++) {
      var el = CTV.domMapper.getElement(ordered[i]);
      if (el) return el;
    }
    return null;
  }
  function mappedIndexRange(ordered) {
    var min = -1, max = -1;
    for (var i = 0; i < ordered.length; i++) {
      if (CTV.domMapper.getElement(ordered[i])) { if (min < 0) min = i; max = i; }
    }
    return min < 0 ? null : { min: min, max: max };
  }

  var SCROLL_MARGIN = 24; // keep in sync with [data-ctv-uuid] scroll-margin-top
  function containerTop(c) {
    return (c === document.scrollingElement || c === document.documentElement || c === document.body)
      ? 0 : c.getBoundingClientRect().top;
  }
  // Scroll the target so its top sits SCROLL_MARGIN below the scrollport top, and
  // KEEP re-converging — Claude's virtualization shifts layout above the target
  // for a while after the scroll, so one shot misaligns. Re-measure + correct
  // until stable (or out of tries). This is what made the manual 2nd click work.
  function alignToTop(uuid, tries) {
    var el = CTV.domMapper.getElement(uuid);
    if (!el) return;
    var c = scrollContainerFor(el);
    var delta = (el.getBoundingClientRect().top - containerTop(c)) - SCROLL_MARGIN;
    if (Math.abs(delta) > 2) c.scrollTo({ top: c.scrollTop + delta, behavior: "smooth" });
    if (activeNodeId) { applyHighlights(); renderMinimap(activeNodeId); }
    if (tries <= 0) return;
    // Re-check after the smooth scroll has had time to finish; correct again if
    // Claude's virtualization shifted the layout. Stops once stable.
    setTimeout(function () {
      CTV.domMapper.recorrelate();
      var e2 = CTV.domMapper.getElement(uuid);
      if (!e2) return;
      var c2 = scrollContainerFor(e2);
      var d2 = (e2.getBoundingClientRect().top - containerTop(c2)) - SCROLL_MARGIN;
      if (Math.abs(d2) <= 3) { // settled
        if (activeNodeId) { applyHighlights(); renderMinimap(activeNodeId); }
        return;
      }
      alignToTop(uuid, tries - 1);
    }, 400);
  }

  // Page the conversation toward a target message that isn't rendered yet, then
  // re-correlate and retry. Once it's mapped, align it to the top (converging).
  function huntToMessage(targetUuid, tries) {
    var el = CTV.domMapper.getElement(targetUuid);
    if (el) {
      applyHighlights();
      alignToTop(targetUuid, 8);
      return;
    }
    if (tries <= 0) {
      console.debug(TAG, "could not bring message into view (virtualized):", targetUuid);
      return;
    }
    var ordered = CTV.domMapper.getOrderedUuids();
    var ti = ordered.indexOf(targetUuid);
    var anchor = firstMappedElement(ordered);
    if (ti < 0 || !anchor) return;
    var container = scrollContainerFor(anchor);
    var range = mappedIndexRange(ordered);
    var page = Math.max(container.clientHeight * 0.8, 200);
    if (range && ti < range.min) container.scrollTop -= page;      // target above
    else container.scrollTop += page;                              // below / gap
    setTimeout(function () {
      CTV.domMapper.recorrelate();
      huntToMessage(targetUuid, tries - 1);
    }, 320);
  }

  // ---- minimap: ticks on the right edge for the active node's messages ----
  function removeMinimap() {
    if (minimapEl && minimapEl.parentNode) minimapEl.parentNode.removeChild(minimapEl);
    minimapEl = null;
  }
  function renderMinimap(nodeId) {
    removeMinimap();
    if (!result) return;
    var node = result.tree.nodes[nodeId];
    if (!node || !node.messageUuids.length) return;
    var ordered = CTV.domMapper.getOrderedUuids();
    if (!ordered.length) return;
    var anchor = firstMappedElement(ordered);
    if (!anchor) return; // nothing rendered to anchor the conversation rect
    var container = scrollContainerFor(anchor);
    var rect = container.getBoundingClientRect();
    var denom = container.scrollHeight - container.clientHeight; // scrollbar range

    var indexOf = {};
    ordered.forEach(function (u, i) { indexOf[u] = i; });
    var span = Math.max(ordered.length - 1, 1);

    var strip = document.createElement("div");
    strip.className = "ctv-minimap";
    strip.style.top = rect.top + "px";
    strip.style.height = rect.height + "px";

    node.messageUuids.forEach(function (uuid) {
      // Position by the message's SCROLL fraction so the tick lines up with the
      // native scrollbar thumb. Use the real content offset for rendered
      // messages; fall back to index for virtualized ones (refined on scroll).
      var frac;
      var el = CTV.domMapper.getElement(uuid);
      if (el && denom > 0) {
        var contentTop = el.getBoundingClientRect().top - rect.top + container.scrollTop;
        frac = Math.max(0, Math.min(1, contentTop / denom));
      } else {
        var i = indexOf[uuid];
        if (i == null) return;
        frac = i / span;
      }
      var tick = document.createElement("div");
      tick.className = "ctv-minimap-tick";
      tick.style.top = (frac * 100) + "%";
      if (activeColor) tick.style.background = activeColor;
      tick.title = "Jump to this message";
      tick.addEventListener("click", function (e) {
        e.stopPropagation();
        huntToMessage(uuid, 6);
      });
      strip.appendChild(tick);
    });
    document.body.appendChild(strip);
    minimapEl = strip;
  }

  // noScroll = re-apply highlight + minimap without moving the conversation
  // (used when restoring the selection on panel reopen).
  function highlightNodeMessages(nodeId, noScroll) {
    if (!result) return;
    var node = result.tree.nodes[nodeId];
    if (!node) return;

    clearMessageHighlights();
    activeNodeId = nodeId;
    activeColor = (CTV.treePanel && CTV.treePanel.getNodeColor)
      ? CTV.treePanel.getNodeColor(nodeId)
      : null;
    applyHighlights();
    renderMinimap(nodeId);
    if (noScroll) return;

    var firstUuid = node.messageUuids[0];
    if (!firstUuid) return;
    // Route both rendered and virtualized through huntToMessage: if it's mapped
    // it aligns (with convergence) immediately; if not, it pages to it first.
    huntToMessage(firstUuid, 6);
  }

  // message → node, via event delegation on the document.
  function onDocumentClick(e) {
    if (!result) return;
    var target = e.target;
    if (!target || !target.closest) return;
    if (target.closest(".ctv-panel")) return; // ignore clicks in our own panel

    var el = target.closest("[data-ctv-uuid]");
    if (!el) return;
    var uuid = el.getAttribute("data-ctv-uuid");
    var nodeId = result.tree.messageIndex[uuid];
    if (nodeId && CTV.treePanel) {
      CTV.treePanel.setActiveNode(nodeId);
    }
  }

  function init() {
    if (listenerInstalled) return;
    document.addEventListener("click", onDocumentClick, true);
    // Sticky highlights: re-apply the active node's highlight as messages render
    // in during scroll (handles virtualization).
    if (CTV.domMapper && CTV.domMapper.onRecorrelate) {
      CTV.domMapper.onRecorrelate(function () {
        if (!activeNodeId) return;
        // An in-place edit re-renders the turn immediately, but the re-parse
        // only lands after the refetch debounce — repainting here would flash
        // the OLD node's color on the edited message. Skip until the re-parse
        // re-issues the highlight (which resets the suspension).
        if (Date.now() < stickySuspendedUntil) return;
        applyHighlights();
        renderMinimap(activeNodeId); // refine tick positions as messages render
      });
    }
    // Reposition the minimap strip on resize while a node is active.
    var rt;
    window.addEventListener("resize", function () {
      if (!activeNodeId) return;
      clearTimeout(rt);
      rt = setTimeout(function () { if (activeNodeId) renderMinimap(activeNodeId); }, 150);
    });
    listenerInstalled = true;
  }

  function update(parseResult) {
    result = parseResult;
  }

  // A conversation write is in flight (edit / send / regenerate). Two things
  // until its re-parse lands:
  //   1. Pause the sticky repaint — recorrelation would otherwise repaint the
  //      re-rendered turn in the OLD node's color.
  //   2. Strip paint that is ALREADY on a changed turn — React can keep the
  //      painted element across an edit, so suppressing repaints alone leaves
  //      stale color behind. A turn changed iff its DOM text key no longer
  //      matches the message it was correlated under; only user turns are
  //      comparable (and only user messages can carry markers), so plain sends
  //      and untouched messages keep their paint — no blink on normal turns.
  // activeNodeId stays set: the re-parse reconcile repaints (and ends the
  // pause via clearMessageHighlights). Self-healing: if the re-parse never
  // lands, sticky resumes after the timeout and repaints the unchanged tree.
  function pauseForMutation(ms) {
    stickySuspendedUntil = Date.now() + (ms || 12000);
    if (!result || !activeNodeId) return;
    var node = result.tree.nodes[activeNodeId];
    if (!node) return;
    node.messageUuids.forEach(function (uuid) {
      var el = CTV.domMapper.getElement(uuid);
      if (!el || !CTV.domMapper.isUserTurn(el)) return;
      var key = CTV.domMapper.messageKey(uuid);
      if (key == null || CTV.domMapper.turnKey(el) === key) return;
      var target = highlightTarget(el);
      target.classList.remove(MSG_CLASS);
      target.style.removeProperty("--ctv-hl-color");
    });
  }

  CTV.highlighting = {
    init: init,
    update: update,
    highlightNodeMessages: highlightNodeMessages,
    clearMessageHighlights: clearMessageHighlights,
    pauseForMutation: pauseForMutation
  };
})();
