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
  function isApiUrl(url) {
    return /\/api\//.test(url);
  }

  function post(kind, payload) {
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
