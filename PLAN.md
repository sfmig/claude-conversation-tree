# Claude Conversation Tree Visualizer — Build Plan

A locally-run Chrome extension that lets users organize Claude.ai conversations into a topic tree, with bookmarks and bidirectional message↔node highlighting. Fully privacy-preserving by default.

---

## 1. Goals & Non-Goals

### Goals
- Visualize a Claude.ai conversation as a user-defined topic tree (not Claude's internal branch structure).
- Let users mark topics inline via keyword commands (e.g. `/topic`, `/branch`) with minimal post-processing.
- Allow drag-and-drop reorganization, renaming, and deletion of nodes.
- Bookmark/star individual messages with optional notes and tags; retrieve them per-conversation or globally.
- Bidirectional highlighting: clicking a node highlights and scrolls to its messages; clicking a message highlights its node.
- Run fully locally with no external services by default.

### Non-Goals (v1)
- Cross-conversation tree (one conversation = one node). Defer to v2.
- Many-to-many message-to-topic tagging (one message belongs to one node).
- Automatic topic detection via local LLM (defer; revisit for auto-naming later).
- Visualizing Claude's internal edit/regenerate branches.

---

## 2. Privacy Requirements

- **No external network calls by default.** No analytics, telemetry, CDN dependencies, or remote model calls.
- **Scoped permissions:** `host_permissions` restricted to `https://claude.ai/*`. Do not request `<all_urls>`.
- **Bundled dependencies:** All libraries (drag-drop, rendering, etc.) bundled with the extension, not loaded from CDNs.
- **Storage:** Use `chrome.storage.local` only. Never use `chrome.storage.sync` (which uploads to Google).
- **Optional Claude-based auto-titling** (deferred feature): If implemented, must be opt-in via settings, with clear disclosure that segment text is sent to Anthropic's API. User supplies their own API key.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│ claude.ai page                                          │
│  ┌───────────────────┐    ┌──────────────────────────┐ │
│  │ Conversation DOM  │ ←→ │ Content Script           │ │
│  │ (messages)        │    │  - parser                │ │
│  └───────────────────┘    │  - DOM observer          │ │
│                           │  - injected tree panel   │ │
│                           │  - injected star buttons │ │
│                           └────────────┬─────────────┘ │
└────────────────────────────────────────┼───────────────┘
                                         │
                          chrome.storage.local
                                         │
                            ┌────────────┴─────────────┐
                            │ Background service worker│
                            │ (optional; for storage   │
                            │  helpers, message routing)│
                            └──────────────────────────┘
```

- **Manifest V3** Chrome extension.
- **Content script** does the bulk of the work: reads conversation data, parses markers, renders tree panel, handles interactions.
- **Background service worker**: optional, used for cross-tab storage coordination if needed.
- **Popup**: a "Bookmarks" view across all conversations.

---

## 4. Data Model

All data stored in `chrome.storage.local` under a single key (e.g. `tree-viz-data`):

```js
{
  conversations: {
    "conv_abc123": {
      conversationId: "conv_abc123",
      conversationTitle: "Designing the auth system",
      rootNodeId: "node_root",
      tree: {
        nodes: { /* nodeId → Node */ },
        messageIndex: { /* messageUuid → nodeId */ }
      },
      overrides: {
        nodeOverrides: { /* nodeId → { title?, parentId?, deleted? } */ },
        messageOverrides: { /* messageUuid → { nodeId } */ }
      },
      lastParsedAt: 1730000000000,
      schemaVersion: 1
    }
  },
  bookmarks: {
    "bm_001": {
      id: "bm_001",
      messageUuid: "msg_xyz",
      conversationId: "conv_abc123",
      nodeId: "node_auth",
      note: "Good explanation of JWT refresh",
      tags: ["security", "reference"],
      createdAt: 1730000000000
    }
  },
  settings: { /* future use */ },
  schemaVersion: 1
}
```

### Node

```js
{
  id: "node_xyz",          // stable, derived from message UUID + marker position
  title: "Authentication design",
  titleSource: "marker",   // "marker" | "auto" | "user-edited" | "fallback"
  parentId: "node_root",   // null only for root
  childIds: ["node_abc", "node_def"],  // ordered
  messageUuids: ["msg_111", "msg_222"],  // ordered by appearance
  createdAt: 1730000000000,
  collapsed: false
}
```

### Design notes
- **Flat node map** with `parentId` + `childIds` pointers (not nested). Enables O(1) lookups and trivial reparenting.
- **`messageIndex`** is denormalized for O(1) message→node lookups; rebuilt whenever the tree changes.
- **Never store message content.** Reference messages by UUID; read content from the live DOM/API.
- **Stable node IDs:** derive from `hash(conversationId + markerMessageUuid + markerLineIndex)` so re-parses produce the same IDs and user overrides remain attached.
- **`schemaVersion`** for future migrations.

---

## 5. Marker Syntax

Markers are recognized at the start of a line in **user messages only** (Claude's responses are not scanned).

> **Revised (implemented).** The original relative-only set (`/sibling`,
> `/child`, `/parent`, `/root`) was replaced with an **address-by-name** model: a
> single absolute `/node` path, relative `/child`/`/sibling`/`/up`, a `>` path
> separator, and a visible pointer (ring + bold label). This removed the
> one-marker-per-line footgun and the move-vs-create ambiguity. The table below is
> the current spec.

| Marker | Effect |
|---|---|
| `/node <path>` | Absolute path from root, `>`-separated (`/node Auth > Tokens`). Each segment is re-entered if it exists, else created; pointer moves to the deepest. Empty `/node` → root. |
| `/child <name>` | Relative: a child of the current node. Accepts a `>` path. No name → "Untitled topic". |
| `/sibling <name>` | Relative: a child of the current node's parent (top-level at root). Accepts a `>` path. |
| `/up` or `/up N` | Pure pointer-move up to the parent (or N levels), clamped at root. May prefix another marker on the same line (`/up 2 /child X`); no chaining. |
| `/star` or `/bookmark <optional note>` | Bookmark the previous message (the one just received). |

A node is **addressed by name** (absolute or relative) and you go there, creating
only if absent — so re-using a path re-enters the same node (messages can be added
later). Node identity is the name-path: `hash(conversationId + parentId + name)`.

### Parser behavior
- Allowed commands: `node`, `child`, `sibling`, `up`, `star`, `bookmark`. Other `/word` lines are plain text.
- A marker may be at the **start of a line** (own line) or the **end of a line, after the message**. Per line, the first command token at line start *or preceded by whitespace* is the content↔marker boundary: text before it is content, the token→EOL is the "marker part". (Whitespace-preceded requirement keeps paths/URLs like `a/b/node` as plain text.)
- The marker part is `[ /up [N] ] [ one name marker ]` — the bounded-integer `/up` peels off unambiguously, so `/up 2 /child X` works in either position. Two name markers on a line is unsupported (the first takes the rest of the line); chained moves (`/up /up …`) are unsupported — use `/up N`.
- Markers process before remaining message content; non-marker content in the same message belongs to whatever node is current after marker processing (so a trailing tag places that message under its topic).
- Caveat: a message literally containing a whitespace-preceded command (e.g. "use /child here") is read as a marker; use a leading own-line marker when mentioning a command literally.
- Names match **case-insensitively, trimmed**; the first occurrence's casing is the displayed title.
- **Edge cases:**
  - Empty `/node` (or all-empty path): move pointer to root (no-op at root).
  - `/up` at root, or `/up N` deeper than the tree: clamp at root. Non-numeric/absent N → 1. Chained `/up /up …` is not supported (use `/up N`).
  - `/child`/`/sibling` with no name: fallback title "Untitled topic" with `titleSource: "fallback"`; always a new node (not addressable).
  - `/star` as the first message: skip silently (no previous message).
  - Unknown command (e.g. `/nde`): treat as plain text.
- Messages with markers should have markers stripped from the visible display in the tree panel (not in the actual Claude.ai DOM).

---

## 6. Parser Algorithm

Input: ordered list of messages with `{uuid, role, text}`, plus the conversationId.
Output: fresh `tree` (nodes + messageIndex) and parsed bookmarks.

```
state = {
  nodes: { root: { id: root, title: conv title, parentId: null, childIds: [], messageUuids: [] } },
  messageIndex: {},
  bookmarks: {},
  currentNodeId: root,
  previousMessageUuid: null
}

for each message in messages:
  if message.role === "user":
    markers = extractMarkers(message.text)
  else:
    markers = []

  for each marker in markers:
    applyMarker(state, marker, message)

  if message has non-marker content:
    state.nodes[currentNodeId].messageUuids.push(message.uuid)
    state.messageIndex[message.uuid] = currentNodeId
    state.previousMessageUuid = message.uuid
```

The parser must be **deterministic** and **idempotent** for the same input.

---

## 7. Persistence & Re-parsing Strategy

### Strategy
On every conversation load:
1. Run the parser on the raw messages → produces fresh `tree`.
2. Apply stored `overrides` on top of the fresh tree (merge step).
3. Save the merged tree back to storage (the `tree` field is effectively a cache).

### Merge rules
- **Renames:** if `nodeOverrides[id].title` exists, apply it; set `titleSource: "user-edited"`.
- **Reparenting:** if `nodeOverrides[id].parentId` exists, move the node accordingly.
- **Deletion:** if `nodeOverrides[id].deleted`, remove the node; reparent its children and messages to root.
- **Message reassignment:** apply `messageOverrides` last; for each entry, move the message to the specified node.
- **User overrides always win** over parser output.
- **Orphaned overrides** (override exists but node no longer in parsed tree because its marker was removed): drop silently in v1.

### Stable IDs
Node IDs must be derivable from message-level facts that don't change across parses. Recommended: `node_<hash(conversationId + markerMessageUuid + markerLineIndex)>`. Do not use random UUIDs.

### Reset capability
"Reset organization" feature: clear `overrides` for a conversation; next parse produces the marker-only tree.

---

## 8. UI & Interactions

### Layout
- **Tree panel** injected into the Claude.ai page (right side sidebar or collapsible drawer).
- **Star buttons** injected next to each message in the DOM.
- **Bookmarks popup** accessible from the extension icon: shows all bookmarks across all conversations, filterable by tag and conversation.

### Tree panel
- Renders the tree by walking `rootNodeId` → `childIds`.
- Each node shows: title, message count, expand/collapse toggle.
- Selected node shows: list of its messages (snippets), bookmarks within it.

### Bidirectional highlighting
- **Node → messages:**
  - On node click: look up `messageUuids` for that node.
  - Find corresponding DOM elements (via `data-` attribute or maintained UUID→element map).
  - Apply highlight class (scoped CSS, prefixed to avoid conflicts).
  - Scroll first message into view with `scrollIntoView({ behavior: 'smooth', block: 'start' })`.
- **Message → node (on click):**
  - Event delegation on message container.
  - Look up `messageIndex[uuid]` → highlight node in tree panel.
- **Message → node (on scroll, bonus):**
  - `IntersectionObserver` on message elements.
  - Passively highlight node corresponding to centered message ("minimap" behavior).
- Maintain UUID→element map; rebuild when DOM mutates (Claude is a React SPA — use `MutationObserver`).

### Editing
- **Rename:** click title in tree → inline input → save on blur. Updates `nodeOverrides[id].title`.
- **Delete:** node context menu or button. Confirms, then updates `nodeOverrides[id].deleted = true`.
- **Drag-to-reparent:** use **SortableJS** (vanilla, MIT, bundled locally). Validate no cycles before applying. Updates `nodeOverrides[id].parentId`.
- **Sibling reorder:** also via SortableJS within a parent's `childIds` array. (Sibling order can be stored as override or always derive from message order; v1 = simple, derive from first message timestamp.)
- **Move individual message between nodes (optional v1):** drag a message snippet from one node's view to another. Updates `messageOverrides[uuid].nodeId`.

### Bookmarks
- **Star button** on each message (injected). Toggle on click. Optional note via prompt or inline input.
- **Inline marker** `/star` or `/bookmark <note>` also creates bookmarks (handled by parser).
- **Bookmark views:**
  - Inline: list of bookmarks under a selected node.
  - Per-conversation: all bookmarks in current conversation.
  - Global: extension popup shows all bookmarks across conversations, with tag filter and free-text search.
- **Jump to bookmark:** click a bookmark → scroll to its message (navigating to its conversation first if needed: `window.location.href = '/chat/' + conversationId`, then on-load handler scrolls to the message).

---

## 9. Reading Conversation Data

Two approaches; pick one (or use both as fallback):

1. **Hook fetch/XHR:** intercept Claude's API responses for `/api/organizations/.../chat_conversations/...` and read the message tree from there.
2. **Direct API call:** content script calls the same endpoint using the existing session cookie. Same-origin, no auth setup needed.

Each message has `uuid`, `parent_message_uuid`, `role`, and `text`/`content`. For v1, treat the conversation as linear: walk from root via `parent_message_uuid` along the active branch.

### DOM mapping
- Tag each message DOM element with its UUID (via a `data-msg-uuid` attribute if Claude doesn't already provide one, or by matching content/order).
- Maintain a `Map<uuid, HTMLElement>` updated via `MutationObserver` because Claude is a React SPA and may re-render or virtualize messages.

### Virtualization caveat
Long conversations may virtualize messages (only render what's near the viewport). When scrolling to a message that isn't rendered:
- Approximate scroll by index/position, then re-query.
- Or trigger Claude's own scroll-to behavior if available.

---

## 10. Chrome Extension Structure

```
/extension
  manifest.json
  /background
    service-worker.js          (optional, minimal)
  /content
    content.js                 (entry; sets up observers, injects UI)
    parser.js                  (marker parser, pure functions)
    storage.js                 (chrome.storage.local wrapper)
    tree-panel.js              (renders + manages tree UI)
    bookmarks.js               (star buttons, bookmark logic)
    highlighting.js            (node↔message highlighting)
    dom-mapper.js              (UUID↔element map, MutationObserver)
    api-client.js              (fetch conversation data)
    styles.css                 (scoped with unique prefix, e.g. .ctv-)
  /popup
    popup.html
    popup.js                   (global bookmarks view)
    popup.css
  /lib
    sortable.min.js            (bundled, not from CDN)
  /icons
    icon-16.png, icon-48.png, icon-128.png
```

### `manifest.json` (sketch)

```json
{
  "manifest_version": 3,
  "name": "Claude Conversation Tree",
  "version": "0.1.0",
  "description": "Organize Claude.ai conversations into a topic tree, locally and privately.",
  "permissions": ["storage"],
  "host_permissions": ["https://claude.ai/*"],
  "content_scripts": [{
    "matches": ["https://claude.ai/*"],
    "js": ["lib/sortable.min.js", "content/parser.js", "content/storage.js", "content/dom-mapper.js", "content/api-client.js", "content/highlighting.js", "content/bookmarks.js", "content/tree-panel.js", "content/content.js"],
    "css": ["content/styles.css"],
    "run_at": "document_idle"
  }],
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": { "16": "icons/icon-16.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" }
  },
  "background": {
    "service_worker": "background/service-worker.js"
  },
  "icons": { "16": "icons/icon-16.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" }
}
```

---

## 11. Build Phases

### Phase 1 — Foundation
- [ ] Manifest, folder structure, "Hello world" content script logging on claude.ai.
- [ ] `storage.js` wrapper around `chrome.storage.local` (get/set/update for the root object).
- [ ] `api-client.js`: fetch the current conversation's message tree from Claude's API.
- [ ] `dom-mapper.js`: build and maintain UUID↔element map using MutationObserver.

### Phase 2 — Parser
- [ ] `parser.js`: marker extraction + state-machine parser, deterministic, pure functions.
- [ ] Unit tests covering all marker types and edge cases (no name, `/back` from root, multiple markers per message, unknown commands, etc.).
- [ ] Stable node ID generation.

### Phase 3 — Tree Panel (Read-only)
- [ ] Inject a collapsible panel into the claude.ai page.
- [ ] Render the parsed tree (no editing yet).
- [ ] Node click → highlight + scroll to first message.
- [ ] Message click → highlight node in tree.

### Phase 4 — Persistence & Re-parsing
- [ ] Save parsed tree to `chrome.storage.local`.
- [ ] On load: parse → merge overrides → save → render.
- [ ] Empty `overrides` initially.

### Phase 5 — Editing
- [ ] Rename node (inline).
- [ ] Delete node.
- [ ] Drag-to-reparent via SortableJS, with cycle validation.
- [ ] Each edit writes to `overrides`.
- [ ] "Reset organization" button (clears overrides).

### Phase 6 — Bookmarks
- [ ] Inject star buttons on messages.
- [ ] Toggle bookmark state; persist to `bookmarks` map.
- [ ] `/star` and `/bookmark` markers in parser.
- [ ] Per-conversation bookmarks view (in tree panel).
- [ ] Global bookmarks popup (extension icon).
- [ ] Jump-to-bookmark navigation.

### Phase 7 — Polish
- [ ] Scroll-based passive node highlighting (`IntersectionObserver`).
- [ ] Strip markers from message display in tree panel.
- [ ] Empty / loading / error states.
- [ ] Keyboard shortcuts (e.g. Cmd+B to open bookmarks).
- [ ] Settings page (toggle for scroll highlighting, etc.).

### Phase 8 (deferred)
- [ ] Optional Claude-based auto-titling for unnamed topics (opt-in, user-provided API key).
- [ ] Cross-conversation tree view.
- [ ] Tag autocomplete and bulk tag editing.
- [ ] Export bookmarks as Markdown/JSON.

---

## 12. Testing Strategy

- **Unit tests** for the parser (Node.js, no browser needed). Cover every marker type, every edge case, and full conversation fixtures.
- **Storage tests:** round-trip data through `chrome.storage.local` mock.
- **Manual integration tests** on real claude.ai conversations of varying lengths and structures.
- **Edge case fixtures:** conversations with no markers, conversations with only markers, conversations with deeply nested branches, virtualized long conversations.

---

## 13. Open Questions / Decisions to Revisit

- **Marker conflict with Claude's prose:** Claude might generate text starting with `/` in code blocks. Confirm regex anchoring is sufficient; consider scanning user messages only (current plan) as a robust mitigation.
- **Multi-tab behavior:** if user has the same conversation open in two tabs, both content scripts read/write the same storage key. Use `chrome.storage.onChanged` to keep tabs in sync.
- **Conversation deletion on Claude's side:** orphaned bookmarks should be flagged in UI, not silently dropped (v2).
- **Performance for very long conversations:** measure parse + render time. If slow, consider incremental parsing.
- **Versioning & migrations:** when `schemaVersion` changes, write a one-time migration function. Plan for this from day one.

---

## 14. Out of Scope

- Mobile / non-Chrome browsers.
- Any feature requiring an Anthropic API key by default. (Optional opt-in features may use one.)
- Editing Claude's actual messages or interfering with Claude's own UI controls beyond injection of our panel and star buttons.
- Real-time collaboration / multi-user sharing.

---

## 15. Success Criteria for v1

- Load a real Claude.ai conversation; see it parsed into a topic tree based on `/sibling` and `/child` markers.
- Click any node and have its messages highlighted and scrolled to.
- Click any message and have its node highlighted in the tree.
- Rename a node and have the rename survive a page reload.
- Drag a node under another node and have the move survive a page reload.
- Star a message and find it in the global bookmarks popup later, including from a different conversation.
- All of the above with zero external network calls beyond `claude.ai` itself.
