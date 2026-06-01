"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const N = require("../extension/content/api-normalize.js");

const ROOT_SENTINEL = "00000000-0000-4000-8000-000000000000";

// Build a raw Claude-shaped message. `content` blocks hold the prose.
function msg(uuid, parent, sender, text, index) {
  return {
    uuid: uuid,
    parent_message_uuid: parent,
    sender: sender,
    content: [{ type: "text", text: text }],
    text: "",
    index: index
  };
}

// ---- extractText ----------------------------------------------------------

test("extractText: joins content[] text blocks", () => {
  assert.strictEqual(
    N.extractText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], text: "" }),
    "a\nb"
  );
});

test("extractText: falls back to top-level text when content is empty", () => {
  assert.strictEqual(N.extractText({ content: [], text: "hello" }), "hello");
});

test("extractText: prefers whichever field has more text", () => {
  assert.strictEqual(N.extractText({ content: [{ type: "text", text: "longer block" }], text: "hi" }), "longer block");
});

// ---- selectActiveBranch: leaf walk ----------------------------------------

test("selectActiveBranch: walks up from the leaf, returns root→leaf order", () => {
  // A linear chain a → b → c, given out of order.
  const arr = [
    msg("c", "b", "assistant", "C", 2),
    msg("a", ROOT_SENTINEL, "human", "A", 0),
    msg("b", "a", "assistant", "B", 1)
  ];
  const branch = N.selectActiveBranch(arr, "c");
  assert.deepStrictEqual(branch.map((m) => m.uuid), ["a", "b", "c"]);
});

test("selectActiveBranch: drops off-branch (superseded/edited) messages", () => {
  // a → b → c is the active branch; b2 is an edit of b (sibling), b2 → c2 a
  // regenerated reply. current leaf = c, so b2/c2 must be excluded.
  const arr = [
    msg("a", ROOT_SENTINEL, "human", "A", 0),
    msg("b", "a", "human", "B original", 1),
    msg("c", "b", "assistant", "C", 2),
    msg("b2", "a", "human", "B edited /child Topic", 3),
    msg("c2", "b2", "assistant", "C2", 4)
  ];
  const branch = N.selectActiveBranch(arr, "c");
  assert.deepStrictEqual(branch.map((m) => m.uuid), ["a", "b", "c"]);
});

test("selectActiveBranch: selecting the edited leaf yields the edited branch", () => {
  // Same tree, but the user is viewing the edit: leaf = c2 → active is a,b2,c2.
  const arr = [
    msg("a", ROOT_SENTINEL, "human", "A", 0),
    msg("b", "a", "human", "B original", 1),
    msg("c", "b", "assistant", "C", 2),
    msg("b2", "a", "human", "B edited", 3),
    msg("c2", "b2", "assistant", "C2", 4)
  ];
  const branch = N.selectActiveBranch(arr, "c2");
  assert.deepStrictEqual(branch.map((m) => m.uuid), ["a", "b2", "c2"]);
});

test("selectActiveBranch: tolerates a cyclic parent link without hanging", () => {
  const arr = [
    msg("a", "b", "human", "A", 0),
    msg("b", "a", "assistant", "B", 1)
  ];
  const branch = N.selectActiveBranch(arr, "b");
  // Each node visited at most once; no infinite loop.
  assert.deepStrictEqual(branch.map((m) => m.uuid), ["a", "b"]);
});

// ---- selectActiveBranch: fallback -----------------------------------------

test("selectActiveBranch: no leaf pointer → sorts by index", () => {
  const arr = [
    msg("c", "b", "assistant", "C", 2),
    msg("a", ROOT_SENTINEL, "human", "A", 0),
    msg("b", "a", "assistant", "B", 1)
  ];
  const branch = N.selectActiveBranch(arr, null);
  assert.deepStrictEqual(branch.map((m) => m.uuid), ["a", "b", "c"]);
});

test("selectActiveBranch: unknown leaf uuid → falls back to index sort", () => {
  const arr = [
    msg("b", "a", "assistant", "B", 1),
    msg("a", ROOT_SENTINEL, "human", "A", 0)
  ];
  const branch = N.selectActiveBranch(arr, "does-not-exist");
  assert.deepStrictEqual(branch.map((m) => m.uuid), ["a", "b"]);
});

// ---- normalize ------------------------------------------------------------

test("normalize: returns active branch with re-stamped sequential index", () => {
  const body = {
    current_leaf_message_uuid: "c",
    chat_messages: [
      msg("a", ROOT_SENTINEL, "human", "A", 0),
      msg("b", "a", "human", "B", 1),
      msg("c", "b", "assistant", "C", 2),
      msg("b2", "a", "human", "B edit", 7),
      msg("c2", "b2", "assistant", "C2", 9)
    ]
  };
  const out = N.normalize(body);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.count, 3);
  assert.strictEqual(out.rawCount, 5);
  assert.strictEqual(out.activeBranchVia, "current_leaf_message_uuid");
  assert.deepStrictEqual(out.messages.map((m) => m.uuid), ["a", "b", "c"]);
  // index re-stamped as branch position regardless of the raw index values.
  assert.deepStrictEqual(out.messages.map((m) => m.index), [0, 1, 2]);
  assert.deepStrictEqual(out.messages.map((m) => m.role), ["human", "human", "assistant"]);
  assert.strictEqual(out.messages[2].text, "C");
});

test("normalize: no leaf field → index-sort fallback, reports it", () => {
  const body = {
    chat_messages: [
      msg("b", "a", "assistant", "B", 1),
      msg("a", ROOT_SENTINEL, "human", "A", 0)
    ]
  };
  const out = N.normalize(body);
  assert.strictEqual(out.activeBranchVia, "index-sort fallback");
  assert.deepStrictEqual(out.messages.map((m) => m.uuid), ["a", "b"]);
});

test("normalize: tolerates alternate field names (messages / parentMessageUuid / role)", () => {
  const body = {
    currentLeafMessageUuid: "b",
    messages: [
      { id: "a", parentMessageUuid: ROOT_SENTINEL, role: "human", content: [{ type: "text", text: "A" }] },
      { id: "b", parentMessageUuid: "a", role: "assistant", content: [{ type: "text", text: "B" }] }
    ]
  };
  const out = N.normalize(body);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.arrayField, "messages");
  assert.deepStrictEqual(out.messages.map((m) => m.uuid), ["a", "b"]);
  assert.deepStrictEqual(out.messages.map((m) => m.parentUuid), [ROOT_SENTINEL, "a"]);
});

test("normalize: rejects a payload with no recognised message array", () => {
  const out = N.normalize({ uuid: "x", name: "no messages here" });
  assert.strictEqual(out.ok, false);
  assert.ok(Array.isArray(out.topLevelKeys));
});

test("normalize: null/non-object body → null", () => {
  assert.strictEqual(N.normalize(null), null);
  assert.strictEqual(N.normalize("nope"), null);
});
