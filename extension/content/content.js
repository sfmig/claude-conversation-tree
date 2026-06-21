/*
 * content.js  —  entry point (isolated world).
 *
 * Pipeline on each conversation load / SPA navigation:
 *   1. Initialise storage (ensure the schema exists).
 *   2. Capture conversation data (api-client: hook + direct fetch).
 *   3. Correlate DOM ↔ UUIDs (dom-mapper).
 *   4. Parse the message list into a topic tree (parser).
 *   5. Render the read-only tree panel and wire bidirectional highlighting.
 *
 * (Phase 1's redacted FINDINGS console report is retained as a collapsed debug
 * group.)
 */
(function () {
  "use strict";

  var CTV = window.CTV || {};
  var TAG = "[CTV]";
  var VERSION = "0.1.0";

  var currentResult = null;          // last merged tree rendered
  var currentConversationId = null;  // the conversation currently rendered
  var currentParsed = null;          // last raw parse (to re-merge on edits)
  var currentOverrides = null;       // user overrides for the current conversation
  var currentTitle = "Conversation"; // current conversation title (for persist)

  function printFindings(conv) {
    var api = CTV.apiClient.getState();
    var mapSize = CTV.domMapper.getMap().size;
    var norm = conv && conv.normalized;

    console.groupCollapsed("%c[CTV] debug findings", "font-weight:bold");
    console.log("extension version:", VERSION);
    console.log("page URL:", window.location.href);
    console.log("conversation id (from URL):", CTV.apiClient.getConversationIdFromUrl());
    console.log("org id discovered:", api.orgId || "(not yet)");
    console.log("payload source:", conv ? conv.via : "(none captured yet)");
    console.log("endpoint URL:", conv ? conv.url : "(none)");
    if (norm && norm.ok) {
      console.log("message array field:", norm.arrayField);
      console.log("message count:", norm.count);
      console.log("sample roles:", Array.from(new Set(norm.messages.map(function (m) { return m.role; }))));
    } else if (norm) {
      console.warn("normalisation FAILED:", norm);
    }
    console.log("DOM↔UUID map size:", mapSize);
    console.log("→ Expand the '[CTV api] conversation payload' and '[CTV dom] selector probe' groups above for shape + selector details.");
    console.groupEnd();
  }

  function onConversationData(conv) {
    // 3. DOM ↔ UUID correlation.
    CTV.domMapper.correlate(conv.normalized);
    printFindings(conv);

    if (!conv.normalized || !conv.normalized.ok) {
      console.warn(TAG, "no normalised messages — skipping parse/render");
      return;
    }

    // Don't clobber a good tree with an empty payload (e.g. a settings write
    // that returned no messages slipped through).
    if (conv.normalized.messages.length === 0) {
      console.debug(TAG, "empty message list — keeping current tree");
      return;
    }

    // 4. Parse into a topic tree (parser is pure; input = normalized messages).
    // Use the conversation id the payload was fetched for (not the live URL),
    // so a late response is attributed correctly.
    var conversationId = conv.conversationId || CTV.apiClient.getConversationIdFromUrl();
    var conversationTitle =
      (conv.body && (conv.body.name || conv.body.title)) || "Conversation";
    var messages = conv.normalized.messages.map(function (m) {
      return { uuid: m.uuid, role: m.role, text: m.text, index: m.index };
    });

    // Snapshot the previous render's message→node index BEFORE it's replaced —
    // used below to detect an in-place edit and follow it.
    var prevIndex = (conversationId === currentConversationId && currentResult)
      ? currentResult.tree.messageIndex
      : null;

    // 4. Load stored overrides FIRST — markers resolve against the tree the user
    // currently sees (renames/drags), so the parser needs the overrides.
    CTV.storage.getConversation(conversationId).then(function (stored) {
      var overrides = (stored && stored.overrides) || CTV.merge.emptyOverrides();

      var parsed = CTV.parser.parseConversation({
        conversationId: conversationId,
        conversationTitle: conversationTitle,
        messages: messages,
        overrides: overrides
      });

      // 5. Merge → render → persist (PLAN §7).
      var merged = CTV.merge.applyOverrides(parsed, overrides);

      // Only render if this payload is for the conversation the user is now
      // viewing; otherwise it's stale (user navigated away) — but still persist.
      var isCurrent = conversationId === CTV.apiClient.getConversationIdFromUrl();
      if (isCurrent) {
        currentConversationId = conversationId;
        currentParsed = parsed;
        currentOverrides = overrides;
        currentTitle = conversationTitle;
        currentResult = merged;
        console.debug(TAG, "merged tree:",
          Object.keys(merged.tree.nodes).length, "nodes,",
          Object.keys(parsed.bookmarks).length, "marker bookmarks");
        renderTree(merged);

        // Reconcile message highlights with the re-parsed tree. renderTree only
        // swaps the parse result; the sticky re-apply path only ADDS the active
        // node's current messages — it never clears stale highlights or
        // recomputes the color. And on an in-place edit the selection should
        // FOLLOW the edited message: adding /node selects the new node, removing
        // it selects the node the message fell back into.
        var follow = followEditNode(prevIndex, messages, merged);
        var mutationPending = mutationPendingSince &&
          (Date.now() - mutationPendingSince < 15000);
        if (mutationPending && !follow.changed) {
          // The refetch beat the server's branch switch: same uuids as the
          // previous render. Repainting now would re-issue the OLD node's
          // color onto the edited turn (and end the mutation pause) — keep
          // waiting; the settle refetch brings the real change.
          console.debug(TAG, "live highlight — unchanged payload during edit, awaiting settle");
        } else {
          mutationPendingSince = 0;
          var followId = follow.nodeId;
          var active = CTV.treePanel.getActiveNode && CTV.treePanel.getActiveNode();
          if (followId) {
            // noScroll: the user is sitting at the just-edited message.
            CTV.treePanel.setActiveNode(followId);
            CTV.highlighting.highlightNodeMessages(followId, true);
          } else if (active && merged.tree.nodes[active]) {
            // Not an edit (plain append / settle pass): re-issue the existing
            // selection so stale paint is cleared and the color is fresh.
            CTV.highlighting.highlightNodeMessages(active, true);
          } else {
            // Active node vanished and there's nothing to follow — drop
            // lingering highlights so no message keeps an old color.
            CTV.highlighting.clearMessageHighlights();
          }
          console.debug(TAG, "live highlight —",
            followId ? "follow " + followId.slice(0, 8)
                     : (active && merged.tree.nodes[active]) ? "reconcile " + active.slice(0, 8)
                     : "clear");
        }
      } else {
        console.debug(TAG, "stale payload for", conversationId, "— persisting only");
      }

      return persist(conversationId, conversationTitle, parsed, overrides, merged);
    }).catch(function (e) {
      console.error(TAG, "persist/merge failed", e);
    });
  }

  // An in-place edit rewrites the active branch: uuids from the previous render
  // vanish and the edited message reappears under a fresh uuid. Return the node
  // the newest such user message now belongs to (the node the selection should
  // follow), or null when this re-parse isn't an edit (first render, plain
  // append, regenerate-only — regenerates replace only assistant uuids, and
  // assistant messages can't carry markers, so there's nothing to follow).
  // `changed` reports whether the uuid set differs from the previous render at
  // all — false means the payload shows the same branch state we already have
  // (used to spot a stale refetch while a mutation is pending).
  function followEditNode(prevIndex, messages, merged) {
    if (!prevIndex) return { nodeId: null, changed: true }; // first render — nothing to compare
    var present = {};
    var added = false;
    messages.forEach(function (m) {
      present[m.uuid] = true;
      if (!prevIndex[m.uuid]) added = true;
    });
    var vanished = Object.keys(prevIndex).some(function (u) { return !present[u]; });
    if (!vanished) return { nodeId: null, changed: added };
    for (var i = messages.length - 1; i >= 0; i--) {
      var m = messages[i];
      if ((m.role === "human" || m.role === "user") && !prevIndex[m.uuid]) {
        var nodeId = merged.tree.messageIndex[m.uuid];
        return {
          nodeId: (nodeId && merged.tree.nodes[nodeId]) ? nodeId : null,
          changed: true
        };
      }
    }
    return { nodeId: null, changed: true };
  }

  // The merged tree is a cache; overrides remain the source of truth.
  function persist(conversationId, title, parsed, overrides, merged) {
    var record = {
      conversationId: conversationId,
      conversationTitle: title,
      rootNodeId: merged.rootNodeId,
      tree: merged.tree,
      overrides: overrides,
      lastParsedAt: Date.now(),
      schemaVersion: CTV.storage.SCHEMA_VERSION
    };
    return CTV.storage.persistConversation(conversationId, record, parsed.bookmarks);
  }

  // Re-merge current overrides → re-render → persist. Called after every edit.
  function commitEdit() {
    if (!currentParsed || !currentOverrides) return;
    var merged = CTV.merge.applyOverrides(currentParsed, currentOverrides);
    currentResult = merged;
    renderTree(merged);

    // Refresh the highlight for the still-selected node so absorbed/moved
    // messages are reflected immediately (e.g. after a delete promotes a child's
    // messages into the active node).
    var active = CTV.treePanel.getActiveNode && CTV.treePanel.getActiveNode();
    if (active && merged.tree.nodes[active]) {
      CTV.highlighting.highlightNodeMessages(active);
    }

    persist(currentConversationId, currentTitle, currentParsed, currentOverrides, merged)
      .catch(function (e) { console.error(TAG, "persist after edit failed", e); });
  }

  function nodeOverride(nodeId) {
    var ov = currentOverrides.nodeOverrides;
    if (!ov[nodeId]) ov[nodeId] = {};
    return ov[nodeId];
  }

  // ---- edit handlers (write to overrides; merge enforces the rules) --------
  var editor = {
    onNodeSelect: function (nodeId) {
      CTV.highlighting.highlightNodeMessages(nodeId);
    },
    onRename: function (nodeId, title) {
      if (!currentOverrides) return;
      title = (title || "").trim();
      if (!title) return;
      nodeOverride(nodeId).title = title;
      commitEdit();
    },
    onDelete: function (nodeId) {
      if (!currentOverrides || !currentResult) return;
      if (nodeId === currentResult.rootNodeId) return; // never delete root
      nodeOverride(nodeId).deleted = true;
      commitEdit();
    },
    onReparent: function (nodeId, newParentId) {
      if (!currentOverrides) return;
      nodeOverride(nodeId).parentId = newParentId;
      commitEdit(); // merge rejects cycles / invalid targets defensively
    },
    onReset: function () {
      if (!currentOverrides) return;
      currentOverrides = CTV.merge.emptyOverrides();
      commitEdit();
    }
  };

  function renderTree(result) {
    CTV.highlighting.update(result);
    CTV.highlighting.init();
    CTV.treePanel.render(result, editor);
  }

  function boot() {
    console.log("%c" + TAG + " content script loaded — Phase 5 (editing)", "color:#a855f7;font-weight:bold", "v" + VERSION);

    var required = ["storage", "parser", "merge", "apiClient", "domMapper", "highlighting", "treePanel"];
    var missing = required.filter(function (m) { return !CTV[m]; });
    if (missing.length) {
      console.error(TAG, "module(s) missing — check content_scripts load order:", missing);
      return;
    }

    CTV.storage.init().then(function () {
      console.debug(TAG, "storage initialised");
    }).catch(function (e) {
      console.error(TAG, "storage init failed", e);
    });

    CTV.domMapper.init();
    CTV.apiClient.init();
    CTV.apiClient.onConversation(onConversationData);
    CTV.apiClient.onConversationMutated(onConversationMutated);

    installNavWatcher();
    refresh("initial load");
  }

  // ---- live re-parse on in-place edits ------------------------------------
  // Editing/regenerating a message updates the app in place without a GET, so
  // neither the hook nor refresh() (guarded on currentConversationId) fires.
  // On a /completion mutation we force a re-fetch so adding OR removing a marker
  // is reflected without a manual reload. Debounced to coalesce the burst, with
  // a follow-up pass once the regenerated reply has settled (final text → correct
  // correlation + highlighting).
  var liveRefetchTimer = null;
  var mutationPendingSince = 0; // a write is in flight; unchanged payloads are stale until it lands
  function onConversationMutated(payload) {
    var convId = CTV.apiClient.getConversationIdFromUrl();
    if (!convId) return;
    if (payload && payload.conversationId && payload.conversationId !== convId) return;
    mutationPendingSince = Date.now();
    // The edited turn re-renders right away; strip its now-stale paint and
    // pause the sticky repaint so it isn't painted in the OLD node's color
    // while the re-parse is in flight (the highlight reconcile re-issues
    // paint and ends the pause).
    if (CTV.highlighting.pauseForMutation) CTV.highlighting.pauseForMutation();
    if (liveRefetchTimer) clearTimeout(liveRefetchTimer);
    liveRefetchTimer = setTimeout(function () {
      forceRefetch(convId);
      setTimeout(function () { forceRefetch(convId); }, 4000);
    }, 1500);
  }
  function forceRefetch(convId) {
    if (CTV.apiClient.getConversationIdFromUrl() !== convId) return; // navigated away
    CTV.apiClient.directFetch().then(function (r) {
      if (!(r && r.ok)) console.debug(TAG, "live re-parse fetch failed:", r && r.reason);
    });
  }

  // ---- conversation refresh ------------------------------------------------
  // Fetch + render the conversation in the current URL. The hook renders new
  // conversations automatically; this is the reliable path for cached ones
  // (no network GET) and a fallback when a navigation isn't otherwise caught.
  function refresh(reason) {
    var convId = CTV.apiClient.getConversationIdFromUrl();
    if (!convId) {                             // not on a conversation page (e.g. "New chat")
      if (currentConversationId !== null) {
        console.debug(TAG, "refresh (" + reason + ") → no conversation; clearing tree");
        clearTree();
      }
      return;
    }
    if (convId === currentConversationId) return; // already rendered
    console.debug(TAG, "refresh (" + reason + ") →", convId);
    attemptFetch(convId, 0);
  }

  // Wipe the rendered tree + selection state when leaving a conversation, so the
  // previous conversation's tree doesn't stay visible over a new/blank chat.
  function clearTree() {
    currentConversationId = null;
    currentResult = null;
    currentParsed = null;
    currentOverrides = null;
    currentTitle = "Conversation";
    if (CTV.highlighting.clearMessageHighlights) CTV.highlighting.clearMessageHighlights();
    if (CTV.treePanel.clear) CTV.treePanel.clear();
  }

  // Retry with backoff: the hook may beat us (sets currentConversationId), the
  // org id may not be known yet, or a fetch may transiently fail.
  function attemptFetch(convId, tries) {
    if (CTV.apiClient.getConversationIdFromUrl() !== convId) return; // navigated away
    if (convId === currentConversationId) return;                    // already shown
    CTV.apiClient.directFetch().then(function (r) {
      if (r && r.ok) return; // ingest → onConversationData renders
      if (tries < 6 &&
          CTV.apiClient.getConversationIdFromUrl() === convId &&
          convId !== currentConversationId) {
        setTimeout(function () { attemptFetch(convId, tries + 1); }, 400 + tries * 500);
      } else if (!(r && r.ok)) {
        console.debug(TAG, "refresh gave up for", convId, "-", r && r.reason);
      }
    });
  }

  // ---- SPA navigation handling --------------------------------------------
  // Claude swaps conversations without a full reload. Rather than rely solely on
  // patching history methods (some navigations bypass them), poll the URL — it's
  // cheap and catches every navigation type — and also hook history for snappy
  // response.
  function installNavWatcher() {
    var lastUrl = location.href;
    function check() {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        refresh("navigation");
      }
    }
    ["pushState", "replaceState"].forEach(function (fn) {
      var orig = history[fn];
      history[fn] = function () {
        var r = orig.apply(this, arguments);
        check();
        return r;
      };
    });
    window.addEventListener("popstate", check);
    setInterval(check, 600);
  }

  boot();
})();
