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
  var activeMessageUuid = null; // single message highlighted via message-click
  var messageColor = null;      // its node's colour
  var listenerInstalled = false;
  var minimapEl = null;     // right-edge tick strip for the active node
  var minimapFrac = {};     // uuid → last-known TRUE scroll fraction (once rendered)
  var stickySuspendedUntil = 0; // sticky repaint paused while an edit's re-parse is in flight

  // The re-parse outcome always lands here (directly or via
  // highlightNodeMessages), so reaching it also ends any edit suspension.
  function clearMessageHighlights() {
    activeNodeId = null; // stop sticky re-apply
    activeMessageUuid = null;
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

  // Single-message highlight (message-click): paint just the one clicked
  // message in its node's colour, if it's currently mapped. Sticky across
  // virtualization via the onRecorrelate handler. Idempotent per element.
  function applyMessageHighlight() {
    if (!activeMessageUuid) return;
    var el = CTV.domMapper.getElement(activeMessageUuid);
    if (!el) return;
    var target = highlightTarget(el);
    target.classList.add(MSG_CLASS);
    if (messageColor) target.style.setProperty("--ctv-hl-color", messageColor);
  }

  // message → paint that one message in its node's colour, and mark the node
  // active in the panel (without painting the whole section).
  function highlightMessage(uuid) {
    if (!result) return;
    var nodeId = result.tree.messageIndex[uuid];
    clearMessageHighlights(); // drop any section / previous single highlight
    activeMessageUuid = uuid;
    messageColor = (nodeId && CTV.treePanel && CTV.treePanel.getNodeColor)
      ? CTV.treePanel.getNodeColor(nodeId)
      : null;
    applyMessageHighlight();
    if (nodeId && CTV.treePanel) CTV.treePanel.setActiveNode(nodeId);
  }

  // The conversation scroll container, found via any currently-mapped message.
  function conversationContainer() {
    var anchor = firstMappedElement(CTV.domMapper.getOrderedUuids());
    return anchor ? scrollContainerFor(anchor) : null;
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
  // Scroll the target so its top sits SCROLL_MARGIN below the scrollport top.
  //
  // The hard part: Claude's virtualization keeps shifting layout above the
  // target for a while after we start scrolling, so the destination is a MOVING
  // target. Native scrollTo({behavior:"smooth"}) commits to a fixed scrollTop up
  // front, lands wrong, and then needs re-issued corrections that fight the
  // in-flight animation — the visible "bounce".
  //
  // Instead we run our own rAF loop that re-measures the target's LIVE position
  // every frame and eases a fraction of the remaining distance toward it. It
  // continuously re-targets, so it smoothly *follows* the moving element and
  // converges without overshoot — one continuous glide, no bounce. A short
  // delayed verify catches layout that shifts only after the glide ends (e.g. a
  // late virtualization pass); it re-glides smoothly rather than snapping.
  var alignGen = 0;          // bumped per call so a newer align cancels older loops
  function alignToTop(uuid, verifyTries) {
    var gen = ++alignGen;
    var startedAt = (window.performance && performance.now) ? performance.now() : Date.now();
    var userInterrupted = false;
    function onUserScroll() { userInterrupted = true; }
    // Real user input cancels the glide (vs. layout/anchor shifts, which don't).
    window.addEventListener("wheel", onUserScroll, { passive: true });
    window.addEventListener("touchstart", onUserScroll, { passive: true });
    function stop() {
      window.removeEventListener("wheel", onUserScroll, { passive: true });
      window.removeEventListener("touchstart", onUserScroll, { passive: true });
    }
    function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
    function frame() {
      if (gen !== alignGen || userInterrupted) { stop(); return; }
      var el = CTV.domMapper.getElement(uuid);
      if (!el) { stop(); scheduleVerify(); return; } // target virtualized out mid-glide
      var c = scrollContainerFor(el);
      var delta = (el.getBoundingClientRect().top - containerTop(c)) - SCROLL_MARGIN;
      if (Math.abs(delta) <= 2 || now() - startedAt > 1500) { stop(); scheduleVerify(); return; }
      var step = delta * 0.13;                // ease ~13% of the gap per frame
      if (Math.abs(step) < 1) step = delta;   // land the last couple px at once
      c.scrollTop += step;
      requestAnimationFrame(frame);
    }
    function scheduleVerify() {
      if (gen !== alignGen) return;
      if (activeNodeId) { applyHighlights(); renderMinimap(activeNodeId); }
      if (verifyTries <= 0 || userInterrupted) return;
      setTimeout(function () {
        if (gen !== alignGen || userInterrupted) return;
        CTV.domMapper.recorrelate();
        var el = CTV.domMapper.getElement(uuid);
        if (!el) return;
        var c = scrollContainerFor(el);
        var d = (el.getBoundingClientRect().top - containerTop(c)) - SCROLL_MARGIN;
        if (Math.abs(d) <= 3) { // stayed put — done
          if (activeNodeId) { applyHighlights(); renderMinimap(activeNodeId); }
          return;
        }
        alignToTop(uuid, verifyTries - 1); // layout drifted: glide to the new spot
      }, 400);
    }
    requestAnimationFrame(frame);
  }

  // Page the conversation toward a target message that isn't rendered yet, then
  // re-correlate and retry. Once it's mapped, align it to the top (converging).
  function huntToMessage(targetUuid, tries) {
    var el = CTV.domMapper.getElement(targetUuid);
    if (el) {
      applyHighlights();
      alignToTop(targetUuid, 3);
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

    function trueFrac(el) {
      var contentTop = el.getBoundingClientRect().top - rect.top + container.scrollTop;
      return Math.max(0, Math.min(1, contentTop / denom));
    }

    // Anchors = the true scroll fraction of every currently-rendered message,
    // ascending by index. Virtualized ticks interpolate between these so their
    // position is consistent with where they'll actually render (messages have
    // very uneven heights, so plain index spacing spreads them wrongly). We also
    // remember each rendered message's true fraction (minimapFrac) so a tick
    // that's been on screen once keeps its real position instead of drifting
    // back to an estimate as you scroll toward it again.
    var anchors = []; // [{ i, frac }]
    if (denom > 0) {
      ordered.forEach(function (u, i) {
        var el = CTV.domMapper.getElement(u);
        if (!el) return;
        var f = trueFrac(el);
        minimapFrac[u] = f;
        anchors.push({ i: i, frac: f });
      });
    }

    function fracForIndex(i) {
      if (!anchors.length) return i / span; // nothing rendered: even fallback
      var first = anchors[0];
      var last = anchors[anchors.length - 1];
      if (i <= first.i) {
        return first.i > 0 ? Math.max(0, Math.min(1, first.frac * i / first.i)) : first.frac;
      }
      if (i >= last.i) {
        if (span <= last.i) return last.frac;
        return Math.max(0, Math.min(1, last.frac + (1 - last.frac) * (i - last.i) / (span - last.i)));
      }
      var lo = first, hi = last;
      for (var k = 0; k < anchors.length; k++) {
        if (anchors[k].i === i) return anchors[k].frac;
        if (anchors[k].i < i) lo = anchors[k];
        if (anchors[k].i > i) { hi = anchors[k]; break; }
      }
      return Math.max(0, Math.min(1,
        lo.frac + (hi.frac - lo.frac) * (i - lo.i) / (hi.i - lo.i)));
    }

    var strip = document.createElement("div");
    strip.className = "ctv-minimap";
    strip.style.top = rect.top + "px";
    strip.style.height = rect.height + "px";

    node.messageUuids.forEach(function (uuid) {
      // Position by the message's SCROLL fraction so the tick lines up with the
      // native scrollbar thumb. Use the real content offset for rendered
      // messages; interpolate between rendered neighbours for virtualized ones
      // (refined as more messages render in on scroll).
      var frac;
      var el = CTV.domMapper.getElement(uuid);
      if (el && denom > 0) {
        frac = trueFrac(el);
      } else if (minimapFrac[uuid] != null) {
        frac = minimapFrac[uuid]; // pinned to where it really rendered before
      } else {
        var i = indexOf[uuid];
        if (i == null) return;
        frac = fracForIndex(i);
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

    // Keep the cache scoped to the current active branch: drop uuids from other
    // conversations or vanished after an edit (so it can't grow without bound).
    var live = {};
    ordered.forEach(function (u) { if (minimapFrac[u] != null) live[u] = minimapFrac[u]; });
    minimapFrac = live;
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
    if (el) {
      highlightMessage(el.getAttribute("data-ctv-uuid"));
      return;
    }
    // Click inside the conversation but outside any message → clear the
    // selection (highlights + minimap) and deselect the TOC row. Scoped to the
    // conversation scroll container so clicks elsewhere (composer, sidebar)
    // leave the selection alone.
    var container = conversationContainer();
    if (container && container.contains(target)) {
      clearMessageHighlights();
      if (CTV.treePanel && CTV.treePanel.setActiveNode) CTV.treePanel.setActiveNode(null);
    }
  }

  function init() {
    if (listenerInstalled) return;
    document.addEventListener("click", onDocumentClick, true);
    // Sticky highlights: re-apply the active node's highlight as messages render
    // in during scroll (handles virtualization).
    if (CTV.domMapper && CTV.domMapper.onRecorrelate) {
      CTV.domMapper.onRecorrelate(function () {
        if (!activeNodeId && !activeMessageUuid) return;
        // An in-place edit re-renders the turn immediately, but the re-parse
        // only lands after the refetch debounce — repainting here would flash
        // the OLD node's color on the edited message. Skip until the re-parse
        // re-issues the highlight (which resets the suspension).
        if (Date.now() < stickySuspendedUntil) return;
        if (activeNodeId) {
          applyHighlights();
          renderMinimap(activeNodeId); // refine tick positions as messages render
        }
        if (activeMessageUuid) applyMessageHighlight();
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
