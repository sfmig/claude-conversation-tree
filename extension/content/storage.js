/*
 * storage.js  —  thin wrapper around chrome.storage.local.
 *
 * The entire extension state lives under a single key (ROOT_KEY) so we can
 * read/merge/write atomically and version it. Phase 1 only needs to initialise
 * the schema and offer get/set/update helpers; later phases store the parsed
 * tree, overrides, and bookmarks here.
 *
 * PRIVACY: this layer must never persist message *content* — only UUIDs and
 * metadata. The default schema below contains no message text and nothing here
 * writes any.
 */
(function () {
  "use strict";

  var CTV = (window.CTV = window.CTV || {});

  var ROOT_KEY = "tree-viz-data";
  var SCHEMA_VERSION = 1;

  function defaultRoot() {
    return {
      conversations: {},
      bookmarks: {},
      settings: {},
      schemaVersion: SCHEMA_VERSION
    };
  }

  // chrome.storage.local supports promises in MV3 (no callback needed).
  function getRoot() {
    return chrome.storage.local.get(ROOT_KEY).then(function (res) {
      var root = res && res[ROOT_KEY];
      if (!root || typeof root !== "object") root = defaultRoot();
      // Backfill any missing top-level fields without clobbering existing data.
      var base = defaultRoot();
      Object.keys(base).forEach(function (k) {
        if (!(k in root)) root[k] = base[k];
      });
      return root;
    });
  }

  function setRoot(root) {
    var payload = {};
    payload[ROOT_KEY] = root;
    return chrome.storage.local.set(payload).then(function () {
      return root;
    });
  }

  // Read-modify-write helper. `mutator(root)` may return a new root or mutate
  // in place; whatever it returns (or the mutated root) is persisted.
  function updateRoot(mutator) {
    return getRoot().then(function (root) {
      var next = mutator(root);
      return setRoot(next || root);
    });
  }

  // Ensure the schema exists exactly once. Returns the (initialised) root.
  function init() {
    return getRoot().then(function (root) {
      return setRoot(root);
    });
  }

  // ---- conversation-level helpers (Phase 4) --------------------------------

  function getConversation(conversationId) {
    return getRoot().then(function (root) {
      return root.conversations[conversationId] || null;
    });
  }

  // Persist a conversation record (the merged tree is a cache; overrides are
  // the source of truth for user edits) and re-sync this conversation's
  // marker-sourced bookmarks, while leaving user (button) bookmarks untouched.
  function persistConversation(conversationId, record, markerBookmarks) {
    return updateRoot(function (root) {
      root.conversations[conversationId] = record;

      markerBookmarks = markerBookmarks || {};
      Object.keys(root.bookmarks).forEach(function (bid) {
        var b = root.bookmarks[bid];
        if (b && b.conversationId === conversationId && b.source === "marker") {
          delete root.bookmarks[bid];
        }
      });
      Object.keys(markerBookmarks).forEach(function (bid) {
        root.bookmarks[bid] = markerBookmarks[bid];
      });
      return root;
    });
  }

  // React to changes from other tabs (Phase 13 open question: multi-tab sync).
  // Exposed now so later phases can subscribe; harmless in Phase 1.
  function onChange(callback) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === "local" && changes[ROOT_KEY]) {
        callback(changes[ROOT_KEY].newValue, changes[ROOT_KEY].oldValue);
      }
    });
  }

  CTV.storage = {
    ROOT_KEY: ROOT_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    defaultRoot: defaultRoot,
    getRoot: getRoot,
    setRoot: setRoot,
    updateRoot: updateRoot,
    init: init,
    getConversation: getConversation,
    persistConversation: persistConversation,
    onChange: onChange
  };
})();
