/*
 * api-normalize.js  —  the network-payload normaliser (pure functions).
 *
 * PURE and DETERMINISTIC: takes Claude's raw conversation payload and returns a
 * linear [{uuid, parentUuid, index, role, text}] list — the parser's input
 * contract. No DOM, no network, no storage — so it's unit-testable in Node and
 * shared by the content script via window.CTV.apiNormalize.
 *
 * This is the "network-payload adapter" seam called out in PLAN §13: all the
 * Claude-specific payload knowledge (field names, branch shape) lives here, kept
 * separate from the fetch/hook plumbing in api-client.js.
 *
 * Loadable both in Node (module.exports) and as a content script (window.CTV).
 */
(function (factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") {
    window.CTV = window.CTV || {};
    window.CTV.apiNormalize = api;
  }
})(function () {
  "use strict";

  // Extract a message's text. Claude's `rendering_mode=messages` payload puts
  // the prose in a `content` array of blocks ({type, text, ...}); the top-level
  // `text` field is often empty. Prefer whichever yields more text so we work
  // regardless of which field is populated.
  function extractText(m) {
    var parts = [];
    if (Array.isArray(m.content)) {
      m.content.forEach(function (b) {
        if (b && typeof b === "object" && typeof b.text === "string") parts.push(b.text);
      });
    }
    var fromBlocks = parts.join("\n");
    var top = typeof m.text === "string" ? m.text : "";
    return fromBlocks.length >= top.length ? fromBlocks : top;
  }

  // ---- active-branch selection ---------------------------------------------
  // Claude's payloads can contain EVERY branch (every edit + regeneration),
  // especially under ?tree=True (confirmed empirically). The branch the user
  // actually sees is the single chain ending at `current_leaf_message_uuid`.
  // Walking up `parent_message_uuid` from that leaf yields exactly the active
  // path (root→leaf) and drops superseded/off-branch messages — so an edited
  // message's LATEST version is what we parse, and marker→message attribution
  // can't be scrambled by off-branch messages.
  //
  // If there's no leaf pointer (lean payloads are already one flat path), fall
  // back to ordering by the API `index` (0-based, matches array order — see
  // PHASE1-FINDINGS R5).
  function selectActiveBranch(arr, leafUuid) {
    var byUuid = {};
    arr.forEach(function (m) { byUuid[m.uuid || m.id] = m; });

    if (leafUuid && byUuid[leafUuid]) {
      var path = [];
      var seen = {};
      var cur = leafUuid;
      // Stops at the first real message (whose parent is the root sentinel,
      // absent from byUuid); `seen` guards against any cyclic parent links.
      while (cur && byUuid[cur] && !seen[cur]) {
        seen[cur] = true;
        path.push(byUuid[cur]);
        cur = byUuid[cur].parent_message_uuid || byUuid[cur].parentMessageUuid || null;
      }
      path.reverse(); // root → leaf
      return path;
    }

    return arr.slice().sort(function (a, b) {
      var ai = typeof a.index === "number" ? a.index : 0;
      var bi = typeof b.index === "number" ? b.index : 0;
      return ai - bi;
    });
  }

  // ---- normalisation: turn the payload into a linear message list ----------
  // Reduce to the active branch in conversation order, then map to the parser's
  // input contract. `index` is re-stamped as the position in the active branch
  // so every downstream consumer (parser uses array order; dom-mapper sorts by
  // index) agrees on the same ordering.
  function normalize(body) {
    if (!body || typeof body !== "object") return null;

    var arr =
      body.chat_messages ||
      body.messages ||
      body.chatMessages ||
      null;
    if (!Array.isArray(arr)) return { ok: false, reason: "no recognised message array", topLevelKeys: Object.keys(body) };

    var leafUuid = body.current_leaf_message_uuid || body.currentLeafMessageUuid || null;
    var branch = selectActiveBranch(arr, leafUuid);

    var messages = branch.map(function (m, i) {
      var role = m.sender || m.role || m.author || null; // "human"/"assistant"?
      var text = extractText(m);
      return {
        uuid: m.uuid || m.id || null,
        parentUuid: m.parent_message_uuid || m.parentMessageUuid || null,
        index: i, // position within the ACTIVE branch (root→leaf)
        role: role,
        text: typeof text === "string" ? text : ""
      };
    });

    return {
      ok: true,
      arrayField: body.chat_messages ? "chat_messages" : body.messages ? "messages" : "chatMessages",
      count: messages.length,
      rawCount: arr.length,
      activeBranchVia: leafUuid ? "current_leaf_message_uuid" : "index-sort fallback",
      messages: messages
    };
  }

  return {
    extractText: extractText,
    selectActiveBranch: selectActiveBranch,
    normalize: normalize
  };
});
