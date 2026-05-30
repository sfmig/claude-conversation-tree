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

  // STRATEGY A (preferred): order mapping. Zip per-turn containers in document
  // order against API messages by index, after verifying role alignment (a
  // turn containing a user-message must correspond to a `human` message). If
  // counts mismatch or roles don't line up (e.g. virtualization dropped turns),
  // return null so the caller falls back.
  function correlateByOrder(normalized) {
    var turns = Array.prototype.slice.call(document.querySelectorAll(TURN_SELECTOR));
    var msgs = orderedMessages(normalized);
    if (!turns.length || turns.length !== msgs.length) {
      return { ok: false, reason: "turn count " + turns.length + " != message count " + msgs.length };
    }
    // Verify role alignment before trusting the zip.
    for (var i = 0; i < turns.length; i++) {
      var isUser = !!turns[i].querySelector('[data-testid="user-message"]');
      if (isUser !== (msgs[i].role === "human")) {
        return { ok: false, reason: "role misalignment at position " + i };
      }
    }
    map.clear();
    turns.forEach(function (el, i) {
      el.setAttribute(DATA_UUID_ATTR, msgs[i].uuid);
      map.set(msgs[i].uuid, el);
    });
    return { ok: true, matched: turns.length, total: msgs.length, strategy: "order", selector: TURN_SELECTOR };
  }

  // Link API messages to DOM elements. Tries order mapping first (robust),
  // then falls back to text-prefix matching, reporting per-selector hit rates.
  function correlate(normalized) {
    if (!normalized || !normalized.ok || !normalized.messages.length) {
      console.warn(TAG, "no normalised messages to correlate against yet");
      return { matched: 0, total: 0 };
    }
    lastNormalized = normalized;

    var uuids = normalized.messages.map(function (m) { return m.uuid; });
    var probeReport = probe(uuids);

    // --- Strategy A: order mapping ---
    var order = correlateByOrder(normalized);
    if (order.ok) {
      console.log("%c" + TAG + " order mapping ✓ matched " + order.matched + "/" + order.total +
        " via '" + order.selector + "'", "color:#16a34a;font-weight:bold");
      return { matched: order.matched, total: order.total, selector: order.selector, strategy: "order" };
    }
    console.log(TAG, "order mapping unavailable (" + order.reason + "); falling back to text-prefix");

    if (!probeReport.length) return { matched: 0, total: normalized.messages.length };

    // --- Strategy B: text-prefix ---
    // Build a text-prefix index from API messages with non-empty text.
    var byPrefix = new Map();
    normalized.messages.forEach(function (m) {
      var key = normalizeText(m.text).slice(0, 60);
      if (key) byPrefix.set(key, m.uuid);
    });

    // Try text-prefix matching with EACH matched selector and report per-selector
    // hit rate, so we learn which selector actually identifies messages.
    var total = normalized.messages.length;
    var best = { selector: null, matched: 0, byUuid: null };
    probeReport.forEach(function (r) {
      var seen = new Set();
      var els = document.querySelectorAll(r.selector);
      Array.prototype.forEach.call(els, function (el) {
        var elText = normalizeText(el.textContent).slice(0, 60);
        if (!elText) return;
        var uuid = byPrefix.get(elText);
        if (uuid) seen.add(uuid);
      });
      console.log(TAG, "  text-prefix via '" + r.selector + "': " + seen.size + "/" + total);
      if (seen.size > best.matched) best = { selector: r.selector, matched: seen.size, byUuid: seen };
    });

    // Build the map from the best selector.
    map.clear();
    if (best.selector) {
      var winners = document.querySelectorAll(best.selector);
      Array.prototype.forEach.call(winners, function (el) {
        var elText = normalizeText(el.textContent).slice(0, 60);
        var uuid = byPrefix.get(elText);
        if (uuid && !map.has(uuid)) {
          el.setAttribute(DATA_UUID_ATTR, uuid);
          map.set(uuid, el);
        }
      });
    }

    console.log(TAG, "best selector '" + best.selector + "': matched " + best.matched + "/" + total);
    return { matched: best.matched, total: total, selector: best.selector };
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
