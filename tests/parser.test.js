"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const parser = require("../extension/content/parser.js");
const { parseConversation, extractMarkers, ROOT_ID } = parser;

// ---- helpers ---------------------------------------------------------------

let uuidCounter = 0;
function msg(role, text) {
  return { uuid: "msg_" + ++uuidCounter, role, text, index: uuidCounter - 1 };
}
function human(text) { return msg("human", text); }
function assistant(text) { return msg("assistant", text); }

function run(messages, opts) {
  uuidCounter = 0; // deterministic uuids per conversation
  messages.forEach((m, i) => { m.uuid = "msg_" + i; m.index = i; });
  return parseConversation(
    Object.assign({ conversationId: "conv_test", conversationTitle: "Test", messages }, opts)
  );
}

function node(result, id) { return result.tree.nodes[id]; }
function childTitles(result, parentId) {
  return node(result, parentId).childIds.map((id) => node(result, id).title);
}

// ---- extractMarkers (unit) -------------------------------------------------

test("extractMarkers: recognises a structural marker with a name", () => {
  const r = extractMarkers("/child Authentication design");
  assert.equal(r.markers.length, 1);
  assert.deepEqual(r.markers[0], { command: "child", arg: "Authentication design", lineIndex: 0 });
  assert.equal(r.hasContent, false);
});

test("extractMarkers: marker plus trailing content on later lines", () => {
  const r = extractMarkers("/child Auth\nHow do I do JWT refresh?");
  assert.equal(r.markers.length, 1);
  assert.equal(r.hasContent, true);
  assert.equal(r.contentText, "How do I do JWT refresh?");
});

test("extractMarkers: unknown command is plain text, not a marker", () => {
  const r = extractMarkers("/siblng typo");
  assert.equal(r.markers.length, 0);
  assert.equal(r.hasContent, true);
  assert.equal(r.contentText, "/siblng typo");
});

test("extractMarkers: leading whitespace means it is NOT a marker", () => {
  const r = extractMarkers("  /child Indented");
  assert.equal(r.markers.length, 0);
  assert.equal(r.hasContent, true);
});

test("extractMarkers: multiple markers in order", () => {
  const r = extractMarkers("/child A\n/child B\n/parent");
  assert.deepEqual(r.markers.map((m) => m.command), ["child", "child", "parent"]);
  assert.equal(r.hasContent, false);
});

test("extractMarkers: a slash inside prose mid-line is not a marker", () => {
  const r = extractMarkers("use the path a/b/child for the route");
  assert.equal(r.markers.length, 0);
  assert.equal(r.hasContent, true);
});

// ---- structural parsing ----------------------------------------------------

test("no markers: every content message lands under root", () => {
  const r = run([human("hello"), assistant("hi"), human("bye")]);
  assert.deepEqual(node(r, ROOT_ID).messageUuids, ["msg_0", "msg_1", "msg_2"]);
  assert.equal(r.tree.messageIndex["msg_1"], ROOT_ID);
  assert.equal(node(r, ROOT_ID).childIds.length, 0);
});

test("/child creates a child and moves the pointer into it", () => {
  const r = run([
    human("/child Auth\nhow does login work?"),
    assistant("it uses JWT")
  ]);
  const childId = node(r, ROOT_ID).childIds[0];
  const child = node(r, childId);
  assert.equal(child.title, "Auth");
  assert.equal(child.titleSource, "marker");
  assert.equal(child.parentId, ROOT_ID);
  // both the user content line and the assistant reply attach to the child
  assert.deepEqual(child.messageUuids, ["msg_0", "msg_1"]);
});

test("/child with no name uses the fallback title", () => {
  const r = run([human("/child"), assistant("x")]);
  const child = node(r, node(r, ROOT_ID).childIds[0]);
  assert.equal(child.title, "Untitled topic");
  assert.equal(child.titleSource, "fallback");
});

test("/sibling under a child shares the same parent", () => {
  const r = run([
    human("/child A\ncontent a"),
    human("/sibling B\ncontent b")
  ]);
  // A and B are both children of root
  assert.deepEqual(childTitles(r, ROOT_ID), ["A", "B"]);
});

test("/sibling at root becomes a top-level topic under root", () => {
  const r = run([human("/sibling Top\ncontent")]);
  assert.deepEqual(childTitles(r, ROOT_ID), ["Top"]);
  const top = node(r, node(r, ROOT_ID).childIds[0]);
  assert.equal(top.parentId, ROOT_ID);
});

test("/parent moves the pointer up; content then lands on the parent", () => {
  const r = run([
    human("/child A\ncontent a"),
    human("/parent\nback at root level")
  ]);
  const aId = node(r, ROOT_ID).childIds[0];
  assert.deepEqual(node(r, aId).messageUuids, ["msg_0"]);
  assert.deepEqual(node(r, ROOT_ID).messageUuids, ["msg_1"]);
});

test("/parent from root is a no-op", () => {
  const r = run([human("/parent\nstill root")]);
  assert.equal(r.tree.messageIndex["msg_0"], ROOT_ID);
  assert.equal(Object.keys(r.tree.nodes).length, 1);
});

test("/root jumps back from a deep node", () => {
  const r = run([
    human("/child A\na"),
    human("/child B\nb"),     // B is child of A
    human("/root\nhome")
  ]);
  assert.equal(r.tree.messageIndex["msg_2"], ROOT_ID);
});

test("/root when already at root is a no-op", () => {
  const r = run([human("/root\nhi")]);
  assert.equal(r.tree.messageIndex["msg_0"], ROOT_ID);
});

test("nesting: /child then /child builds a grandchild chain", () => {
  const r = run([
    human("/child A\na"),
    human("/child B\nb")
  ]);
  const aId = node(r, ROOT_ID).childIds[0];
  const bId = node(r, aId).childIds[0];
  assert.equal(node(r, aId).title, "A");
  assert.equal(node(r, bId).title, "B");
  assert.equal(node(r, bId).parentId, aId);
});

test("multiple markers in one message apply in order before content", () => {
  const r = run([
    human("/child A\na"),
    human("/child B\n/parent\nin A again")
  ]);
  const aId = node(r, ROOT_ID).childIds[0];
  // message 1 created B (child of A), then /parent moved back to A; content → A
  assert.deepEqual(node(r, aId).messageUuids, ["msg_0", "msg_1"]);
});

// ---- assistant messages are not scanned ------------------------------------

test("markers in assistant messages are treated as plain content", () => {
  const r = run([
    human("/child A\na"),
    assistant("/child should NOT branch\nsome answer")
  ]);
  const aId = node(r, ROOT_ID).childIds[0];
  assert.equal(node(r, ROOT_ID).childIds.length, 1); // no extra node
  assert.deepEqual(node(r, aId).messageUuids, ["msg_0", "msg_1"]);
});

// ---- pure-marker messages --------------------------------------------------

test("a marker-only message is not attached to any node", () => {
  const r = run([
    human("first"),
    human("/child A"),       // pure marker, no content
    human("inside A")
  ]);
  const aId = node(r, ROOT_ID).childIds[0];
  assert.deepEqual(node(r, ROOT_ID).messageUuids, ["msg_0"]);
  assert.deepEqual(node(r, aId).messageUuids, ["msg_2"]);
  assert.equal("msg_1" in r.tree.messageIndex, false);
});

// ---- bookmarks -------------------------------------------------------------

test("/star bookmarks the previous (received) message", () => {
  const r = run([
    human("question"),
    assistant("great answer"),
    human("/star")
  ]);
  const bms = Object.values(r.bookmarks);
  assert.equal(bms.length, 1);
  assert.equal(bms[0].messageUuid, "msg_1"); // the assistant answer
  assert.equal(bms[0].nodeId, ROOT_ID);
  assert.equal(bms[0].note, "");
  assert.equal(bms[0].source, "marker");
});

test("/bookmark carries a note", () => {
  const r = run([
    human("q"),
    assistant("a"),
    human("/bookmark good JWT explanation")
  ]);
  const bms = Object.values(r.bookmarks);
  assert.equal(bms[0].note, "good JWT explanation");
});

test("/star as the very first message is skipped silently", () => {
  const r = run([human("/star"), human("hello")]);
  assert.equal(Object.keys(r.bookmarks).length, 0);
});

// ---- stable ids & idempotency ----------------------------------------------

test("node ids are stable across re-parses of identical input", () => {
  const build = () => run([human("/child Auth\na"), human("/child Tokens\nb")]);
  const a = build();
  const b = build();
  assert.deepEqual(Object.keys(a.tree.nodes).sort(), Object.keys(b.tree.nodes).sort());
});

test("parsing is idempotent (byte-identical output for identical input)", () => {
  const messages = [
    human("/child A\nq1"),
    assistant("a1"),
    human("/sibling B\nq2"),
    assistant("a2"),
    human("/star")
  ];
  const a = run(messages.map((m) => ({ ...m })));
  const b = run(messages.map((m) => ({ ...m })));
  assert.deepEqual(a, b);
});

test("two markers in the same message produce distinct node ids (lineIndex)", () => {
  const r = run([human("/child A\n/child B")]);
  const ids = Object.keys(r.tree.nodes).filter((id) => id !== ROOT_ID);
  assert.equal(new Set(ids).size, 2);
});

test("root node shape is well-formed", () => {
  const r = run([human("hi")]);
  const root = node(r, ROOT_ID);
  assert.equal(root.parentId, null);
  assert.equal(root.title, "Test");
  assert.deepEqual(Object.keys(root).sort(), [
    "childIds", "collapsed", "createdAt", "id", "messageUuids", "parentId", "title", "titleSource"
  ]);
});

// ---- name-based resolution (re-entering nodes) -----------------------------

test("re-using /child <name> under the same parent re-enters the node (no duplicate)", () => {
  const r = run([
    human("/child Auth\nq1"),
    assistant("a1"),
    human("/root\nsomething at root"),
    human("/child Auth\nq2 — added later"),   // should RE-ENTER the first Auth
    assistant("a2")
  ]);
  // only one Auth node under root
  assert.equal(childTitles(r, ROOT_ID).filter((t) => t === "Auth").length, 1);
  const authId = node(r, ROOT_ID).childIds.find((id) => node(r, id).title === "Auth");
  // both early and late messages live in the same node
  assert.deepEqual(node(r, authId).messageUuids, ["msg_0", "msg_1", "msg_3", "msg_4"]);
});

test("name matching is case-insensitive and trimmed", () => {
  const r = run([
    human("/child Authentication\nq1"),
    human("/root\n/child   authentication  \nq2")  // different case + spaces
  ]);
  assert.equal(node(r, ROOT_ID).childIds.length, 1);
  const id = node(r, ROOT_ID).childIds[0];
  assert.equal(node(r, id).title, "Authentication"); // first occurrence's casing kept
  assert.deepEqual(node(r, id).messageUuids, ["msg_0", "msg_1"]);
});

test("same name under DIFFERENT parents are distinct nodes", () => {
  const r = run([
    human("/child A\n/child Notes\nq1"),       // Notes under A
    human("/root\n/child B\n/child Notes\nq2")  // Notes under B
  ]);
  const aId = node(r, ROOT_ID).childIds.find((id) => node(r, id).title === "A");
  const bId = node(r, ROOT_ID).childIds.find((id) => node(r, id).title === "B");
  const notesUnderA = node(r, aId).childIds[0];
  const notesUnderB = node(r, bId).childIds[0];
  assert.notEqual(notesUnderA, notesUnderB);
  assert.equal(node(r, notesUnderA).title, "Notes");
  assert.equal(node(r, notesUnderB).title, "Notes");
});

test("unnamed topics are always new (cannot be re-entered by name)", () => {
  const r = run([
    human("/child\nq1"),
    human("/root\n/child\nq2")
  ]);
  // two distinct Untitled topics under root
  assert.equal(node(r, ROOT_ID).childIds.length, 2);
});

test("re-entered node keeps a stable id across re-parses", () => {
  const build = () => run([
    human("/child Auth\nq1"),
    human("/root\n/child Auth\nq2")
  ]);
  const a = build();
  const b = build();
  assert.deepEqual(Object.keys(a.tree.nodes).sort(), Object.keys(b.tree.nodes).sort());
});

// ---- a fuller fixture ------------------------------------------------------

test("realistic conversation parses into the expected topic tree", () => {
  const r = run([
    human("/child Auth\nhow should I store sessions?"),
    assistant("use httpOnly cookies"),
    human("/child Tokens\nwhat about refresh tokens?"),   // child of Auth
    assistant("rotate them"),
    human("/star"),                                        // bookmark the rotate answer
    human("/parent\nback to Auth: rate limiting?"),        // back up to Auth
    assistant("use a token bucket"),
    human("/root\n/sibling Deployment\nhow to ship?"),     // new top-level topic
    assistant("use a container")
  ]);

  const authId = node(r, ROOT_ID).childIds[0];
  assert.equal(node(r, authId).title, "Auth");
  const tokensId = node(r, authId).childIds[0];
  assert.equal(node(r, tokensId).title, "Tokens");

  // "back to Auth" content + its assistant reply attach to Auth
  assert.ok(node(r, authId).messageUuids.includes("msg_5"));
  assert.ok(node(r, authId).messageUuids.includes("msg_6"));

  // Deployment is a top-level sibling under root
  const deployId = node(r, ROOT_ID).childIds[1];
  assert.equal(node(r, deployId).title, "Deployment");

  // one bookmark, on the "rotate them" assistant message
  const bms = Object.values(r.bookmarks);
  assert.equal(bms.length, 1);
  assert.equal(bms[0].messageUuid, "msg_3");
  assert.equal(bms[0].nodeId, tokensId);
});
