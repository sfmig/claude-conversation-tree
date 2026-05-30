/*
 * highlighting.js  —  bidirectional node ↔ message highlighting (Phase 3).
 *
 *   node → messages : highlightNodeMessages(nodeId) looks up the node's
 *       messageUuids, finds their DOM elements via dom-mapper, highlights them,
 *       and scrolls the first into view.
 *   message → node  : a single delegated click listener finds the clicked
 *       message's [data-ctv-uuid], maps it to a node via messageIndex, and
 *       activates that node in the tree panel.
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
  var listenerInstalled = false;

  function clearMessageHighlights() {
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

  function highlightNodeMessages(nodeId) {
    if (!result) return;
    var node = result.tree.nodes[nodeId];
    if (!node) return;

    clearMessageHighlights();

    // Match the highlight ring/tint to the node's colour in the panel.
    var color = (CTV.treePanel && CTV.treePanel.getNodeColor)
      ? CTV.treePanel.getNodeColor(nodeId)
      : null;

    var first = null;
    node.messageUuids.forEach(function (uuid) {
      var el = CTV.domMapper.getElement(uuid);
      if (!el) return; // not rendered (virtualized / off-screen)
      var target = highlightTarget(el);
      target.classList.add(MSG_CLASS);
      if (color) target.style.setProperty("--ctv-hl-color", color);
      if (!first) first = el;
    });

    if (first) {
      first.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      console.debug(TAG, "no rendered DOM elements for node", nodeId,
        "(messages may be virtualized)");
    }
  }

  // message → node, via event delegation on the document.
  function onDocumentClick(e) {
    if (!result) return;
    var target = e.target;
    if (!target || !target.closest) return;
    // Ignore clicks inside our own panel.
    if (target.closest(".ctv-panel")) return;

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
    listenerInstalled = true;
  }

  function update(parseResult) {
    result = parseResult;
  }

  CTV.highlighting = {
    init: init,
    update: update,
    highlightNodeMessages: highlightNodeMessages,
    clearMessageHighlights: clearMessageHighlights
  };
})();
