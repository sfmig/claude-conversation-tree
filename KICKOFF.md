# Kickoff Prompt

I want you to build a Chrome extension that visualizes Claude.ai conversations as a user-organized topic tree. The full design is in `PLAN.md` — please read it in full before starting.

## How to approach this

Do **not** attempt to build everything at once. Work phase by phase as defined in section 11 of the plan, and stop for review after each phase.

### Start with Phase 1 only

Your first deliverable is:

1. The manifest and folder structure.
2. A minimal content script that loads on `claude.ai` and logs to the console.
3. A `storage.js` wrapper around `chrome.storage.local`.
4. An `api-client.js` that successfully fetches the current conversation's message data from Claude's internal API (or hooks fetch/XHR to capture it).
5. A `dom-mapper.js` that builds a `Map<messageUuid, HTMLElement>` and keeps it updated via `MutationObserver`.

### Before writing Phase 2+

After Phase 1, report back with:

- **What Claude.ai's conversation API actually returns** (endpoint URL, response shape, how messages are structured, what UUIDs look like). Paste a redacted example.
- **How messages are represented in the DOM** (what selectors work, whether there are existing data attributes containing UUIDs, how to reliably link DOM elements to API UUIDs).
- **Anything in the plan that turned out to be wrong or needs revision** based on what you found.

The data model and parser in the plan are theoretical and depend on these real-world details. Don't proceed to the parser (Phase 2) until we've confirmed the shape of the data.

## Ground rules

- **Privacy is non-negotiable.** No external network calls beyond `claude.ai`. No CDN imports. No analytics. Bundle every dependency locally.
- **Use vanilla JS** unless you have a strong reason to introduce a framework. The plan assumes vanilla + SortableJS for drag-and-drop.
- **Keep the parser pure and testable.** It should be plain functions that take messages and return a tree, with no DOM or storage dependencies. Write unit tests for it (Node, no browser).
- **Scope CSS** with a unique prefix (e.g. `.ctv-`) so we never conflict with Claude.ai's styles.
- **Don't store message content** in `chrome.storage.local`. Only UUIDs and metadata.
- **Stable node IDs** — derive them from message-level facts so re-parsing produces the same IDs.

## What to ask me

If anything in the plan is ambiguous, ask before coding rather than guessing. Particularly:

- Marker syntax variations or additions.
- UI placement and styling preferences.
- Whether to support a feature now or defer to a later phase.

## Deliverable format for Phase 1

- A working unpacked extension I can load via `chrome://extensions` → "Load unpacked".
- A short README in the repo explaining how to load it and what Phase 1 does.
- The findings report described above (API shape + DOM structure + plan revisions).

Ready when you are.
