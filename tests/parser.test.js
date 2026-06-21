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

test("extractMarkers: a whitespace-preceded command IS a marker (content before it)", () => {
  // Indented/leading-space command is now a marker (the trailing-tag rule treats
  // any whitespace-preceded command token as the content↔marker boundary).
  const r = extractMarkers("  /child Indented");
  assert.deepEqual(r.markers, [{ command: "child", arg: "Indented", lineIndex: 0 }]);
  assert.equal(r.hasContent, false);
});

test("extractMarkers: multiple markers in order", () => {
  const r = extractMarkers("/node A\n/child B\n/sibling C");
  assert.deepEqual(r.markers.map((m) => m.command), ["node", "child", "sibling"]);
  assert.equal(r.hasContent, false);
});

test("extractMarkers: a slash inside prose mid-line is not a marker", () => {
  const r = extractMarkers("use the path a/b/child for the route");
  assert.equal(r.markers.length, 0);
  assert.equal(r.hasContent, true);
});

test("extractMarkers: /up N prefix + a marker on the same line", () => {
  const r = extractMarkers("/up 2 /child TOPIC");
  assert.deepEqual(r.markers, [
    { command: "up", arg: "2", lineIndex: 0 },
    { command: "child", arg: "TOPIC", lineIndex: 0 }
  ]);
  assert.equal(r.hasContent, false);
});

test("extractMarkers: /up alone on a line", () => {
  const r = extractMarkers("/up");
  assert.deepEqual(r.markers, [{ command: "up", arg: "", lineIndex: 0 }]);
  assert.equal(r.hasContent, false);
});

test("extractMarkers: /update... is not an /up marker", () => {
  const r = extractMarkers("/update the config");
  assert.equal(r.markers.length, 0);
  assert.equal(r.hasContent, true);
});

test("extractMarkers: trailing marker — content before, marker after", () => {
  const r = extractMarkers("how do refresh tokens work? /node Auth > Tokens");
  assert.deepEqual(r.markers, [{ command: "node", arg: "Auth > Tokens", lineIndex: 0 }]);
  assert.equal(r.contentText, "how do refresh tokens work?");
  assert.equal(r.hasContent, true);
});

test("extractMarkers: trailing /up [N] (+ create) after content", () => {
  const r = extractMarkers("some question /up 2 /child Rollback");
  assert.deepEqual(r.markers, [
    { command: "up", arg: "2", lineIndex: 0 },
    { command: "child", arg: "Rollback", lineIndex: 0 }
  ]);
  assert.equal(r.contentText, "some question");
});

test("extractMarkers: a path/URL (slash not whitespace-preceded) stays content", () => {
  const r = extractMarkers("use a/b/node here");
  assert.equal(r.markers.length, 0);
  assert.equal(r.contentText, "use a/b/node here");
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

test("empty /node returns to root; content then lands on root", () => {
  const r = run([
    human("/child A\ncontent a"),
    human("/node\nback at root level")
  ]);
  const aId = node(r, ROOT_ID).childIds[0];
  assert.deepEqual(node(r, aId).messageUuids, ["msg_0"]);
  assert.deepEqual(node(r, ROOT_ID).messageUuids, ["msg_1"]);
});

test("empty /node at root is a no-op (stays root)", () => {
  const r = run([human("/node\nstill root")]);
  assert.equal(r.tree.messageIndex["msg_0"], ROOT_ID);
  assert.equal(Object.keys(r.tree.nodes).length, 1);
});

// ---- /up (relative pointer move) -------------------------------------------

test("/up moves to the parent; content lands there", () => {
  const r = run([
    human("/node A > B\nb"),   // pointer at B
    human("/up\nat A now")     // up to A
  ]);
  const aId = node(r, ROOT_ID).childIds[0];
  const bId = node(r, aId).childIds[0];
  assert.deepEqual(node(r, bId).messageUuids, ["msg_0"]);
  assert.deepEqual(node(r, aId).messageUuids, ["msg_1"]);
});

test("/up at root is a no-op", () => {
  const r = run([human("/up\nstill root")]);
  assert.equal(r.tree.messageIndex["msg_0"], ROOT_ID);
});

test("/up N moves up N levels; over-deep clamps at root", () => {
  const r = run([
    human("/node A > B > C\nc"),
    human("/up 2\nat A"),
    human("/node A > B > C\nc2"),
    human("/up 9\nat root")
  ]);
  const aId = node(r, ROOT_ID).childIds[0];
  assert.equal(r.tree.messageIndex["msg_1"], aId);     // up 2 from C → A
  assert.equal(r.tree.messageIndex["msg_3"], ROOT_ID); // up 9 → clamps to root
});

test("/up N + /child on one line: up then create under that ancestor", () => {
  const r = run([
    human("/node A > B > C\nc"),
    human("/up 2 /child D\nd")   // up to A, then child D under A
  ]);
  const aId = node(r, ROOT_ID).childIds[0];
  const dId = node(r, aId).childIds.find((id) => node(r, id).title === "D");
  assert.ok(dId);
  assert.deepEqual(node(r, dId).messageUuids, ["msg_1"]);
  assert.equal(r.pointerNodeId, dId);
});

test("/up /sibling on one line: up one then sibling", () => {
  const r = run([
    human("/node A > B\nb"),
    human("/up /sibling X\nx")   // up to A, sibling of A (top-level), create X
  ]);
  assert.deepEqual(childTitles(r, ROOT_ID).sort(), ["A", "X"]);
});

test("chained /up on one line is NOT supported (no double move)", () => {
  const r = run([
    human("/node A > B\nb"),
    human("/up /up /child D\nd")  // only the first /up applies; rest is content
  ]);
  const aId = node(r, ROOT_ID).childIds[0];
  const bId = node(r, aId).childIds[0];
  // pointer went up exactly one (B → A); no D was created
  assert.equal(node(r, aId).childIds.filter((id) => node(r, id).title === "D").length, 0);
  assert.equal(r.tree.messageIndex["msg_1"], aId);
});

test("/root is no longer a marker (plain text)", () => {
  const r = run([human("/root\nhi")]);
  assert.equal(node(r, ROOT_ID).messageUuids.length, 1); // whole message is content
  assert.equal(Object.keys(r.tree.nodes).length, 1);
});

// ---- trailing markers (marker at end of a line) ----------------------------

test("trailing /node: the message lands under the tagged topic", () => {
  const r = run([
    human("how do refresh tokens work? /node Auth > Tokens"),
    assistant("rotate them")
  ]);
  const authId = node(r, ROOT_ID).childIds[0];
  const tokensId = node(r, authId).childIds[0];
  assert.equal(node(r, tokensId).title, "Tokens");
  // both the user question and the assistant reply attach to Tokens
  assert.deepEqual(node(r, tokensId).messageUuids, ["msg_0", "msg_1"]);
  assert.equal(r.pointerNodeId, tokensId);
});

test("trailing tag on a multi-line message", () => {
  const r = run([human("line one\nline two /node X")]);
  const xId = node(r, ROOT_ID).childIds[0];
  assert.equal(node(r, xId).title, "X");
  // both content lines attach to X
  assert.deepEqual(node(r, xId).messageUuids, ["msg_0"]);
  assert.equal(r.tree.messageIndex["msg_0"], xId);
});

test("trailing /up N + /child: up then create, message under the new node", () => {
  const r = run([
    human("/node A > B > C\nc"),
    human("what's the rollback plan? /up 2 /child Rollback")
  ]);
  const aId = node(r, ROOT_ID).childIds[0];
  const rb = node(r, aId).childIds.find((id) => node(r, id).title === "Rollback");
  assert.ok(rb);
  assert.deepEqual(node(r, rb).messageUuids, ["msg_1"]);
});

test("leading own-line markers still behave as before", () => {
  const r = run([human("/node Auth\nq"), assistant("a")]);
  const authId = node(r, ROOT_ID).childIds[0];
  assert.equal(node(r, authId).title, "Auth");
  assert.deepEqual(node(r, authId).messageUuids, ["msg_0", "msg_1"]);
});

test("empty /node jumps back to root from a deep node", () => {
  const r = run([
    human("/child A\na"),
    human("/child B\nb"),     // B is child of A
    human("/node\nhome")
  ]);
  assert.equal(r.tree.messageIndex["msg_2"], ROOT_ID);
});

test("/node absolute path creates from root regardless of current pointer", () => {
  const r = run([
    human("/child A\na"),        // pointer deep in A
    human("/node X > Y\nq")      // absolute from root
  ]);
  const xId = node(r, ROOT_ID).childIds.find((id) => node(r, id).title === "X");
  assert.ok(xId);
  const yId = node(r, xId).childIds[0];
  assert.equal(node(r, yId).title, "Y");
  assert.deepEqual(node(r, yId).messageUuids, ["msg_1"]);
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
    human("/node A\na"),
    human("/node A > B\n/node A\nin A again")  // to A>B, then back to A; content → A
  ]);
  const aId = node(r, ROOT_ID).childIds[0];
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

test("a marker-only message is still attached to its node (findable)", () => {
  const r = run([
    human("first"),
    human("/child A"),       // marker-only: navigates into A
    human("inside A")
  ]);
  const aId = node(r, ROOT_ID).childIds[0];
  assert.deepEqual(node(r, ROOT_ID).messageUuids, ["msg_0"]);
  // the marker-only message attaches to the node it entered (A), so it's findable
  assert.deepEqual(node(r, aId).messageUuids, ["msg_1", "msg_2"]);
  assert.equal(r.tree.messageIndex["msg_1"], aId);
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
    human("a follow-up question")
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

test("re-using a topic name under the same parent re-enters the node (no duplicate)", () => {
  const r = run([
    human("/child Auth\nq1"),
    assistant("a1"),
    human("/node\nsomething at root"),
    human("/child Auth\nq2 — added later"),   // pointer at root → RE-ENTER first Auth
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
    human("/node   authentication  \nq2")  // absolute, different case + spaces
  ]);
  assert.equal(node(r, ROOT_ID).childIds.length, 1);
  const id = node(r, ROOT_ID).childIds[0];
  assert.equal(node(r, id).title, "Authentication"); // first occurrence's casing kept
  assert.deepEqual(node(r, id).messageUuids, ["msg_0", "msg_1"]);
});

test("same name under DIFFERENT parents are distinct nodes", () => {
  const r = run([
    human("/child A\n/child Notes\nq1"),  // Notes under A (relative)
    human("/node B > Notes\nq2")          // Notes under B (absolute)
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
    human("/node\n/child\nq2")
  ]);
  // two distinct Untitled topics under root
  assert.equal(node(r, ROOT_ID).childIds.length, 2);
});

test("re-entered node keeps a stable id across re-parses", () => {
  const build = () => run([
    human("/child Auth\nq1"),
    human("/node Auth\nq2")  // re-enter Auth absolutely
  ]);
  const a = build();
  const b = build();
  assert.deepEqual(Object.keys(a.tree.nodes).sort(), Object.keys(b.tree.nodes).sort());
});

// ---- breadcrumb-path shorthand ( > separator ) -----------------------------

test("/node A > B > C walks/creates a nested path in one marker", () => {
  const r = run([human("/node Auth > Tokens > Refresh\nshould tokens rotate?")]);
  const authId = node(r, ROOT_ID).childIds[0];
  assert.equal(node(r, authId).title, "Auth");
  const tokensId = node(r, authId).childIds[0];
  assert.equal(node(r, tokensId).title, "Tokens");
  const refreshId = node(r, tokensId).childIds[0];
  assert.equal(node(r, refreshId).title, "Refresh");
  // content attaches to the deepest segment
  assert.deepEqual(node(r, refreshId).messageUuids, ["msg_0"]);
});

test("path re-enters existing segments, creating only the new tail", () => {
  const r = run([
    human("/child Auth\nq1"),
    assistant("a1"),
    human("/node Auth > Sessions\nadd a child to existing Auth")
  ]);
  // still a single Auth under root
  assert.equal(childTitles(r, ROOT_ID).filter((t) => t === "Auth").length, 1);
  const authId = node(r, ROOT_ID).childIds.find((id) => node(r, id).title === "Auth");
  // Auth keeps its early messages AND gained a new child Sessions
  assert.ok(node(r, authId).messageUuids.includes("msg_0"));
  const sessionsId = node(r, authId).childIds.find((id) => node(r, id).title === "Sessions");
  assert.ok(sessionsId);
  assert.deepEqual(node(r, sessionsId).messageUuids, ["msg_2"]);
});

test("/sibling path: first segment is sibling-level, rest descend", () => {
  const r = run([
    human("/child A\na"),
    human("/sibling B > C\nbc")  // B sibling of A (under root), C child of B
  ]);
  assert.deepEqual(childTitles(r, ROOT_ID).sort(), ["A", "B"]);
  const bId = node(r, ROOT_ID).childIds.find((id) => node(r, id).title === "B");
  assert.equal(node(r, node(r, bId).childIds[0]).title, "C");
});

test("path segments are trimmed and empty segments ignored", () => {
  const r = run([human("/node  Auth >  > Tokens \nq")]);
  const authId = node(r, ROOT_ID).childIds[0];
  assert.equal(node(r, authId).title, "Auth");
  assert.equal(node(r, node(r, authId).childIds[0]).title, "Tokens");
});

test("a literal slash is allowed in a topic name now", () => {
  const r = run([human("/node TCP/IP\nq")]);
  assert.deepEqual(childTitles(r, ROOT_ID), ["TCP/IP"]);
});

// ---- pointer ---------------------------------------------------------------

test("pointerNodeId reflects the last-addressed node", () => {
  const r = run([human("/node A > B\nq"), assistant("a")]);
  const aId = node(r, ROOT_ID).childIds[0];
  const bId = node(r, aId).childIds[0];
  assert.equal(r.pointerNodeId, bId);
});

test("empty /node leaves the pointer at root", () => {
  const r = run([human("/child A\na"), human("/node\nx")]);
  assert.equal(r.pointerNodeId, ROOT_ID);
});

// ---- a fuller fixture ------------------------------------------------------

test("realistic conversation parses into the expected topic tree", () => {
  const r = run([
    human("/child Auth\nhow should I store sessions?"),
    assistant("use httpOnly cookies"),
    human("/child Tokens\nwhat about refresh tokens?"),   // child of Auth
    assistant("rotate them"),
    human("/node Auth\nback to Auth: rate limiting?"),     // re-enter Auth absolutely
    assistant("use a token bucket"),
    human("/node Deployment\nhow to ship?"),               // new top-level topic
    assistant("use a container")
  ]);

  const authId = node(r, ROOT_ID).childIds[0];
  assert.equal(node(r, authId).title, "Auth");
  const tokensId = node(r, authId).childIds[0];
  assert.equal(node(r, tokensId).title, "Tokens");

  // "back to Auth" content + its assistant reply attach to Auth
  assert.ok(node(r, authId).messageUuids.includes("msg_4"));
  assert.ok(node(r, authId).messageUuids.includes("msg_5"));

  // Deployment is a top-level sibling under root
  const deployId = node(r, ROOT_ID).childIds[1];
  assert.equal(node(r, deployId).title, "Deployment");
});

// ---- override-aware resolution (markers resolve against the tree you see) ---

const titleOf = (r, id) => r.tree.nodes[id].title;
const childIdByTitle = (r, parentId, t) =>
  node(r, parentId).childIds.find((id) => titleOf(r, id) === t);

test("rename: a node is addressable by its current (renamed) name", () => {
  const base = run([human("/node A > B\nq")]);
  const aId = node(base, ROOT_ID).childIds[0];
  const overrides = { nodeOverrides: { [aId]: { title: "APPLE" } }, messageOverrides: {} };
  const r = run([
    human("/node A > B\nq"),
    human("/node APPLE > C\nc")   // address A by its renamed name
  ], { overrides });
  // no duplicate A at root
  assert.equal(node(r, ROOT_ID).childIds.length, 1);
  assert.equal(node(r, ROOT_ID).childIds[0], aId);
  // C created under A (= APPLE)
  const cId = childIdByTitle(r, aId, "C");
  assert.ok(cId);
  assert.equal(r.tree.messageIndex["msg_1"], cId);
});

test("rename: the original name still re-enters the node (no split)", () => {
  const base = run([human("/node A\nq")]);
  const aId = node(base, ROOT_ID).childIds[0];
  const overrides = { nodeOverrides: { [aId]: { title: "APPLE" } }, messageOverrides: {} };
  const r = run([
    human("/node A\nq1"),
    human("/node A\nq2")   // old name typed again after rename
  ], { overrides });
  assert.equal(node(r, ROOT_ID).childIds.length, 1);
  assert.ok(node(r, aId).messageUuids.includes("msg_0"));
  assert.ok(node(r, aId).messageUuids.includes("msg_1"));
});

test("reparent: /up climbs the effective (dragged) parent", () => {
  const base = run([human("/node A > B\nb"), human("/node C\nc")]);
  const aId = childIdByTitle(base, ROOT_ID, "A");
  const bId = node(base, aId).childIds[0];
  const cId = childIdByTitle(base, ROOT_ID, "C");
  const overrides = { nodeOverrides: { [bId]: { parentId: cId } }, messageOverrides: {} };
  const r = run([
    human("/node A > B\nb"),
    human("/node C\nc"),
    human("/node A > B\nin B"),  // pointer at B (re-entered via hash)
    human("/up\nafter up")        // up from B → effective parent C
  ], { overrides });
  assert.equal(r.tree.messageIndex["msg_3"], cId);
});

test("reparent: address the dragged node via its new parent path", () => {
  const base = run([human("/node A > B\nb"), human("/node C\nc")]);
  const aId = childIdByTitle(base, ROOT_ID, "A");
  const bId = node(base, aId).childIds[0];
  const cId = childIdByTitle(base, ROOT_ID, "C");
  const overrides = { nodeOverrides: { [bId]: { parentId: cId } }, messageOverrides: {} };
  const r = run([
    human("/node A > B\nb"),
    human("/node C\nc"),
    human("/node C > B\nvia new path")
  ], { overrides });
  // re-enters the existing B (no duplicate), message attaches to it
  assert.equal(r.tree.messageIndex["msg_2"], bId);
  assert.equal(Object.values(r.tree.nodes).filter((n) => n.title === "B").length, 1);
});

test("two siblings with the same current name → first match wins (deterministic)", () => {
  const base = run([human("/node A\na"), human("/node Z\nz")]);
  const aId = childIdByTitle(base, ROOT_ID, "A");
  const zId = childIdByTitle(base, ROOT_ID, "Z");
  const overrides = { nodeOverrides: { [zId]: { title: "A" } }, messageOverrides: {} };
  const r = run([
    human("/node A\na"),
    human("/node Z\nz"),
    human("/node A\nwhich one?")
  ], { overrides });
  assert.equal(r.tree.messageIndex["msg_2"], aId); // A (created first) wins
});
