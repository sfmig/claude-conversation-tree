/*
 * merge.js  —  apply stored user overrides on top of a fresh parse (Phase 4).
 *
 * PURE and DETERMINISTIC (like parser.js): takes a parse result + an overrides
 * object and returns a new merged tree. User overrides always win over parser
 * output; overrides that reference nodes/messages no longer in the parsed tree
 * (because a marker was removed) are dropped silently (PLAN §7).
 *
 * Override shape:
 *   {
 *     nodeOverrides:    { [nodeId]: { title?, parentId?, deleted? } },
 *     messageOverrides: { [messageUuid]: { nodeId } }
 *   }
 *
 * Loadable both in Node (module.exports) and as a content script (window.CTV).
 */
(function (factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") {
    window.CTV = window.CTV || {};
    window.CTV.merge = api;
  }
})(function () {
  "use strict";

  function emptyOverrides() {
    return { nodeOverrides: {}, messageOverrides: {} };
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function applyOverrides(parsed, overrides) {
    overrides = overrides || {};
    var nodeOv = overrides.nodeOverrides || {};
    var msgOv = overrides.messageOverrides || {};
    var rootId = parsed.rootNodeId;
    var nodes = clone(parsed.tree.nodes);

    function removeChild(parentId, childId) {
      var p = nodes[parentId];
      if (!p) return;
      var i = p.childIds.indexOf(childId);
      if (i !== -1) p.childIds.splice(i, 1);
    }
    function addChild(parentId, childId) {
      var p = nodes[parentId];
      if (!p) return;
      if (p.childIds.indexOf(childId) === -1) p.childIds.push(childId);
    }
    // Is `maybeDescId` inside the subtree rooted at `ancestorId`?
    function isDescendant(ancestorId, maybeDescId) {
      var cur = nodes[maybeDescId];
      var guard = 0;
      while (cur && cur.parentId && guard++ < 100000) {
        if (cur.parentId === ancestorId) return true;
        cur = nodes[cur.parentId];
      }
      return false;
    }

    // 1. Renames.
    Object.keys(nodeOv).forEach(function (id) {
      var ov = nodeOv[id];
      var n = nodes[id];
      if (!n) return; // orphaned override → drop
      if (typeof ov.title === "string" && ov.title.length) {
        n.title = ov.title;
        n.titleSource = "user-edited";
      }
    });

    // 2. Reparents (skip cycles / invalid targets). Applied even to nodes that
    //    are also being deleted, so deletion promotes their children/messages to
    //    the *current* (reparented) parent rather than the original one.
    Object.keys(nodeOv).forEach(function (id) {
      var ov = nodeOv[id];
      var n = nodes[id];
      if (!n) return;
      if (typeof ov.parentId !== "string") return;
      if (id === rootId) return;             // never move root
      if (ov.parentId === id) return;        // no self-parent
      if (!nodes[ov.parentId]) return;       // orphaned target
      if (n.parentId === ov.parentId) return; // no-op
      if (isDescendant(id, ov.parentId)) return; // would create a cycle
      removeChild(n.parentId, id);
      addChild(ov.parentId, id);
      n.parentId = ov.parentId;
    });

    // 3. Deletions: remove node; promote its children + messages UP to the
    //    deleted node's parent (taking its place), falling back to root if that
    //    parent is gone too.
    Object.keys(nodeOv).forEach(function (id) {
      var ov = nodeOv[id];
      if (!ov.deleted) return;
      if (id === rootId) return; // never delete root
      var n = nodes[id];
      if (!n) return; // orphaned

      var parentId = (n.parentId && nodes[n.parentId]) ? n.parentId : rootId;
      var parent = nodes[parentId];
      var kids = n.childIds.slice().filter(function (cid) { return nodes[cid]; });
      kids.forEach(function (cid) { nodes[cid].parentId = parentId; });

      var pos = parent.childIds.indexOf(id);
      if (pos === -1) {
        kids.forEach(function (cid) { addChild(parentId, cid); });
      } else {
        // Replace the deleted node with its children, in place.
        Array.prototype.splice.apply(parent.childIds, [pos, 1].concat(kids));
      }
      removeChild(n.parentId, id); // no-op if the splice already removed it

      n.messageUuids.forEach(function (uuid) { parent.messageUuids.push(uuid); });
      delete nodes[id];
    });

    // 4. Rebuild messageIndex from the (now authoritative) messageUuids.
    var messageIndex = {};
    Object.keys(nodes).forEach(function (id) {
      nodes[id].messageUuids.forEach(function (uuid) { messageIndex[uuid] = id; });
    });

    // 5. Per-message reassignment (applied last; PLAN §7).
    Object.keys(msgOv).forEach(function (uuid) {
      var targetId = msgOv[uuid] && msgOv[uuid].nodeId;
      if (!targetId || !nodes[targetId]) return; // orphaned target
      var curId = messageIndex[uuid];
      if (!curId || curId === targetId) return;  // not present, or no-op
      var cur = nodes[curId];
      var i = cur.messageUuids.indexOf(uuid);
      if (i !== -1) cur.messageUuids.splice(i, 1);
      nodes[targetId].messageUuids.push(uuid);
      messageIndex[uuid] = targetId;
    });

    return {
      rootNodeId: rootId,
      tree: { nodes: nodes, messageIndex: messageIndex },
      bookmarks: parsed.bookmarks
    };
  }

  return {
    emptyOverrides: emptyOverrides,
    applyOverrides: applyOverrides
  };
});
