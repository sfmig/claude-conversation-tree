/*
 * parser.js  —  the marker parser (Phase 2).
 *
 * PURE and DETERMINISTIC: plain functions that take an ordered message list and
 * return a fresh tree + parsed bookmarks. No DOM, no storage, no time, no
 * randomness — so it's trivially unit-testable in Node and idempotent (the same
 * input always yields byte-identical output, including node IDs).
 *
 * Confirmed input contract (see PHASE1-FINDINGS.md):
 *   message = { uuid, role: "human"|"assistant", text, index? }
 *   - markers are recognised in HUMAN messages only.
 *   - `text` is the assembled content (api-client concatenates content[] blocks).
 *
 * Loadable both in Node (module.exports) and as a content script (window.CTV).
 */
(function (factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") {
    window.CTV = window.CTV || {};
    window.CTV.parser = api;
  }
})(function () {
  "use strict";

  var ROOT_ID = "node_root";
  var ALLOWED_COMMANDS = ["sibling", "child", "parent", "root", "star", "bookmark"];
  // A marker occupies a whole line: a slash, a word command, optional argument.
  // Anchored to line start (no leading whitespace) per PLAN §5 / §13.
  var MARKER_RE = /^\/(\w+)(?:\s+(.*))?$/;

  function isUserRole(role) {
    return role === "human" || role === "user";
  }

  // cyrb53 — small, fast, dependency-free 53-bit string hash. Used only to
  // derive STABLE ids from message-level facts; not cryptographic.
  function cyrb53(str, seed) {
    var h1 = 0xdeadbeef ^ (seed || 0);
    var h2 = 0x41c6ce57 ^ (seed || 0);
    for (var i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  // Stable node id: derived from facts that survive re-parses (PLAN §4/§7).
  function generateNodeId(conversationId, markerMessageUuid, markerLineIndex) {
    return "node_" + cyrb53(
      String(conversationId) + "|" + String(markerMessageUuid) + "|" + String(markerLineIndex)
    ).toString(16);
  }

  // Stable bookmark id: one bookmark per (conversation, target message).
  function generateBookmarkId(conversationId, messageUuid) {
    return "bm_" + cyrb53(String(conversationId) + "|" + String(messageUuid)).toString(16);
  }

  // Split a (user) message into recognised markers + the remaining content.
  // Returns { markers: [{command, arg, lineIndex}], contentText, hasContent }.
  function extractMarkers(text) {
    var lines = String(text == null ? "" : text).split(/\r?\n/);
    var markers = [];
    var contentLines = [];
    lines.forEach(function (line, idx) {
      var m = MARKER_RE.exec(line);
      if (m && ALLOWED_COMMANDS.indexOf(m[1]) !== -1) {
        markers.push({ command: m[1], arg: (m[2] || "").trim(), lineIndex: idx });
      } else {
        contentLines.push(line);
      }
    });
    var contentText = contentLines.join("\n");
    return { markers: markers, contentText: contentText, hasContent: contentText.trim() !== "" };
  }

  function parseConversation(input) {
    input = input || {};
    var conversationId = input.conversationId;
    var conversationTitle = input.conversationTitle || "Conversation";
    var messages = input.messages || [];

    var nodes = {};
    nodes[ROOT_ID] = {
      id: ROOT_ID,
      title: conversationTitle,
      titleSource: "fallback",
      parentId: null,
      childIds: [],
      messageUuids: [],
      createdAt: null, // persistence layer stamps timestamps; parser stays pure
      collapsed: false
    };

    var messageIndex = {};
    var bookmarks = {};
    var currentNodeId = ROOT_ID;
    var previousMessageUuid = null;

    function makeNode(rawTitle, parentId, markerMsgUuid, lineIndex) {
      var id = generateNodeId(conversationId, markerMsgUuid, lineIndex);
      var hasTitle = rawTitle && rawTitle.trim() !== "";
      nodes[id] = {
        id: id,
        title: hasTitle ? rawTitle.trim() : "Untitled topic",
        titleSource: hasTitle ? "marker" : "fallback",
        parentId: parentId,
        childIds: [],
        messageUuids: [],
        createdAt: null,
        collapsed: false
      };
      if (nodes[parentId] && nodes[parentId].childIds.indexOf(id) === -1) {
        nodes[parentId].childIds.push(id);
      }
      return id;
    }

    function applyMarker(marker, message) {
      switch (marker.command) {
        case "child":
          currentNodeId = makeNode(marker.arg, currentNodeId, message.uuid, marker.lineIndex);
          break;
        case "sibling": {
          // Sibling = same parent as current. At root (no parent), the sensible
          // behaviour is a new top-level topic under root.
          var parentId = nodes[currentNodeId].parentId || ROOT_ID;
          currentNodeId = makeNode(marker.arg, parentId, message.uuid, marker.lineIndex);
          break;
        }
        case "parent":
          currentNodeId = nodes[currentNodeId].parentId || ROOT_ID; // no-op at root
          break;
        case "root":
          currentNodeId = ROOT_ID;
          break;
        case "star":
        case "bookmark":
          if (previousMessageUuid) {
            var bid = generateBookmarkId(conversationId, previousMessageUuid);
            bookmarks[bid] = {
              id: bid,
              messageUuid: previousMessageUuid,
              conversationId: conversationId,
              nodeId: messageIndex[previousMessageUuid] || null,
              note: marker.arg || "",
              tags: [],
              createdAt: null,
              source: "marker"
            };
          }
          // else: /star as first message → skip silently (PLAN §5)
          break;
        default:
          break; // unreachable: ALLOWED_COMMANDS gate in extractMarkers
      }
    }

    messages.forEach(function (message) {
      var parsed;
      if (isUserRole(message.role)) {
        parsed = extractMarkers(message.text);
      } else {
        var t = message.text == null ? "" : String(message.text);
        parsed = { markers: [], contentText: t, hasContent: t.trim() !== "" };
      }

      // Markers process first, in order; content then belongs to whatever node
      // is current afterwards (PLAN §6).
      parsed.markers.forEach(function (marker) { applyMarker(marker, message); });

      if (parsed.hasContent) {
        nodes[currentNodeId].messageUuids.push(message.uuid);
        messageIndex[message.uuid] = currentNodeId;
        previousMessageUuid = message.uuid;
      }
    });

    return {
      rootNodeId: ROOT_ID,
      tree: { nodes: nodes, messageIndex: messageIndex },
      bookmarks: bookmarks
    };
  }

  return {
    ROOT_ID: ROOT_ID,
    ALLOWED_COMMANDS: ALLOWED_COMMANDS,
    cyrb53: cyrb53,
    generateNodeId: generateNodeId,
    generateBookmarkId: generateBookmarkId,
    extractMarkers: extractMarkers,
    parseConversation: parseConversation
  };
});
