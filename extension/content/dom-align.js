/*
 * dom-align.js  —  align rendered DOM turns to active-branch messages (pure).
 *
 * The hard part of message↔element correlation, extracted as a PURE function so
 * it's unit-testable in Node (no DOM). dom-mapper.js does the DOM I/O (reading
 * turns, writing data-ctv-uuid, filling the Map) and delegates the matching here.
 *
 * Why this is non-trivial (confirmed empirically on a long, edited conversation):
 *   - Claude virtualizes off-screen turns, so the rendered turns are a SUBSET of
 *     the messages.
 *   - A single assistant message can render as SEVERAL `data-test-render-count`
 *     containers (thinking / artifacts / multiple text blocks), so turns are NOT
 *     1:1 with messages.
 *   - Assistant text is reformatted by the markdown renderer, so it can't be
 *     text-matched; only USER text is reliable.
 * A single forward pointer therefore desyncs the moment a message spans multiple
 * turns or a turn is virtualized — after which everything maps to the wrong
 * element. The fix anchors on reliable user text, then fills the bounded gaps.
 *
 * Loadable in Node (module.exports) and as a content script (window.CTV).
 */
(function (factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") {
    window.CTV = window.CTV || {};
    window.CTV.domAlign = api;
  }
})(function () {
  "use strict";

  // Reliable-enough text comparison for user turns: exact, or one a prefix of the
  // other (DOM vs API text can differ in trailing whitespace / truncation).
  function keyMatch(a, b) {
    if (!a || !b) return false;
    return a === b || a.indexOf(b) === 0 || b.indexOf(a) === 0;
  }

  // msgs:  [{ role:"human"|"assistant", key:string }]  active-branch order
  //          (key = normalized text for humans; ignored for assistants)
  // turns: [{ role:"human"|"assistant", key:string }]  document order
  // returns: number[] of length turns.length — mapping[turnIndex] = msgIndex | -1
  //
  // Pass 1: anchor each user turn to the next not-yet-used human message whose
  //   text matches, walking a monotonic pointer — so virtualized turns and
  //   multi-div assistants between anchors can't shift the anchors.
  // Pass 2: within each gap BOUNDED by consecutive anchors, fill the remaining
  //   turns to remaining messages by role + order (best effort). This recovers
  //   user turns whose text didn't match (e.g. attachment-only) and maps assistant
  //   messages, while keeping any error contained to its gap.
  function alignTurns(msgs, turns) {
    var n = turns.length;
    var mapping = new Array(n);
    for (var z = 0; z < n; z++) mapping[z] = -1;

    var usedMsg = {};
    var humanIdx = [];
    msgs.forEach(function (m, i) { if (m.role === "human") humanIdx.push(i); });

    // ---- pass 1: monotonic user-text anchors -------------------------------
    var anchors = []; // { t, m } in increasing order
    var hp = 0;
    for (var t = 0; t < n; t++) {
      if (turns[t].role !== "human") continue;
      var found = -1;
      for (var h = hp; h < humanIdx.length; h++) {
        if (keyMatch(msgs[humanIdx[h]].key, turns[t].key)) { found = h; break; }
      }
      if (found === -1) continue;
      var mi = humanIdx[found];
      mapping[t] = mi;
      usedMsg[mi] = true;
      anchors.push({ t: t, m: mi });
      hp = found + 1;
    }

    // ---- pass 2: role-respecting fill within bounded gaps ------------------
    function fillGap(tStart, tEnd, mStart, mEnd) {
      var mi = mStart;
      for (var tt = tStart; tt < tEnd; tt++) {
        if (mapping[tt] !== -1) continue;
        var pick = -1;
        for (var mm = mi; mm < mEnd; mm++) {
          if (!usedMsg[mm] && msgs[mm].role === turns[tt].role) { pick = mm; break; }
        }
        if (pick === -1) continue;
        mapping[tt] = pick;
        usedMsg[pick] = true;
        mi = pick + 1;
      }
    }

    var prevT = -1, prevM = -1;
    anchors.forEach(function (a) {
      fillGap(prevT + 1, a.t, prevM + 1, a.m);
      prevT = a.t;
      prevM = a.m;
    });
    fillGap(prevT + 1, n, prevM + 1, msgs.length);

    return mapping;
  }

  return { keyMatch: keyMatch, alignTurns: alignTurns };
});
