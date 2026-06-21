<h1 align="left">
  <img src="extension/icons/icon.svg" alt="ClaudeTOC logo" width="44" />
  &nbsp;Claude TOC
</h1>

Build a table of contents (TOC) for your [Claude.ai](https://claude.ai) conversations as you go!


* 🐰🕳️ Have you ever rabbit-holed deeply into a conversation with Claude, but got slightly lost in the twists and turns of a topic?
* 🗺️🧭 Do you wish you had a timeline of the conversation, to navigate the messages and the topics covered?

Meet ClaudeTOC!

ClaudeTOC is a Chrome extension that lets you organize a Claude.ai conversation into a topic tree as you chat, by typing inline tags in your messages. 
Using these tags, the extension renders a TOC tree in a side panel, with bidirectional node↔message highlighting.

## How to install?
1. Clone the repository locally using [git](https://git-scm.com/install/):
```
git clone https://github.com/sfmig/claude-conversation-tree.git
```

2. Open Chrome, go to `chrome://extensions` and enable **Developer mode** in the top right toggle.
3. Click **Load unpacked** (top left) and select the `extension/` directory of this repository.
4. Open a conversation on [claude.ai](https://claude.ai), make sure the extension is enabled.

Now you are ready to go 🚀

## How to create a TOC?

* You can create a new section and add messages to it with this syntax:
    ```
    /node Section 1
    Can you explain how blabla works?
    ```

    This will create a node with title "Section 1" in the rendered TOC tree. Notice the new line after the `/node` tag! 
    
    This message and any new ones after it will be automatically added to "Section 1". In the TOC tree, the node with an outer ring marks the section to which messages are currently being added. This is the currently **active node**.

* To create a new subsection, use the same `/node` syntax and specify the path from the root node using `>`:
    ```
    /node Section 1 > Subsection 1.1
    This message will be added to subsection 1.1
    ```

* If spelling out the full path to the section feels too long, you can use the following **relative tags**, which define the path relative to the currently **active node**: 
    * `/child` tag
        ```
        /child Subsection 1.1
        Will create a new section just under the currently active one 
        ```

    * `/sibling` tag
        ```
        /sibling Section 2
        Will create a new section that is a sibling of the currently active one 
        ```

* Add `/up` before a relative tag to move the active node up first. Sepcify a number to go up several levels:
    ```
    /up 2 /sibling Section N
    Moves the active node up 2 levels, then creates a sibling node
    ```

* Tags can also be added at the end of the message, so:
    ```
    Can you explain how blabla works? /node First section
    ```
    is the same as:
    ```
    /node First section
    Can you explain how blabla works?
    ```


### Other functionality

* **Click to highlight (both ways)**: click a node to highlight its messages (and mark their location on the scrollbar), and click a message to highlight its node in the tree.
* **Rename**: double-click a node name to edit it. The name in the tree is the source of truth, so you can use the new name when specifying new tags.
* **Drag and drop**: drag a node onto another to change its parent.
* **Delete**: to delete a node, hover on its row and click on the bin icon that appears. The messages of a deleted node will move to the parent node.
* **Reset**: the tree and its edits are saved locally. It will persists across restarts and tab reopens. To start from scratch, you can click "Reset" (top right) to rebuild the tree from the tagged messages.



## Is it private?

Everything stays local in your browser:

* **Stored locally only.** All data lives under one `chrome.storage.local` key (`tree-viz-data`) on disk in your browser profile. Nothing is sent anywhere.
* **No message content.** Only two bits of your input text are stored: the node titles and the conversation title. The messages themselves are never written to storage.
* **No external calls.** The extension can only touch `https://claude.ai/*` (see `manifest.json`).

<details>
<summary>How to verify this yourself</summary>

From a claude.ai tab with the extension enabled, open DevTools (⋮ menu > More Tools > Developer tools):

* **Storage** — Application tab > `Storage > Extension Storage > Claude Conversation Tree > Local`. See exactly what's stored.
* **Network** — Network tab, sorted by Domain. It shouldn't differ with or without the extension.
* **Permissions** — at `chrome://extensions`, click `Details` to confirm the only host is `claude.ai`.

</details>


## Can I use it in my phone?
The extension won't work in Chrome on your phone or in the Claude App. But any tagged messages will render a TOC tree when you open them on your desktop using the browser version of Claude.



## Development
Install the extension as described above. 

After changing code, remember to both:
1. Click "Reload" on the extension in `chrome://extensions`, and 
2. Hard-reload the claude.ai tab.

Use `npm test` to run the unit tests for the pure modules.

See `CLAUDE.md` for an architecture overview.

## Built with Claude

ClaudeTOC was written using [Claude Code](https://claude.ai).

## License

MIT © S Minano
