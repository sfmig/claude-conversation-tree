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
  var ALLOWED_COMMANDS = ["node", "child", "sibling", "up", "star", "bookmark"];
  var PATH_SEP = ">"; // breadcrumb separator: /node Auth > Tokens
  // A line may have an optional leading /up [N] pointer-move, then one "name"
  // marker (or content). /up's arg is a bounded integer, so it can be peeled off
  // the front unambiguously — that's what enables `/up 2 /child TOPIC` on one
  // line. The lookahead stops it eating /update or /up2.
  var UP_RE = /^\/up(?:\s+(\d+))?(?=$|\s|\/)/;
  // The trailing "name" marker (note: `up` is intentionally absent — it's a
  // prefix/standalone only, so `/up /up …` degrades to text, never double-moves).
  var NAME_RE = /^\/(node|child|sibling|star|bookmark)(?:\s+(.*))?$/;
  // The first command token on a line, at line start OR preceded by whitespace.
  // Text before it is content; from the token to EOL is the "marker part". The
  // whitespace requirement keeps paths/URLs safe (e.g. a/b/node is not a marker).
  var CMD_AT = /(^|\s)\/(node|child|sibling|up|star|bookmark)\b/;

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

  // Named nodes are addressed by their name-path: id = hash(conversationId +
  // parentId + normalizedName). Re-using the same /child or /sibling name under
  // the same parent yields the SAME id, so the node is re-entered (messages can
  // be added later) rather than duplicated. (Names are matched case-insensitively
  // and trimmed.)
  function namedNodeId(conversationId, parentId, normalizedName) {
    return "node_" + cyrb53(
      String(conversationId) + "|" + String(parentId) + "|" + normalizedName
    ).toString(16);
  }

  // Unnamed topics can't be addressed by name, so each occurrence is a distinct
  // node keyed by the marker's message + line.
  function unnamedNodeId(conversationId, markerMessageUuid, markerLineIndex) {
    return "node_" + cyrb53(
      String(conversationId) + "|" + String(markerMessageUuid) + "|" + String(markerLineIndex)
    ).toString(16);
  }

  function normalizeName(name) {
    return name.trim().toLowerCase();
  }

  // Stable bookmark id: one bookmark per (conversation, target message).
  function generateBookmarkId(conversationId, messageUuid) {
    return "bm_" + cyrb53(String(conversationId) + "|" + String(messageUuid)).toString(16);
  }

  // Split a (user) message into recognised markers + the remaining content.
  // A marker may be at the START of a line (its own line) or at the END after the
  // message: the first command token (line-start or whitespace-preceded) marks the
  // boundary — text before it is content, the token→EOL is the "marker part".
  // The marker part is `[ /up [N] ] [ one name marker ]`.
  // Returns { markers: [{command, arg, lineIndex}], contentText, hasContent }.
  function extractMarkers(text) {
    var lines = String(text == null ? "" : text).split(/\r?\n/);
    var markers = [];
    var contentLines = [];

    function pushContent(s) {
      if (s !== "") contentLines.push(s);
    }

    lines.forEach(function (line, idx) {
      var at = CMD_AT.exec(line);
      if (!at) {
        pushContent(line);
        return;
      }

      // Split: content before the command token, marker part from the token on.
      var boundary = at.index + at[1].length; // index of the "/"
      pushContent(line.slice(0, boundary).replace(/\s+$/, ""));
      var work = line.slice(boundary);

      // Optional /up [N] move-prefix (a single move; chaining is unsupported).
      var um = UP_RE.exec(work);
      if (um) {
        markers.push({ command: "up", arg: um[1] || "", lineIndex: idx });
        work = work.slice(um[0].length).replace(/^\s+/, "");
        if (!work) return; // marker part was just "/up [N]"
      }

      var m = NAME_RE.exec(work);
      if (m) {
        markers.push({ command: m[1], arg: (m[2] || "").trim(), lineIndex: idx });
      } else {
        pushContent(work); // leftover after /up that isn't a marker
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
    // User overrides (rename/reparent/delete) make markers resolve against the
    // tree the user currently sees. Optional; defaults to none.
    var overrides = input.overrides || {};
    var nodeOv = overrides.nodeOverrides || {};

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

    function createNode(id, title, titleSource, parentId) {
      nodes[id] = {
        id: id,
        title: title,
        titleSource: titleSource,
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

    // ---- override-aware resolution -----------------------------------------
    // A node's CURRENT title/parent reflects the user's UI edits (overrides), so
    // markers resolve against the tree the user actually sees.
    function effectiveTitle(id) {
      var ov = nodeOv[id];
      return (ov && typeof ov.title === "string" && ov.title) ? ov.title : (nodes[id] ? nodes[id].title : "");
    }
    function isDeleted(id) {
      return !!(nodeOv[id] && nodeOv[id].deleted);
    }
    function effectiveParent(id) {
      var ov = nodeOv[id];
      if (ov && typeof ov.parentId === "string" && nodes[ov.parentId] && !isDeleted(ov.parentId)) {
        return ov.parentId;
      }
      return (nodes[id] && nodes[id].parentId) || ROOT_ID;
    }
    // Existing children of `parentId` in the EFFECTIVE (post-override) tree.
    function effectiveChildren(parentId) {
      var out = [];
      Object.keys(nodes).forEach(function (id) {
        if (id === ROOT_ID || isDeleted(id)) return;
        if (effectiveParent(id) === parentId) out.push(id);
      });
      return out;
    }

    // Re-enter the named child of `parentId` if it already exists, otherwise
    // create it. Unnamed topics are always new and unique.
    function resolveOrCreate(rawTitle, parentId, markerMsgUuid, lineIndex) {
      var name = (rawTitle || "").trim();
      if (name) {
        // 1. Effective-name lookup: a current child titled like `name`.
        var norm = normalizeName(name);
        var kids = effectiveChildren(parentId);
        for (var i = 0; i < kids.length; i++) {
          if (normalizeName(effectiveTitle(kids[i])) === norm) return kids[i];
        }
        // 2. Hash fallback: re-enter by original name, else create.
        var id = namedNodeId(conversationId, parentId, norm);
        if (nodes[id]) return id;
        return createNode(id, name, "marker", parentId);
      }
      var uid = unnamedNodeId(conversationId, markerMsgUuid, lineIndex);
      return createNode(uid, "Untitled topic", "fallback", parentId);
    }

    // Split a breadcrumb path ("Auth > Tokens > Refresh") into trimmed segments.
    function splitPath(rawArg) {
      return String(rawArg || "").split(PATH_SEP)
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s.length; });
    }

    // Walk named segments from `baseParentId`, re-entering or creating each;
    // return the deepest node id.
    function walkPath(segments, baseParentId, message, lineIndex) {
      var parentId = baseParentId;
      var id = baseParentId;
      segments.forEach(function (seg) {
        id = resolveOrCreate(seg, parentId, message.uuid, lineIndex);
        parentId = id;
      });
      return id;
    }

    // Relative descent from `baseParentId`. Empty arg → a single unnamed topic.
    function applyRelative(rawArg, baseParentId, message, lineIndex) {
      var segments = splitPath(rawArg);
      if (!segments.length) {
        return resolveOrCreate("", baseParentId, message.uuid, lineIndex); // unnamed
      }
      return walkPath(segments, baseParentId, message, lineIndex);
    }

    function applyMarker(marker, message) {
      switch (marker.command) {
        case "node": {
          // Absolute path from root; empty path returns the pointer to root.
          var segs = splitPath(marker.arg);
          currentNodeId = segs.length
            ? walkPath(segs, ROOT_ID, message, marker.lineIndex)
            : ROOT_ID;
          break;
        }
        case "child":
          // Relative: descend from the current node.
          currentNodeId = applyRelative(marker.arg, currentNodeId, message, marker.lineIndex);
          break;
        case "sibling": {
          // Relative: descend from the current node's EFFECTIVE parent.
          var parentId = currentNodeId === ROOT_ID ? ROOT_ID : effectiveParent(currentNodeId);
          currentNodeId = applyRelative(marker.arg, parentId, message, marker.lineIndex);
          break;
        }
        case "up": {
          // Pure pointer-move up N levels (default 1) along EFFECTIVE parents,
          // clamped at root — so /up follows UI drag-reparents.
          var n = parseInt(marker.arg, 10);
          if (!(n >= 1)) n = 1;
          for (var k = 0; k < n; k++) {
            if (currentNodeId === ROOT_ID) break;
            currentNodeId = effectiveParent(currentNodeId);
          }
          break;
        }
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

      // Attach every message to its current node so it's always findable
      // (clicking the node highlights it) — including a marker-only message like
      // `/node A > B`. Only *substantive* content advances `previousMessageUuid`,
      // so `/star` still targets the last real message, not a command-only one.
      nodes[currentNodeId].messageUuids.push(message.uuid);
      messageIndex[message.uuid] = currentNodeId;
      if (parsed.hasContent) previousMessageUuid = message.uuid;
    });

    return {
      rootNodeId: ROOT_ID,
      pointerNodeId: currentNodeId, // where the next un-marked message would land
      tree: { nodes: nodes, messageIndex: messageIndex },
      bookmarks: bookmarks
    };
  }

  return {
    ROOT_ID: ROOT_ID,
    ALLOWED_COMMANDS: ALLOWED_COMMANDS,
    cyrb53: cyrb53,
    namedNodeId: namedNodeId,
    unnamedNodeId: unnamedNodeId,
    generateBookmarkId: generateBookmarkId,
    extractMarkers: extractMarkers,
    parseConversation: parseConversation
  };
});
