"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const { alignTurns, keyMatch } = require("../extension/content/dom-align.js");

// Helpers to build the aligner's input contract concisely.
function h(key) { return { role: "human", key: key }; }
function a() { return { role: "assistant", key: "" }; }

// ---- keyMatch -------------------------------------------------------------

test("keyMatch: exact, prefix-either-way, and non-match", () => {
  assert.strictEqual(keyMatch("hello", "hello"), true);
  assert.strictEqual(keyMatch("hello world", "hello"), true);
  assert.strictEqual(keyMatch("hello", "hello world"), true);
  assert.strictEqual(keyMatch("hello", "goodbye"), false);
  assert.strictEqual(keyMatch("", "x"), false);
});

// ---- clean 1:1 conversation ----------------------------------------------

test("clean alternating conversation → identity mapping", () => {
  const msgs = [h("q1"), a(), h("q2"), a()];
  const turns = [h("q1"), a(), h("q2"), a()];
  assert.deepStrictEqual(alignTurns(msgs, turns), [0, 1, 2, 3]);
});

// ---- virtualization: rendered turns are a subset --------------------------

test("virtualized leading turns → later turns still map correctly", () => {
  // Only the last exchange is rendered (first q1/a virtualized away).
  const msgs = [h("q1"), a(), h("q2"), a()];
  const turns = [h("q2"), a()];
  assert.deepStrictEqual(alignTurns(msgs, turns), [2, 3]);
});

test("a virtualized human in the middle does not desync the rest", () => {
  const msgs = [h("q1"), a(), h("q2"), a(), h("q3"), a()];
  // q2's turn is missing (virtualized); its assistant reply still renders.
  const turns = [h("q1"), a(), a(), h("q3"), a()];
  const out = alignTurns(msgs, turns);
  // q1→0, a→1, the orphaned assistant fills to msg 3 (q2's reply), q3→4, a→5.
  assert.deepStrictEqual(out, [0, 1, 3, 4, 5]);
});

// ---- multi-div assistant messages ----------------------------------------

test("assistant message rendered as multiple divs → first div maps, extras unmapped, no desync", () => {
  const msgs = [h("q1"), a(), h("q2"), a()];
  // First assistant reply renders as TWO containers.
  const turns = [h("q1"), a(), a(), h("q2"), a()];
  const out = alignTurns(msgs, turns);
  // q1→0, assistant msg1→first div, second assistant div has no remaining
  // assistant msg in the gap (bounded by q2 anchor) → -1; q2→2, a→3.
  assert.deepStrictEqual(out, [0, 1, -1, 2, 3]);
});

// ---- unmatched user turn recovered by the gap fill ------------------------

test("user turn whose text didn't match (e.g. attachment-only) is recovered by role-order fill", () => {
  const msgs = [h("q1"), a(), h("q2"), a(), h("q3"), a()];
  // The middle user turn renders but its text doesn't match (key "???").
  const turns = [h("q1"), a(), h("???"), a(), h("q3"), a()];
  const out = alignTurns(msgs, turns);
  // q1→0, a→1; the "???" human turn is anchored to nothing in pass 1, but the
  // gap between q1 and q3 contains human q2 → recovered to 2; its a→3; q3→4, a→5.
  assert.deepStrictEqual(out, [0, 1, 2, 3, 4, 5]);
});

// ---- duplicate user text --------------------------------------------------

test("duplicate user texts are matched in order (monotonic), never crossing", () => {
  const msgs = [h("ok"), a(), h("ok"), a()];
  const turns = [h("ok"), a(), h("ok"), a()];
  assert.deepStrictEqual(alignTurns(msgs, turns), [0, 1, 2, 3]);
});

// ---- trailing assistant with no remaining message → unmapped --------------

test("extra trailing turn with no remaining message stays unmapped", () => {
  const msgs = [h("q1"), a()];
  const turns = [h("q1"), a(), a()];
  assert.deepStrictEqual(alignTurns(msgs, turns), [0, 1, -1]);
});

// ---- no human anchors at all (degenerate) ---------------------------------

test("no matching human anchors → fill maps nothing across the whole span by role", () => {
  // All-assistant turns with all-assistant messages: filled in order.
  const msgs = [a(), a()];
  const turns = [a(), a()];
  assert.deepStrictEqual(alignTurns(msgs, turns), [0, 1]);
});

test("empty turns → empty mapping", () => {
  assert.deepStrictEqual(alignTurns([h("q1"), a()], []), []);
});
