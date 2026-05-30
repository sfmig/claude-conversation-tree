# Phase 1 Findings — Claude.ai API & DOM Reality Check

Observed on a real 6-message conversation (`/chat/68c3aec6-…`) on 2026-05-30, via
the Phase 1 discovery harness. Message text is omitted throughout; only
structure, field names, types, and lengths were inspected.

---

## 1. Conversation API

### Endpoint

```
GET /api/organizations/{orgId}/chat_conversations/{conversationId}
      ?tree=True&rendering_mode=messages
```

The app itself also appends `&render_all_tools=true&consistency=strong`, but a
**direct same-origin fetch with the minimal query string works** (with
`credentials: "include"` — the session cookie is sufficient; no extra auth).

Both capture strategies succeeded:
- **Direct fetch** (content script, isolated world) — worked on first try.
- **MAIN-world fetch hook** — also captured the app's own request.

### IDs

- `conversationId` — in the page URL path: `/chat/{conversationId}`.
- `orgId` — **not** in the URL. Discovered from any captured
  `chat_conversations` request URL (the hook/`directFetch` learns it). A UUID.
- Message `uuid` — **UUIDv7** (time-ordered, e.g. `019e7ab9-1f1b-7299-…`).
  Stable per message → good for our derived node IDs.

### Message array: `chat_messages`

Ordered array (by `index`, 0..N). Each entry's keys:

```
uuid, text, content, sender, index, created_at, updated_at,
truncated, stop_reason, attachments, files, sync_sources, parent_message_uuid
```

| Field | Reality |
|---|---|
| `sender` | `"human"` \| `"assistant"`. **This is the role field — not `role`, not `user`.** |
| `text` | Present but **empty (`""`)** under `rendering_mode=messages`. Do not rely on it. |
| `content` | **Where the text actually lives.** Array of blocks; text blocks are `{type:"text", text, citations}`, some also carry `{start_timestamp, stop_timestamp, …}`. Full message text = concatenation of block `.text`. |
| `parent_message_uuid` | Linear chain. The first message's parent is the sentinel `00000000-0000-4000-8000-000000000000` (the conversation root). |
| `index` | Integer ordinal, 0-based, matches array order. |
| `created_at` / `updated_at` | ISO timestamps — available for sibling ordering. |

### Redacted normalized sample (this conversation)

```
#0  human      parent=000…0000   index=0
#1  assistant  parent=#0          index=1
#2  human      parent=#1          index=2
#3  assistant  parent=#2          index=3
#4  human      parent=#3          index=4
#5  assistant  parent=#4          index=5
```

A clean alternating linear chain — `rendering_mode=messages` appears to return
the **active branch already flattened**, which is exactly what v1 wants.

---

## 2. DOM Structure

### User messages — reliable

```
div[data-testid="user-message"]          (class includes "!font-user-message")
  └─ ancestor: [data-user-message-bubble="true"]
```

Matched all 3 user turns.

### Assistant messages — no testid of their own (resolved)

The `data-testid` inventory:

```
user-message:3   action-bar-copy:6   action-bar-read-aloud:3   action-bar-retry:3
(+ page chrome: pin-sidebar-toggle, chat-input, model-selector-dropdown, …)
```

- **No `assistant-message` testid exists.** `.font-claude-message` is gone too.
- But the counts pin down the structure: `action-bar-copy: 6` = one per turn =
  **6 message turns**; `action-bar-read-aloud`/`action-bar-retry: 3` are
  assistant-only; `user-message: 3` are the human turns.
- **`div[data-test-render-count]` matches 6 = the per-turn container** (one per
  message, user and assistant alike), in document order.

### The DOM does NOT carry the message UUID

The clean first probe (before our own tagging) found **no attribute anywhere
containing a message UUID**. (A later "✓" was a false positive: it matched our
own `data-ctv-uuid` tag because the page hadn't been reloaded between probes —
now fixed to ignore our tag.)

**Consequence:** we must establish the message↔UUID link ourselves.

---

## 3. Plan Revisions

### R1 — Message text must be assembled from `content[]` (PLAN §9)

§9 says "Each message has `uuid`, `parent_message_uuid`, `role`, and
`text`/`content`." Corrections:
- The role field is **`sender`** with values **`human`/`assistant`**.
- `text` is **empty**; real text = concatenation of `content[]` text blocks.

The parser's input builder (already implemented in `api-client.normalize`)
handles this. **Parser input contract is confirmed:** `{uuid, role, text, index,
parentUuid}` with `role ∈ {human, assistant}`.

### R2 — Map messages to DOM by ORDER, not by a native UUID (PLAN §9) — IMPLEMENTED

§9 hoped for an existing UUID attribute (`data-msg-uuid`). That doesn't exist.
Implemented approach (now the primary strategy in `dom-mapper.js`):
- Select all per-turn containers `div[data-test-render-count]` in document order
  and **zip** them against `chat_messages` ordered by `index`.
- **Guard:** verify role alignment — a turn containing
  `[data-testid="user-message"]` must map to a `human` message. If counts or
  roles don't line up (e.g. virtualization dropped turns), fall back to
  text-prefix matching.
- Tag each element with our own `data-ctv-uuid`.
- This is far more robust than text-prefix matching, which is fragile: assistant
  prose gets re-segmented/reformatted by the markdown renderer, so prefixes
  drift (it only scored 3/6, the user turns).

### R3 — Assistant selector (resolved)

There is **no assistant-specific selector**; assistant turns carry no testid.
Resolved by R2's order mapping using the per-turn container. Assistant turns are
distinguishable when needed via their action bar
(`[data-testid="action-bar-retry"]` / `action-bar-read-aloud`). No longer a
Phase 3 blocker.

> ⚠️ `div[data-test-render-count]` is the per-turn container *observed on this
> page*. It's a render-internal attribute and could change across Claude
> releases; the role-alignment guard + text-prefix fallback keep us safe, but
> Phase 3 should treat the selector as a single point to revisit if mapping
> regresses.

### R4 — Parser uses API data ONLY; DOM mapping is a separate concern

Important architectural clarification: the tree is built entirely from the API
`chat_messages`. The DOM↔UUID map is needed **only** for highlight/scroll
(Phase 3), **not** for parsing. Therefore **virtualization in long conversations
cannot affect parsing** — it can only degrade highlighting of off-screen
messages, which we handle with scroll-to-render later. This de-risks the whole
parser phase.

### R5 — Branch/edit handling: trust `rendering_mode=messages` (PLAN §9, §13)

This conversation returned a single linear active branch. Recommendation: rely
on `rendering_mode=messages` to give us the active path and treat it as linear
for v1 (sort by `index`). **To verify:** behavior on a conversation with edits/
regenerations (does it still return one flat path, or multiple children?). Added
to the open-questions list.

### R6 — Sibling ordering source exists (PLAN §8)

§8 proposes deriving sibling order "from first message timestamp." Confirmed
feasible: `created_at`/`updated_at` are present, and UUIDv7 also encodes time.

---

## 4. Privacy Posture (unchanged, confirmed clean)

- Only `claude.ai` same-origin traffic (direct fetch + passive hook). No
  external calls, no CDN, no analytics.
- Nothing persisted yet. When we do persist, only UUIDs/metadata — never the
  `content[]` text.

---

## 5. Go / No-Go for Phase 2 (Parser)

**GO.** The parser's only dependency — the shape of the message list — is fully
confirmed (R1). The remaining open items (R3 assistant selector, R5 branch
behavior) belong to Phase 3 and the long-conversation test pass, not the parser.

Recommended sequencing tweak: keep building the parser against the confirmed
`{uuid, role: human|assistant, text, index}` contract; resolve R3 in parallel
from the next harness run so Phase 3 is unblocked when we reach it.
```
