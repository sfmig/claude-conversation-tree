# Claude Conversation Tree — Phase 1 (Foundation)

A privacy-first Chrome extension (Manifest V3) that will visualize Claude.ai
conversations as a user-organized topic tree. This is **Phase 1 only**: the
plumbing and a discovery harness. No UI is injected yet.

## What Phase 1 does

- Loads a content script on `https://claude.ai/*` and logs that it's alive.
- **`storage.js`** — wraps `chrome.storage.local` under a single versioned key
  (`tree-viz-data`); initializes the schema. Stores **no message content**.
- **`interceptor.js`** — runs in the page's MAIN world at `document_start` and
  patches `fetch` / `XMLHttpRequest` to capture Claude's own conversation API
  responses, forwarding them to the extension via `postMessage`.
- **`api-client.js`** — receives those payloads (and can replay a same-origin
  direct fetch once the org id is known), normalizes them into a linear message
  list, and logs a **redacted** shape (message text is stripped).
- **`dom-mapper.js`** — probes candidate selectors for message elements, reports
  what it finds, and builds a `Map<messageUuid, HTMLElement>` by correlating DOM
  text with API messages, kept fresh via a `MutationObserver`.

Everything is in-memory or in `chrome.storage.local`. **No network calls are
made beyond `claude.ai` itself.**

## How to load it

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Open or reload a conversation at `https://claude.ai/chat/...`.
5. Open DevTools on that tab → **Console**.

## What you should see (and what to send back)

Look for a console group titled:

```
[CTV] FINDINGS — paste this back for the Phase 1 report
```

Please copy that group **and** expand and copy these two collapsed groups:

- `[CTV api] conversation payload via … — <url>` — the redacted payload shape.
- `[CTV dom] selector probe` — which selectors matched and sample attributes.

That output tells us:

- the real conversation **endpoint URL** and response shape,
- the **message array field name**, role/UUID/parent fields,
- whether the **DOM already carries the UUID** (or we must match by text),
- the **DOM↔UUID correlation hit rate**.

The redaction strips message text (shows `<text:N chars>`), so the output is
safe to paste. With it, I'll write the findings report and propose any plan
revisions before starting Phase 2 (the parser).

## File layout

```
extension/
  manifest.json
  background/service-worker.js   minimal lifecycle logging
  content/
    interceptor.js               MAIN-world fetch/XHR capture (document_start)
    storage.js                   chrome.storage.local wrapper
    api-client.js                payload capture + normalize + redacted logging
    dom-mapper.js                selector probe + UUID↔element map
    content.js                   entry; wiring + FINDINGS report
    styles.css                   reserves the .ctv- namespace (no UI yet)
  popup/                         placeholder; global bookmarks land later
  icons/                         icon-16/48/128.png
```

## Phase 2 — Parser (done, not yet wired into the UI)

`content/parser.js` is the pure, deterministic marker parser. It takes the
normalized message list and returns a topic tree + bookmarks, with stable node
IDs (no DOM/storage/time dependencies). It's loaded by the manifest but not yet
invoked by `content.js` — that happens in Phase 3 (tree panel).

Run its unit tests (Node only, no browser, no dependencies):

```
npm test        # from the repo root → runs tests/parser.test.js (27 cases)
```

Covers every marker (`/node`, `/child`, `/sibling`, `/up`, `/star`, `/bookmark`), edge
cases (empty `/node` → root, no name, multiple markers per message, unknown
commands, assistant messages not scanned, marker-only messages, `/star` first),
breadcrumb paths, name re-entry, the pointer, stable IDs, and idempotency.

## Phase 3 — Tree panel + highlighting (read-only)

The parser is now wired into a UI. On a conversation, the extension:
- parses the messages into a topic tree,
- injects a collapsible **Topic Tree** panel (top-right; `×` collapses it to a
  "Tree" button),
- renders the tree (root → children) with per-node expand/collapse and a
  message count,
- **node → messages:** click a node row to highlight its messages in the page
  and smooth-scroll to the first,
- **message → node:** click anywhere in a message to highlight its node in the
  panel.

Still read-only — renaming, drag-to-reparent, delete, and the bookmarks UI come
in Phases 5–6.

### Try it
Open a conversation that uses markers, e.g. send messages like:

```
/node Authentication
how should I store sessions?
```
```
/node Authentication > Tokens
what about refresh tokens?
```
```
/node Deployment
how do I ship this?
```

Reload the tab; the panel should show `Auth → Tokens` nested and `Deployment`
as a top-level sibling. Click nodes and messages to see highlighting both ways.

## Phase 4 — Persistence & re-parsing (done)

On every conversation load the pipeline is now: **parse → load stored overrides
→ merge → render → save**.

- `content/merge.js` — pure, deterministic override engine (renames, reparents
  with cycle rejection, deletes that reparent children/messages to root,
  per-message reassignment). User overrides always win; overrides referencing
  removed nodes/messages are dropped silently. Tested in `tests/merge.test.js`.
- `content/storage.js` — `getConversation` / `persistConversation`. The merged
  tree is stored as a cache under `tree-viz-data → conversations[<id>]`;
  `overrides` is the source of truth. Marker (`/star`) bookmarks are re-synced on
  each parse; user bookmarks are left untouched. **No message content is stored.**

There's no visible change yet because `overrides` is empty until Phase 5 adds
the editing UI — but the tree + bookmarks now survive reloads, and any future
edit will too.

### Verify persistence
`chrome.storage` isn't available in the page console. Open the extension's
**service-worker console**: `chrome://extensions` → this extension → click
**"service worker"** → in that console run:
```js
chrome.storage.local.get("tree-viz-data").then(console.log)
```
You should see `conversations[<id>]` with the cached `tree`, empty `overrides`,
and a `lastParsedAt`. (Alternatively, in the page DevTools console use the
context dropdown to select the extension's content-script context first.)
Run `npm test` for the merge/parser unit tests (36 cases).

## Phase 5 — Editing (done)

The panel is now editable; every edit writes to `overrides` (Phase 4) and
survives reloads.

- **Rename** — double-click a topic's label, type, Enter to save (Esc cancels).
- **Delete** — hover a row and click the 🗑 button; its messages and sub-topics
  are promoted **up to the parent topic** (a top-level topic's children land at
  the root, since root is their parent).
- **Reparent** — drag a topic onto another topic to make it a child; drop onto
  the root row to make it top-level. Invalid drops (onto itself or a descendant)
  are blocked, so no cycles.
- **Reset organization** — the "Reset" button in the panel header clears all
  your edits for this conversation and rebuilds the marker-only tree.

> Note on drag: the plan suggested SortableJS, but the panel is a flat git-graph
> (not nested `<ul>`s), so reparenting uses native HTML5 drag-and-drop
> ("drop onto a node = become its child"). That keeps the extension
> dependency-free (no bundled lib). The merge engine (`merge.js`) still enforces
> all the rules (cycle rejection, root protection) regardless of how an edit is
> triggered.

## Marker syntax

Markers are recognized at the **start of a line** in **your (user) messages**;
Claude's replies are never scanned. One marker per line — except an optional
leading `/up` (see below).

| Marker | Effect |
|---|---|
| `/node <path>` | Go to an **absolute** path from the root, e.g. `/node Auth > Tokens`. Each segment is re-entered if it exists, else created; the pointer moves to the deepest. `/node` with no path → back to the root. |
| `/child <name>` | Go to a **child** of the current node (relative). Accepts a path: `/child Tokens > Refresh`. No name → "Untitled topic". |
| `/sibling <name>` | Go to a **sibling** of the current node (i.e. a child of its parent; a top-level topic at the root). Accepts a path. |
| `/up` · `/up N` | Move the pointer **up** to the parent (or up N levels), clamped at the root. A pure move (creates nothing). May **prefix** another marker on the same line: `/up 2 /child TOPIC`. |
| `/star` · `/bookmark <note>` | Bookmark the previous (received) message. |

The separator is **`>`** (a breadcrumb), spaces optional (`A>B` = `A > B`). A
literal `/` in a topic name is fine. There is **no `/parent` or `/root`** — root
is empty `/node` (or `/up N` to climb out), a top-level topic is `/node TOPIC`,
and relative climbing is `/up`. `/up` is the only marker that may share a line
with another (`/up 2 /child X`); chaining (`/up /up …`) is not supported — use
`/up N`.

### Re-entering a topic to add messages later
Because every segment is *addressed by name* (re-enter if it exists, create if
not), you can return to a topic anytime and keep adding:

```
/node Authentication
how should I store sessions?
```
…later in the conversation…
```
/node Authentication > Sessions   ← re-enters Authentication, adds Sessions
how do I expire idle sessions?
```

- Identity is the **name-path**: `id = hash(conversationId + parentId + name)`.
  Same path → same node.
- Names match **case-insensitively, trimmed**; the first occurrence's casing is
  the displayed title.
- Same name under **different** parents = different topics (each parent is its own
  namespace, like folders).
- **Unnamed** topics (`/child` with no name) are always new (can't be addressed).
- The tree marks the current node — where the next un-marked message will land —
  with a **pointer ring** on its dot and a **bold label**.
- Caveat: ids key off marker *text*, so editing a marker's name in the
  conversation changes that node's id (orphaning its stored overrides once).
  Renaming/moving via the **UI** doesn't touch marker text, so UI edits are safe.

## Deviations from PLAN.md (intentional)

- **Navigation is absolute `/node` + relative `/child`/`/sibling`/`/up`** with a
  `>` separator and a visible pointer (ring + bold label) — replacing PLAN §5's
  relative-only `/child`/`/sibling`/`/parent`/`/root`. `/up [N]` may prefix a
  marker on one line (`/up 2 /child X`); `/root` is dropped (use empty `/node`).
  Removes the one-marker-per-line footgun and the move-vs-create ambiguity.
- **Drag uses native HTML5 DnD, not SortableJS** — the panel is a flat git-graph,
  not nested `<ul>`s; keeps us dependency-free (PLAN §8/§10).
- **Delete promotes children to the parent, not root** — standard outliner
  behavior (PLAN §7 said root).
- **Node ids are name-path hashes, not marker message+line hashes** — enables
  re-entering topics to add messages later (revises PLAN §4/§7).

## Not yet

Bookmarks UI (star buttons, global popup), scroll-based highlighting, settings —
deferred to later phases per `../PLAN.md` §11.
