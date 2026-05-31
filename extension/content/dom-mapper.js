/*
 * dom-mapper.js  —  builds and maintains Map<messageUuid, HTMLElement>.
 *
 * Claude.ai is a React SPA that re-renders and may virtualise messages, so we
 * keep the map fresh with a (debounced) MutationObserver.
 *
 * Phase 1 problem: we don't yet know which selectors identify a message, nor
 * whether the DOM already carries the UUID. So this file is deliberately
 * exploratory — it probes a list of candidate selectors, reports which match,
 * dumps the attributes/classes of sample message nodes, and attempts to
 * correlate DOM elements to API messages by text prefix. Whatever we learn
 * here drives the real selector choice in later phases.
 */
(function () {
  "use strict";

  var CTV = (window.CTV = window.CTV || {});
  var TAG = "[CTV dom]";

  // Candidate selectors for "a message element", best-guess + generic probes.
  // Reported by likelihood; the findings report will tell us which are real.
  var CANDIDATE_SELECTORS = [
    '[data-testid="user-message"]',
    '[data-testid="message"]',
    'div[data-test-render-count]',
    '.font-claude-message',
    '.font-user-message',
    '[data-message-id]',
    '[data-message-uuid]',
    '[data-msg-uuid]',
    'div[class*="message"]'
  ];

  var DATA_UUID_ATTR = "data-ctv-uuid"; // our own tag, applied after correlation

  // Per-turn container: one per message (user + assistant), in document order.
  // Confirmed in Phase 1: count equals chat_messages length; assistant turns
  // have no testid of their own, so order mapping (zipped against API `index`)
  // is the reliable strategy. User turns contain [data-testid="user-message"],
  // which we use to verify role alignment.
  var TURN_SELECTOR = "div[data-test-render-count]";

  var map = new Map(); // uuid -> HTMLElement
  var observer = null;
  var debounceTimer = null;
  var lastNormalized = null; // last normalised message list from api-client

  function normalizeText(s) {
    return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  // Flatten an element's attributes into one paste-friendly string (values
  // capped so a giant class list doesn't dominate).
  function attrString(el) {
    return Array.prototype.map.call(el.attributes, function (a) {
      var v = a.value.length > 60 ? a.value.slice(0, 60) + "…" : a.value;
      return a.name + '="' + v + '"';
    }).join("  ");
  }

  // The decisive question for Phase 3: does any DOM attribute already carry a
  // message UUID? Scan every element's attribute values for any known UUID
  // (exact or substring, e.g. data-key="msg-<uuid>"). Cheap for small convos.
  function findUuidInDom(uuids) {
    if (!uuids || !uuids.length) return [];
    var set = new Set(uuids);
    var hits = [];
    var all = document.querySelectorAll("*");
    for (var i = 0; i < all.length && hits.length < 8; i++) {
      var attrs = all[i].attributes;
      for (var j = 0; j < attrs.length; j++) {
        if (attrs[j].name === DATA_UUID_ATTR) continue; // ignore our own tag
        var v = attrs[j].value;
        if (!v || v.length < 36) continue; // a UUID is 36 chars
        var exact = set.has(v);
        var sub = false;
        if (!exact) { set.forEach(function (u) { if (v.indexOf(u) !== -1) sub = true; }); }
        if (exact || sub) {
          hits.push(all[i].tagName.toLowerCase() + "[" + attrs[j].name + (exact ? " = exact uuid]" : " contains uuid]"));
          break;
        }
      }
    }
    return hits;
  }

  // Probe each candidate selector and log match counts + sample attributes.
  // `uuids` (optional) enables the DOM-UUID scan.
  function probe(uuids) {
    var report = [];
    CANDIDATE_SELECTORS.forEach(function (sel) {
      var els;
      try { els = document.querySelectorAll(sel); } catch (e) { return; }
      if (els.length) report.push({ selector: sel, matches: els.length });
    });

    console.groupCollapsed(TAG, "selector probe");

    // Dump every distinct data-testid + its count. This reveals how Claude tags
    // assistant turns (user turns are data-testid="user-message").
    var testIdCounts = {};
    document.querySelectorAll("[data-testid]").forEach(function (el) {
      var t = el.getAttribute("data-testid");
      testIdCounts[t] = (testIdCounts[t] || 0) + 1;
    });
    console.log("all data-testid values: " + JSON.stringify(testIdCounts));

    if (report.length) {
      report.forEach(function (r) { console.log("  " + r.matches + "× " + r.selector); });

      // Show flat attributes for a sample of each of the two most useful hits.
      report.slice(0, 3).forEach(function (r) {
        var sample = document.querySelector(r.selector);
        if (!sample) return;
        console.log("SAMPLE '" + r.selector + "' → " + sample.tagName.toLowerCase());
        console.log("  attrs: " + attrString(sample));
        // Walk ancestors — the UUID often lives on a wrapper, not the text node.
        var p = sample.parentElement, hops = 0;
        while (p && hops < 4) {
          var s = attrString(p);
          if (/uuid|message|test|index|key/i.test(s)) console.log("  ancestor[" + hops + "]: " + s);
          p = p.parentElement; hops++;
        }
      });
    } else {
      console.warn("No candidate selectors matched. DOM may not be ready, or selectors need revision.");
    }

    if (uuids && uuids.length) {
      var hits = findUuidInDom(uuids);
      if (hits.length) {
        console.log("%cDOM CARRIES UUID ✓ → " + JSON.stringify(hits), "color:#16a34a;font-weight:bold");
      } else {
        console.log("%cNo DOM attribute contains a message UUID — must map by text/order.", "color:#d97706");
      }
    }
    console.groupEnd();
    return report;
  }

  // Messages sorted by API index (defensive; chat_messages already in order).
  function orderedMessages(normalized) {
    return normalized.messages.slice().sort(function (a, b) {
      if (a.index == null || b.index == null) return 0;
      return a.index - b.index;
    });
  }

  function turnRole(el) {
    return el.querySelector('[data-testid="user-message"]') ? "human" : "assistant";
  }
  function turnText(el) {
    var u = el.querySelector('[data-testid="user-message"]');
    return normalizeText((u || el).textContent).slice(0, 80);
  }

  // Link API messages to DOM elements via greedy alignment.
  //
  // The rendered turn containers are an in-order SUBSEQUENCE of the API message
  // list (Claude virtualizes off-screen turns). We walk both in order: user
  // turns are anchored by text (reliable — user text isn't reformatted), and
  // assistant turns are filled by role/order between anchors. Each user anchor
  // re-syncs the message pointer, so any miscount stays local. Messages with no
  // rendered turn (off-screen) are simply left unmapped.
  function correlate(normalized) {
    if (!normalized || !normalized.ok || !normalized.messages.length) {
      console.warn(TAG, "no normalised messages to correlate against yet");
      return { matched: 0, total: 0 };
    }
    lastNormalized = normalized;

    var msgs = orderedMessages(normalized);
    var turns = Array.prototype.slice.call(document.querySelectorAll(TURN_SELECTOR));
    var total = msgs.length;

    function nextOfRole(from, role) {
      for (var j = from; j < msgs.length; j++) if (msgs[j].role === role) return j;
      return -1;
    }
    function nextHumanByText(from, key) {
      for (var j = from; j < msgs.length; j++) {
        if (msgs[j].role !== "human") continue;
        var mk = normalizeText(msgs[j].text).slice(0, 80);
        if (mk === key || (key && mk && (mk.indexOf(key) === 0 || key.indexOf(mk) === 0))) return j;
      }
      return -1;
    }

    map.clear();
    var i = 0, matched = 0;
    turns.forEach(function (el) {
      var role = turnRole(el);
      var k = role === "human" ? nextHumanByText(i, turnText(el)) : -1;
      if (k === -1) k = nextOfRole(i, role); // fallback: next of this role
      if (k === -1) return;                  // no remaining message of this role
      var uuid = msgs[k].uuid;
      el.setAttribute(DATA_UUID_ATTR, uuid);
      map.set(uuid, el);
      i = k + 1;
      matched++;
    });

    console.log("%c" + TAG + " correlated " + matched + "/" + total + " messages to DOM",
      matched >= total ? "color:#16a34a" : "color:#d97706");
    return { matched: matched, total: total, strategy: "greedy" };
  }

  function scheduleRecorrelate() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      if (lastNormalized) correlate(lastNormalized);
    }, 400);
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(function () { scheduleRecorrelate(); });
    observer.observe(document.body, { childList: true, subtree: true });
    console.debug(TAG, "MutationObserver attached to document.body");
  }

  function init() {
    startObserver();
    // Initial probe so we get a DOM report even before API data arrives.
    probe();
  }

  CTV.domMapper = {
    init: init,
    probe: probe,
    correlate: correlate,
    getMap: function () { return map; },
    getElement: function (uuid) { return map.get(uuid) || null; }
  };
})();
