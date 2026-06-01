/*
 * api-client.js  —  obtains the current conversation's message data.
 *
 * Two complementary strategies (kickoff chose "both"):
 *   1. HOOK: listen for payloads forwarded by interceptor.js (MAIN world),
 *      which captures whatever Claude's app itself fetches. Most faithful to
 *      reality and the primary source in Phase 1.
 *   2. DIRECT: replay a same-origin fetch to the conversation endpoint using
 *      the existing session cookie, once we know the org id (which we learn
 *      from the hooked API URLs). Lets us refresh on demand without waiting
 *      for the app to re-fetch.
 *
 * Phase 1 is discovery: the captured payload is held in memory only (never
 * stored), redacted, and logged so we can document the real shape. We also try
 * to normalise it into a linear [{uuid, role, text}] list and report whether
 * that worked.
 */
(function () {
  "use strict";

  var CTV = (window.CTV = window.CTV || {});
  var TAG = "[CTV api]";

  var state = {
    orgId: null, // discovered from hooked API URLs
    lastConversation: null, // { url, body, normalized } — in-memory only
    listeners: [] // fns(conversationData)
  };

  function getConversationIdFromUrl() {
    // Claude conversation URLs look like /chat/<uuid> (and historically
    // /chats/<uuid>). Be permissive and just grab the trailing uuid-ish id.
    var m = window.location.pathname.match(
      /\/chat[s]?\/([0-9a-f]{8}-[0-9a-f-]{20,}|[0-9a-f-]{8,})/i
    );
    return m ? m[1] : null;
  }

  // ---- redaction: keep structure, drop message text ------------------------
  // We log shape to the console for the findings report. Strip anything that
  // looks like message prose so the user can paste output safely.
  function redact(value, depth) {
    depth = depth || 0;
    if (depth > 6) return "<…>";
    if (value === null || typeof value !== "object") {
      if (typeof value === "string" && value.length > 40) {
        return "<string:" + value.length + " chars>";
      }
      return value;
    }
    if (Array.isArray(value)) {
      var arr = value.slice(0, 3).map(function (v) { return redact(v, depth + 1); });
      if (value.length > 3) arr.push("<…+" + (value.length - 3) + " more>");
      return arr;
    }
    var out = {};
    Object.keys(value).forEach(function (k) {
      // Always redact obvious content-bearing fields regardless of length.
      if (k === "text" || k === "content" || k === "input" || k === "summary") {
        out[k] = describeContent(value[k]);
      } else {
        out[k] = redact(value[k], depth + 1);
      }
    });
    return out;
  }

  function describeContent(v) {
    if (typeof v === "string") return "<text:" + v.length + " chars>";
    if (Array.isArray(v)) {
      return v.map(function (block) {
        if (block && typeof block === "object") {
          return { type: block.type, keys: Object.keys(block) };
        }
        return typeof block;
      });
    }
    if (v && typeof v === "object") return { keys: Object.keys(v) };
    return v;
  }

  // Flat, paste-friendly description of one raw message — for the findings
  // report (the console collapses nested objects, so we stringify).
  function describeMessage(m) {
    return {
      keys: Object.keys(m),
      topText: { type: typeof m.text, len: typeof m.text === "string" ? m.text.length : null },
      contentIsArray: Array.isArray(m.content),
      contentBlocks: Array.isArray(m.content)
        ? m.content.map(function (b) {
            return {
              type: b && b.type,
              keys: b && typeof b === "object" ? Object.keys(b) : null,
              textLen: b && typeof b.text === "string" ? b.text.length : null
            };
          })
        : null
    };
  }

  // Normalisation (active-branch selection + parser input contract) lives in the
  // pure, unit-tested api-normalize module.
  function normalize(body) {
    return CTV.apiNormalize.normalize(body);
  }

  // Which conversation a captured payload belongs to (from the API URL), so a
  // late/stale response can't be misattributed to whatever URL is now current.
  function convIdFromApiUrl(url) {
    var m = (url || "").match(/\/chat_conversations\/([0-9a-f-]+)/i);
    return m ? m[1] : null;
  }

  // ---- ingest a captured conversation payload ------------------------------
  function ingest(data) {
    var normalized = normalize(data.body);
    state.lastConversation = {
      url: data.url,
      via: data.via,
      conversationId: convIdFromApiUrl(data.url) || getConversationIdFromUrl(),
      body: data.body, // in-memory only; never persisted
      normalized: normalized
    };

    console.groupCollapsed(TAG, "conversation payload via", data.via, "—", data.url);
    console.log("Redacted shape:", redact(data.body));

    // Flat raw-shape dump (stringified so the console can't collapse it). No
    // prose: we only emit field names, types, and lengths.
    var msgs = (data.body && data.body.chat_messages) || [];
    console.log("top-level body keys:", JSON.stringify(Object.keys(data.body || {})));
    var firstHuman = msgs.find(function (m) { return (m.sender || m.role) === "human"; });
    var firstAsst = msgs.find(function (m) { return (m.sender || m.role) === "assistant"; });
    if (firstHuman) console.log("RAW human message shape:\n" + JSON.stringify(describeMessage(firstHuman), null, 2));
    if (firstAsst) console.log("RAW assistant message shape:\n" + JSON.stringify(describeMessage(firstAsst), null, 2));

    if (normalized && normalized.ok) {
      console.log(
        "Normalised:", normalized.count, "active-branch messages",
        "(of", normalized.rawCount, "raw) from field '" + normalized.arrayField + "'",
        "via", normalized.activeBranchVia
      );
      console.table(
        normalized.messages.slice(0, 8).map(function (m) {
          return {
            uuid: m.uuid,
            role: m.role,
            parentUuid: m.parentUuid,
            index: m.index,
            textLen: m.text.length
          };
        })
      );
    } else {
      console.warn("Could not normalise message list:", normalized);
    }
    console.groupEnd();

    state.listeners.forEach(function (fn) {
      try { fn(state.lastConversation); } catch (e) { console.error(TAG, e); }
    });
  }

  // ---- hook: receive forwarded payloads from the MAIN-world interceptor ----
  function installHookListener() {
    window.addEventListener("message", function (event) {
      if (event.source !== window) return;
      var d = event.data;
      if (!d || d.source !== "ctv-interceptor") return;

      if (d.kind === "api-url") {
        // Learn the org id from any chat_conversations URL we see.
        var m = (d.payload.url || "").match(/\/organizations\/([0-9a-f-]+)\//i);
        if (m && !state.orgId) {
          state.orgId = m[1];
          console.debug(TAG, "discovered orgId via hooked URL");
        }
      } else if (d.kind === "conversation") {
        ingest(d.payload);
      }
    });
  }

  // ---- direct fetch (replay) ----------------------------------------------
  // Only usable once we know the org id. Tries a couple of query-string
  // variants seen in the wild; logs which (if any) succeeded.
  function directFetch() {
    var convId = getConversationIdFromUrl();
    if (!convId) return Promise.resolve({ ok: false, reason: "no conversation id in URL" });
    if (!state.orgId) return Promise.resolve({ ok: false, reason: "org id not yet discovered (waiting on hook)" });

    var base =
      "/api/organizations/" + state.orgId + "/chat_conversations/" + convId;
    // Deliberately WITHOUT tree=True: those payloads include every edit/
    // regeneration branch (confirmed empirically). These variants return the
    // flat active branch directly; normalize() also reconstructs it from
    // current_leaf_message_uuid, so a hooked tree=True payload is handled too.
    var candidates = [
      base + "?rendering_mode=messages",
      base + "?rendering_mode=raw",
      base
    ];

    function tryNext(i) {
      if (i >= candidates.length) return Promise.resolve({ ok: false, reason: "all candidate URLs failed" });
      return fetch(candidates[i], { credentials: "include", headers: { accept: "application/json" } })
        .then(function (res) {
          if (!res.ok) return tryNext(i + 1);
          return res.json().then(function (json) {
            ingest({ url: candidates[i], via: "direct-fetch", status: res.status, body: json });
            return { ok: true, url: candidates[i] };
          });
        })
        .catch(function () { return tryNext(i + 1); });
    }
    return tryNext(0);
  }

  function onConversation(fn) {
    state.listeners.push(fn);
    if (state.lastConversation) fn(state.lastConversation);
  }

  function init() {
    installHookListener();
    console.debug(TAG, "ready; conversation id =", getConversationIdFromUrl());
  }

  CTV.apiClient = {
    init: init,
    getConversationIdFromUrl: getConversationIdFromUrl,
    onConversation: onConversation,
    directFetch: directFetch,
    getState: function () { return state; }
  };
})();
