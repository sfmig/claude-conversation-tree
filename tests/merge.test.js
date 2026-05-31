"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const parser = require("../extension/content/parser.js");
const merge = require("../extension/content/merge.js");

// Build a small parsed tree:  root → A → B,  root → C
function fixture() {
  const messages = [
    { uuid: "m0", role: "human", text: "/child A\nq-a", index: 0 },
    { uuid: "m1", role: "assistant", text: "ans-a", index: 1 },
    { uuid: "m2", role: "human", text: "/child B\nq-b", index: 2 },   // B under A
    { uuid: "m3", role: "assistant", text: "ans-b", index: 3 },
    { uuid: "m4", role: "human", text: "/node C\nq-c", index: 4 },
    { uuid: "m5", role: "assistant", text: "ans-c", index: 5 }
  ];
  const parsed = parser.parseConversation({
    conversationId: "conv", conversationTitle: "Test", messages
  });
  // Resolve the generated node ids by title for readable tests.
  const ids = {};
  Object.values(parsed.tree.nodes).forEach((n) => { if (n.id !== parsed.rootNodeId) ids[n.title] = n.id; });
  ids.root = parsed.rootNodeId;
  return { parsed, ids };
}

test("empty overrides → merged tree equals parsed tree", () => {
  const { parsed } = fixture();
  const merged = merge.applyOverrides(parsed, merge.emptyOverrides());
  assert.deepEqual(merged.tree.nodes, parsed.tree.nodes);
  assert.deepEqual(merged.tree.messageIndex, parsed.tree.messageIndex);
});

test("merge passes the pointerNodeId through", () => {
  const { parsed } = fixture();
  const merged = merge.applyOverrides(parsed, merge.emptyOverrides());
  assert.equal(merged.pointerNodeId, parsed.pointerNodeId);
});

test("rename override wins and sets titleSource user-edited", () => {
  const { parsed, ids } = fixture();
  const merged = merge.applyOverrides(parsed, {
    nodeOverrides: { [ids.A]: { title: "Authentication" } },
    messageOverrides: {}
  });
  assert.equal(merged.tree.nodes[ids.A].title, "Authentication");
  assert.equal(merged.tree.nodes[ids.A].titleSource, "user-edited");
});

test("reparent override moves a node and updates childIds both sides", () => {
  const { parsed, ids } = fixture();
  // Move B from A to C.
  const merged = merge.applyOverrides(parsed, {
    nodeOverrides: { [ids.B]: { parentId: ids.C } },
    messageOverrides: {}
  });
  assert.equal(merged.tree.nodes[ids.B].parentId, ids.C);
  assert.ok(merged.tree.nodes[ids.C].childIds.includes(ids.B));
  assert.ok(!merged.tree.nodes[ids.A].childIds.includes(ids.B));
});

test("reparent that would create a cycle is rejected", () => {
  const { parsed, ids } = fixture();
  // Try to move A under B (B is A's descendant) → cycle, must be skipped.
  const merged = merge.applyOverrides(parsed, {
    nodeOverrides: { [ids.A]: { parentId: ids.B } },
    messageOverrides: {}
  });
  assert.equal(merged.tree.nodes[ids.A].parentId, ids.root);
});

test("delete override removes node; children + messages promote to parent (root here)", () => {
  const { parsed, ids } = fixture();
  const merged = merge.applyOverrides(parsed, {
    nodeOverrides: { [ids.A]: { deleted: true } },
    messageOverrides: {}
  });
  assert.equal(ids.A in merged.tree.nodes, false);
  // B (A's child) promotes to A's parent — which is root here
  assert.equal(merged.tree.nodes[ids.B].parentId, ids.root);
  assert.ok(merged.tree.nodes[ids.root].childIds.includes(ids.B));
  // A's messages (m0, m1) moved to root
  assert.equal(merged.tree.messageIndex["m0"], ids.root);
  assert.equal(merged.tree.messageIndex["m1"], ids.root);
});

test("delete promotes children to the deleted node's PARENT, not all the way to root", () => {
  // root → A → B → D
  const messages = [
    { uuid: "m0", role: "human", text: "/child A\na", index: 0 },
    { uuid: "m1", role: "human", text: "/child B\nb", index: 1 }, // B under A
    { uuid: "m2", role: "human", text: "/child D\nd", index: 2 }  // D under B
  ];
  const parsed = parser.parseConversation({ conversationId: "c", conversationTitle: "T", messages });
  const ids = {};
  Object.values(parsed.tree.nodes).forEach((n) => { if (n.id !== parsed.rootNodeId) ids[n.title] = n.id; });

  const merged = merge.applyOverrides(parsed, {
    nodeOverrides: { [ids.B]: { deleted: true } },
    messageOverrides: {}
  });
  assert.equal(ids.B in merged.tree.nodes, false);
  // D promotes to A (B's parent), NOT to root
  assert.equal(merged.tree.nodes[ids.D].parentId, ids.A);
  assert.ok(merged.tree.nodes[ids.A].childIds.includes(ids.D));
  assert.ok(!merged.tree.nodes[parsed.rootNodeId].childIds.includes(ids.D));
  // B's message m1 promotes to A
  assert.equal(merged.tree.messageIndex["m1"], ids.A);
});

test("reparent + delete together: messages promote to the NEW parent, not root", () => {
  const { parsed, ids } = fixture(); // root → A → B, root → C
  // Move B under C, and delete B → B's messages (m2,m3) should land on C.
  const merged = merge.applyOverrides(parsed, {
    nodeOverrides: { [ids.B]: { parentId: ids.C, deleted: true } },
    messageOverrides: {}
  });
  assert.equal(ids.B in merged.tree.nodes, false);
  assert.equal(merged.tree.messageIndex["m2"], ids.C);
  assert.equal(merged.tree.messageIndex["m3"], ids.C);
  // and NOT on root
  assert.ok(!merged.tree.nodes[ids.root].messageUuids.includes("m2"));
});

test("never delete or move the root", () => {
  const { parsed, ids } = fixture();
  const merged = merge.applyOverrides(parsed, {
    nodeOverrides: { [ids.root]: { deleted: true, parentId: ids.A } },
    messageOverrides: {}
  });
  assert.ok(ids.root in merged.tree.nodes);
  assert.equal(merged.tree.nodes[ids.root].parentId, null);
});

test("message override reassigns a single message", () => {
  const { parsed, ids } = fixture();
  // Move m1 (currently under A) to C.
  const merged = merge.applyOverrides(parsed, {
    nodeOverrides: {},
    messageOverrides: { m1: { nodeId: ids.C } }
  });
  assert.equal(merged.tree.messageIndex["m1"], ids.C);
  assert.ok(merged.tree.nodes[ids.C].messageUuids.includes("m1"));
  assert.ok(!merged.tree.nodes[ids.A].messageUuids.includes("m1"));
});

test("orphaned overrides (node/message gone) are dropped silently", () => {
  const { parsed } = fixture();
  const merged = merge.applyOverrides(parsed, {
    nodeOverrides: { "node_gone": { title: "x", parentId: "node_also_gone", deleted: true } },
    messageOverrides: { "m_gone": { nodeId: "node_gone" } }
  });
  // unchanged vs empty-merge
  const baseline = merge.applyOverrides(parsed, merge.emptyOverrides());
  assert.deepEqual(merged.tree.nodes, baseline.tree.nodes);
});

test("merge is idempotent for the same input", () => {
  const { parsed, ids } = fixture();
  const ov = {
    nodeOverrides: { [ids.A]: { title: "Auth" }, [ids.B]: { parentId: ids.C } },
    messageOverrides: { m5: { nodeId: ids.root } }
  };
  const a = merge.applyOverrides(parsed, ov);
  const b = merge.applyOverrides(parsed, ov);
  assert.deepEqual(a, b);
});
