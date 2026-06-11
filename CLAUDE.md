# Claude Conversation Tree (claude-viz)

A locally-run Chrome extension (Manifest V3, no build step, vanilla ES5-style
JS) that lets a user organize a claude.ai conversation into a topic tree as
they chat, by typing inline markers like `/node Topic > Subtopic` in their
messages. The tree renders in an injected side panel with bidirectional
node↔message highlighting. Fully private: no external calls, nothing leaves
the browser, message *content* is never persisted.

**`PLAN.md` is the spec** — read §5 (marker syntax, as revised) and §6–7
(parser + override merge) before touching parsing logic; §13 lists decided
trade-offs. `KICKOFF.md` and `PHASE1-FINDINGS.md` are historical.

## Status (see PLAN §11 phases)

- **Done:** Phases 1–5 (capture, parser, panel, persistence, editing) plus
  much of 7 (sticky highlights, hunt-to-virtualized-message, minimap ticks,
  live re-parse on in-place edits).
- **Not built:** Phase 6 bookmarks UI — `popup.js` is a placeholder and there
  are no star buttons; the parser already extracts `/star`–`/bookmark`
  markers. Note: marker-based bookmarking prompts Claude to reply (any user
  message does), so the planned star-button UI is the preferred direction.

## Data flow

```
claude.ai fetch/XHR ─(patched by interceptor.js, MAIN world)─ postMessage ─►
api-client.js ─► api-normalize.js (linear active-branch message list) ─►
content.js: parser.js (+ stored overrides) ─► merge.js ─► tree-panel.js render
                                            └► dom-mapper.js / dom-align.js
                                               (uuid↔element map) ─► highlighting.js
                                            └► storage.js persist (tree = cache,
                                               overrides = source of truth)
```

`content.js` is the orchestrator: boot, SPA-navigation watcher, live re-parse
on edits (debounced refetch 1.5s + 4s settle pass), follow-the-edit highlight,
and the `editor` handlers (rename/delete/reparent/reset → overrides →
`commitEdit`).

## Module map (`extension/content/`)

Two worlds: `interceptor.js` runs in the page's MAIN world at `document_start`
(claude.ai's `fetch` is patched there; replays cached payloads when api-client
posts a "ready" ping). Everything else is the isolated world at
`document_idle`, load order fixed in `manifest.json`, all sharing the
`window.CTV` namespace.

**Pure, Node-testable (UMD-style, mirrored in `tests/`):**
- `parser.js` — markers → tree; deterministic, override-aware resolution.
- `merge.js` — applies user overrides onto a fresh parse; overrides always win.
- `api-normalize.js` — raw payload → `[{uuid, parentUuid, index, role, text}]`;
  walks `current_leaf_message_uuid` up to get the *active branch*. The
  Claude-specific payload knowledge lives here (adapter seam, PLAN §13).
- `dom-align.js` — aligns rendered turns to messages (anchors on user text;
  assistant turns are markdown-mangled and may span several containers).

**DOM/browser-bound:**
- `dom-mapper.js` — `Map<uuid, element>` + MutationObserver, tags
  `data-ctv-uuid`, `onRecorrelate` listeners.
- `highlighting.js` — node→message paint (sticky across virtualization,
  hunt+align scroll, minimap), message→node click delegation.
- `tree-panel.js` — git-graph style panel; colors are pure per-node-id hashes;
  inline rename, delete, drag-reparent.
- `storage.js` — everything under one `chrome.storage.local` key
  (`tree-viz-data`); never stores message text.

## Invariants & conventions

- **Privacy:** no network beyond claude.ai, no message content in storage,
  `host_permissions` stays `https://claude.ai/*` only.
- **Node ids are stable hashes** of (conversationId, parentId, name) — colors
  and overrides depend on this; don't introduce random ids.
- Pure modules must stay DOM/network/storage-free so `npm test` (node:test,
  97 tests) keeps covering them. UI code: every class prefixed `.ctv-`,
  DOM built with `createElement` (no innerHTML with user text), never
  preventDefault on page clicks.
- **Editing a message on claude.ai rewrites the branch**: the edited message
  returns with a *fresh uuid* (old uuids vanish). Anything diffing across a
  re-parse must work on vanished/new uuid sets (see `followEditNode` in
  `content.js`).
- Long conversations are **virtualized**: off-screen turns have no DOM
  element; one assistant message can render as several turn containers.
- An edit triggers *multiple* re-parse passes — code in that path must be
  idempotent.

## Dev workflow

- `npm test` — unit tests for the pure modules.
- Manual testing: `chrome://extensions` → Load unpacked → `extension/`.
  After changing code: **reload the extension AND hard-reload the claude.ai
  tab** (old content scripts keep running and throw
  `Extension context invalidated`).
- Pipeline logs use `console.debug` — set DevTools Console level to
  **Verbose** or you'll see nothing.
