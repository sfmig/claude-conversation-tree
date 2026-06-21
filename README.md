# Claude TOC

Build a table of contents (TOC) for your [Claude.ai](https://claude.ai) conversations as you go!


* 🐰🕳️ Have you ever rabbit-holed deeply into a conversation with Claude, but got slightly lost with the twists and turns of understanding well a topic?
* 🗺️🧭 Do you wish you had a timeline of the conversation, to navigate the messages and the topics covered?

Meet ClaudeTOC!

ClaudeTOC is a Chrome extension that lets you organize a Claude.ai conversation 
into a topic tree as you chat, by typing inline tags in your messages.  Using these tags, the extension
renders a TOC tree in a side panel, with bidirectional node↔message
highlighting.

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

* You can create a new section and add messages to it by using this syntax:
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

* If spelling out the full path to the section is too long, you can use the following **relative tags**, which define the path relative to the currently **active node**: 
    * Child tag
        ```
        /child Subsection 1.1
        Will create a new section just under the currently active one 
        ```

    * Sibling tag
        ```
        /sibling Section 2
        Will create a new section that is a sibling of the currently active one 
        ```

* You can also use `/up` before any of the **relative tags**, to move the currently active node:
    ```
    /up /sibling Section N
    Will move the currently active node up one level, and then create a sibling node
    ```

    To move the currently active node several levels up, add a number after `/up`:
    ```
    /up 2 /sibling Section N
    Will move the currently active node up 2 levels, and then create a sibling node
    ```

    Note that the tag `/up /child Section name` is equivalent to `/sibling Section name`:
    ```
    /up /child Subsection 3
    Will move the currently active node up one level, and then create a child node.
    The same as using the tag `/sibling Subsection 3` from the currently active node.
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
* **TOC - messages bidirectionality**

    Clicking on a section node in the TOC tree will highlight the messages included in that node and show their approximate location in the scrollbar.
    Clicking on a message in the conversation will highlight the row of the corresponding TOC section.

* **Renaming a node**

    You can rename a node by double clicking on a node name in the TOC tree. The name in the TOC tree is the source of truth: after a node rename, you can use the updated name when defining a subsection path.

* **Drag and drop nodes**

    You can drag-and-drop nodes in the TOC tree to change their parent/children relations.

* **Deleting a node**

    You can delete a node in the TOC tree by hovering on its row, and clicking on the bin icon that comes up on the right. If a section node is deleted, its messages are then added to its parent.

* **Reset the TOC tree**

    Changes to the TOC tree are saved locally and persist across browser restarts, and closing/reopening the tab. You can recompute the TOC tree from the tagged messages in the conversation by clicking on "Reset" at the top right corner



## Is it private?

The extension (in `storage.js`) stores all required data locally under a single `chrome.storage.local` key (`tree-viz-data`). `chrome.storage.local` keeps data on disk in the browser profile; nothing is sent anywhere.

Three pieces of user-typed text are stored as metadata: node titles (from your `/node` tags), the conversation title, and bookmark notes (text after `/bookmark`). The text of the messages themselves is never written to storage. You can verify this by doing this from a claude.ai tab with the extension enabled:
* In the Chrome window, go to the Three dots options menu next to your username picture > More Tools > Developer tools
* Click on the Application tab, then on the left `Storage > Extension Storage > Claude Conversation Tree > Local`.

The extension is only allowed to touch data from `https://claude.ai/*` (see `manifest.json`). There are no external calls, and you can verify this by going to `chrome://extensions` and then clicking on `Details` in "Claude Conversation Tree".

You can also watch the actual traffic on the claude.ai tab:
* In the Developer tools, click on the Network tab, and sort the data by the Domain column (if not shown, right click on any column and enable it).
* The Domain column shouldn't show any differences with or without the extension.


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
