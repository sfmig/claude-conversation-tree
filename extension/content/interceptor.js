/*
 * interceptor.js  —  runs in the page's MAIN world at document_start.
 *
 * Why MAIN world: content scripts run in an isolated world with their own
 * `fetch`/`XMLHttpRequest`. Claude's React app uses the *page's* fetch, so to
 * observe its real API traffic we must patch the page's own globals. We install
 * at document_start so we beat the app's first conversation request.
 *
 * This script never stores anything and never makes its own network calls. It
 * only forwards captured request metadata to the isolated-world scripts via
 * window.postMessage, where api-client.js picks it up.
 *
 * Phase 1 = discovery. The goal is to learn the real endpoint URLs and the
 * shape of the conversation payload so we can write the findings report.
 */
(function () {
  "use strict";

  if (window.__CTV_INTERCEPTOR_INSTALLED__) return;
  window.__CTV_INTERCEPTOR_INSTALLED__ = true;

  var TAG = "[CTV interceptor]";

  // Endpoints we care about for Phase 1. We log *all* API URLs (URL only, no
  // bodies) to a low-noise channel, but only forward full payloads for these.
  function isConversationEndpoint(url) {
    return /\/chat_conversations\/[0-9a-f-]+/i.test(url) &&
           !/\/(completion|title|chat_message_warning)/i.test(url);
  }
  // A write that changes the conversation's messages: a completion (a new turn,
  // a regenerate, or a user-message edit — all stream through /completion). We
  // use this to know the conversation changed in place, since the app updates
  // its own state without re-GETting (so isConversationEndpoint never fires).
  function isConversationMutation(url, method) {
    return !/^get$/i.test(method) &&
           /\/chat_conversations\/[0-9a-f-]+/i.test(url) &&
           /completion/i.test(url);
  }
  function conversationIdFromUrl(url) {
    var m = (url || "").match(/\/chat_conversations\/([0-9a-f-]+)/i);
    return m ? m[1] : null;
  }
  function isApiUrl(url) {
    return /\/api\//.test(url);
  }

  // We run at document_start but the isolated-world scripts (api-client) load at
  // document_idle. On a fresh/cached load the app's conversation GET — and the
  // org-bearing API URL — can fire before api-client's message listener exists,
  // so those posts are lost and the tree never renders until an SPA navigation
  // re-triggers a GET. We cache the last of each so we can replay on request.
  var cached = { apiUrl: null, conversation: null };

  function post(kind, payload) {
    if (kind === "conversation") {
      cached.conversation = payload;
    } else if (kind === "api-url" && !cached.apiUrl &&
               /\/organizations\//.test((payload && payload.url) || "")) {
      cached.apiUrl = payload; // carries the org id api-client needs
    }
    try {
      window.postMessage(
        { source: "ctv-interceptor", kind: kind, payload: payload },
        window.location.origin
      );
    } catch (e) {
      // postMessage can throw on non-cloneable payloads; degrade gracefully.
      console.warn(TAG, "postMessage failed", e);
    }
  }

  // When api-client comes up (document_idle) it pings us; replay whatever it may
  // have missed so the tree renders on first load without an SPA navigation.
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (!d || d.source !== "ctv-client" || d.kind !== "ready") return;
    if (cached.apiUrl) post("api-url", cached.apiUrl);
    if (cached.conversation) post("conversation", cached.conversation);
  });

  function noteUrl(method, url) {
    if (isApiUrl(url)) post("api-url", { method: method, url: url });
  }

  // ---- patch fetch ---------------------------------------------------------
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method =
        (init && init.method) ||
        (input && input.method) ||
        "GET";
      noteUrl(method, url);
      if (isConversationMutation(url, method)) {
        post("conversation-mutated", { conversationId: conversationIdFromUrl(url), url: url, method: method });
      }

      var p = origFetch.apply(this, arguments);

      // Only the GET that loads the conversation carries chat_messages; ignore
      // PUT/PATCH/POST writes (model change, rename, settings) on the same URL.
      if (isConversationEndpoint(url) && /^get$/i.test(method)) {
        p.then(function (res) {
          try {
            // Clone so we never consume the body the app needs.
            res.clone().json().then(
              function (json) {
                post("conversation", {
                  url: url,
                  method: method,
                  status: res.status,
                  via: "fetch",
                  body: json
                });
              },
              function () {/* not JSON; ignore */}
            );
          } catch (e) {/* ignore */}
        }).catch(function () {/* network error; ignore */});
      }
      return p;
    };
    console.debug(TAG, "fetch patched");
  }

  // ---- patch XMLHttpRequest ------------------------------------------------
  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      this.__ctvMethod = method;
      this.__ctvUrl = url;
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      var xhr = this;
      var url = xhr.__ctvUrl || "";
      var method = xhr.__ctvMethod || "GET";
      noteUrl(method, url);
      if (isConversationMutation(url, method)) {
        post("conversation-mutated", { conversationId: conversationIdFromUrl(url), url: url, method: method });
      }

      if (isConversationEndpoint(url) && /^get$/i.test(method)) {
        xhr.addEventListener("load", function () {
          try {
            var ct = xhr.getResponseHeader("content-type") || "";
            if (ct.indexOf("application/json") === -1) return;
            var json = JSON.parse(xhr.responseText);
            post("conversation", {
              url: url,
              method: method,
              status: xhr.status,
              via: "xhr",
              body: json
            });
          } catch (e) {/* ignore */}
        });
      }
      return origSend.apply(this, arguments);
    };
    console.debug(TAG, "XMLHttpRequest patched");
  }

  console.debug(TAG, "installed in MAIN world");
})();
