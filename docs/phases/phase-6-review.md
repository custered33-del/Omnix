# Phase 6: Final review and polish

Phase 6 went back over the whole of Omnix, every phase, looking for anything that was broken, unsafe, inconsistent or rough, and fixed what it found. It ends with the [list of what could not be fixed, and why](#what-could-not-be-fixed).

## How the review was done

Four reviews worked independently, each against a real running server rather than only reading code:

| Review | How | Found |
| --- | --- | --- |
| **Security** | Read the server, then tried the attacks against a scratch server with curl | 7 findings: 2 high, 2 medium, 3 low |
| **Data integrity** | Scripts that race edits, undo, redo, proposals, restarts and crashes, plus a fuzz of 16,000 operation/undo round trips | 12 findings |
| **MCP tools** | Called all 91 tools through an MCP client, in all three permission modes | 15 findings |
| **Web app** | Drove all six editors in Chromium, with a second live window, reloads and exports | 15 findings |

Phase 6 also included these checks of its own:

- a type-check for unused code
- a check of every link in the README and the docs
- a test that every MCP tool's documented example fits its own schemas, and that the catalog matches the server
- the accessibility checks in the high-contrast theme as well as light and dark
- a second run of the [walkthrough](../WALKTHROUGH.md), with fresh screenshots

Two items left over from Phase 5 were finished first:

- animation layers that overlap on one track now get their own rows on the timeline
- people watching a public presentation link now follow the presenter

## What was fixed

### Security

- **Uploaded files could run scripts (high).** An SVG uploaded to a shared project was served as a page on Omnix's own address, so a script inside it could act as whoever opened the link. Files now carry a sandboxing Content-Security-Policy. Only pictures (not SVG), video, audio, fonts, plain text and PDF are shown in the browser; everything else is sent as a download.
- **Importing from a URL could reach internal services (high).** The address is now checked where the connection is made, after DNS, and again at every redirect. Loopback, private, link-local, multicast and IPv4-in-IPv6 forms are all refused.
- **Access tokens ignored their scopes on the REST API (medium).** A read-only token could still change and delete things. Tokens now need `omnix:read` to read, and `omnix:edit` plus `omnix:autonomous` to write.
- **Code Grounds' isolation (medium).** By default code now runs only where Node's permission model keeps it away from the server's files. Code Grounds' kernel panel warns when network isolation is missing. `OMNIX_SANDBOX_ISOLATION=best-effort` keeps the old behaviour, for servers where only trusted people run code.
- **Sign-in had no limit (low).** Failed sign-ins are limited per address and per account (50 and 10 in 15 minutes).

### Data integrity

- **Undo and revert could remove the wrong item.** Undoing a filter, slide element or keyframe that others had added around could remove someone else's item. They now find items by identity and refuse when the item is gone.
- **Redo lost collaborators' changes.** Redo now replays the exact reversal, and a change can no longer be reverted twice. Agent rollback skips changes that were already reverted.
- **Undo could get stuck for good.** If someone deleted what your last change touched, undo kept failing. It now moves past changes that can no longer be reversed.
- **Realtime edits could arrive out of order or twice.** Edits from one window are applied in order. A resent edit is applied once, even from a new connection or after a restart, because each commit keeps the window's id for the edit.
- **A crash during "Accept" could reopen a proposal.** Accepting it again applied the change twice. On restart, a proposal whose commit is in the log is marked accepted.
- **A member's edit could undo their own removal.** Saving the project's details re-reads them first, so an edit made at the same moment no longer restores a removed member or an old name.
- **Malformed changes could corrupt a project.** A created subtree must now be a real tree, every node reached once from its root. Undoing a list update now removes the keys it added, and `__proto__` keys are refused.
- **Edits could vanish right after a restart.** With the default file storage, two first reads at once could drop a write made between them. One load is now shared.
- **Asset files were deleted while history still needed them.** Undoing a merge pointed at a missing file. A file now stays while any project's history, saved versions or open proposals refer to it.
- **The browser could undo the wrong change, or lose offline edits to a second tab.** Undo and redo first commit typing and wait until the server has it. Unsent edits are kept per tab, and a closed tab's edits are taken over by the next one.

### Typing together

The biggest web finding: two people typing in the same paragraph or code file lost one person's text, on screen and on the server.

- Every typed edit now carries the text it was typed over.
- When someone else changed that text in the meantime, the two edits are merged word by word, in the browser as soon as the other change arrives, and on the server in the same way. Both people end up with the same text.
- Undoing an edit later takes back only its own words.
- Code Grounds keeps other people's changes out of its own Ctrl+Z, and applies them as small changes, so the caret stays where it was.

### Web app

- Ctrl+Z in a document paragraph is the project's undo, the same as History and the toolbar. The browser's per-field undo could not handle splits or other people's edits.
- Typing is committed when the page is closed or hidden. The save status says *Saving…* until the server has it, and *Home* no longer reloads the page.
- The image editor's Move tool picks layers by their pixels. A brush layer no longer catches clicks everywhere, and a click on the selected layer's content moves that layer.
- History lists every version. Going back to an older one no longer hides the later ones; they are marked *Later version*.
- Exports, captions, video fill and command runs no longer stick at 0% when the job finishes very fast.
- Pressing Escape in the project name cancels the rename. The dashboard's Rename dialog starts from the current name, and Enter saves it.
- Typing in long documents re-renders one paragraph instead of all of them. Before, a keystroke took about 78 ms at 1,000 paragraphs. The word count and outline now update a moment later.
- Renaming a code file to a name that exists is refused, and the entry file follows a rename.
- Ctrl+B splits a clip, as the shortcuts list says.
- Focus returns where it was after the command palette or *Describe a change* closes.
- A project deleted while open says so, and the empty dashboard's text points the right way.

### MCP tools

- **Canvas and render fixes**
  - A LUT adjustment layer broke every render of its canvas.
  - Growing a canvas failed when a layer had a pixel mask.
- **Edit-with-approval mode**
  - `code_run` and `save_preset` now see Claude's own proposed changes.
  - `undo` takes back the last step of Claude's open proposal. If nothing is waiting, it *proposes* the reversal instead of applying it.
- **Validation**
  - `video_add_clip` refuses a track from another sequence or of the wrong kind.
  - New layers and adjustments only go into a group on their own canvas.
- **Agent tools**
  - A bad run id is a clear error.
  - `agent_status` checks the owner and shows the latest decision.
  - `agent_wait` no longer uses the answer up.
- **Schemas**
  - Results may say `none` (nothing to change).
  - `get_history` declares `approvedBy`.
  - `compare_versions` describes its whole result.
- **`slides_edit_slide`** with `duplicate` applies the other changes to the copy.
- **`export_file`**
  - A layer id exports just that layer.
  - The tool is now a write tool, since it adds a file to the library.
  - Every write tool is refused on a view-only connection.
- **Messages and descriptions**
  - Error messages name the id and say how to recover.
  - Descriptions state rotation units, how long a still clip lasts, and what happens when an imported file is already in the library.
  - `image_add_layer` without an asset makes an empty layer to paint on, and keeps a picture's proportions when given one side.
- **Naming**
  - `style_match` and `apply_preset` take `nodeId`, like every other tool. They used to take `targetId`.

### Consistency and tidying

- Removed unused imports and functions, and an unused parameter.
- The catalog no longer turns Markdown examples in a description into broken links and images.
- The README documents every setting the server reads (`OMNIX_HOST`, `OMNIX_MAX_UPLOAD_MB`, `OMNIX_S3_FORCE_PATH_STYLE` and `OMNIX_WEB_DIST` were missing).

## Tests

`pnpm test` runs 385 tests in 40 files, and `pnpm test:e2e` runs 23 browser tests. New in this phase:

- **Core:**
  - undo, redo and lists with collaborators, and malformed changes (`history.test.ts`)
  - the text merge and caret mapping (`textDiff.test.ts`)
- **Renderer:** picking layers by their pixels.
- **Server:**
  - the security fixes (`security.test.ts`)
  - realtime ordering and resends, and a proposal accepted just before a crash (`api.test.ts`)
  - the shared first load (`storage.test.ts`)
  - undoing a merge (`collab.test.ts`)
  - every MCP fix (`tools.test.ts`)
  - the catalog matching its schemas and the server (`catalog.test.ts`)
- **Web:** merging typing with an outside change, per-tab unsent edits, and undo waiting for typing (`store.test.ts`).
- **Browser:**
  - two windows typing in one paragraph and one code file, with undo and redo
  - an immediate reload after typing
  - renaming, and History after going back (`phase6.spec.ts`)
  - the axe checks in the high-contrast theme (`a11y.spec.ts`)

The end-to-end tests cover what Phase 6 had to confirm:

- all six editors open, save and survive a reload (`editors.spec.ts`, `phase3.spec.ts`)
- the Claude connector setup completes (`phase3.spec.ts`, `phase4.spec.ts`)
- the walkthrough exports a PDF document, a PDF deck and a PNG through Claude's tools (`walkthrough.spec.ts`)
- the web review exported every format by hand

## Decisions and why

- **Merge words, not keystrokes.** A CRDT would merge keystroke by keystroke, but it would change the stored format, the operation log, history and every editor. Merging at commit time with a three-way, word-level merge fits the existing operations. One optional field on an update carries the text it was typed over. It gives everyone the same result, and it makes undo of typing selective too. What it does not do is described below.
- **Undo in approval mode never applies anything.** Claude in approval mode must not change the project without review, including when it undoes. Taking a step out of its own open proposal is safe. Reversing something already applied becomes a proposal.
- **Check addresses where the connection is made.** Checking a host name and then fetching it lets DNS answer differently the second time. The check runs inside the lookup the connection uses, and again at every redirect.
- **Refuse unsafe code runs by default.** Running code in a worker without the permission model looks the same to the person using it, but it is not isolated. Omnix now refuses unless the server owner chooses otherwise.
- **Keep asset files while history refers to them.** Removing a file from your library takes it out of the library at once. The bytes stay until no project could bring it back. Disk use grows instead of undo breaking.
- **Rename only the parameters that were really inconsistent.** `style_match` and `apply_preset` now say `nodeId`, like the other tools. Slide elements keep `w` and `h` because those are the element's own property names in `update_node`. Image *filters* and video *effects* are different things with different lists.

## What could not be fixed

These are known and deliberate, or need more than a fix. Each says why.

### Collaboration

- **Typing together merges words, not keystrokes.** Other people's typing appears about half a second after they pause, not letter by letter. When two people change the *same word* differently, the later edit wins for that word. Live keystroke-level co-editing needs a CRDT. Omnix's operation log, history and stored format would all have to change, and that is a rewrite rather than a fix.
- **Undoing a move uses positions.** Undoing a move puts the item back at its old index, which may be a different neighbour if others reordered the list since. Items are never lost or duplicated, only placed differently.
- **Large projects copy the node map on every edit.** This takes about 1 ms at 3,000 nodes and 17 ms at 30,000. A persistent map would touch around 300 places and the stored format (see Phase 5).
- **A resent edit is recognised within its last 2,000 commits.** A window that comes back after more than 2,000 changes by others would apply its old unsent edit again. In practice unsent edits are minutes old.
- **Another tab's unsent edits are taken over after a minute of quiet.** A tab that is open but silent for longer may have its unsent edits sent by the next tab too. The server recognises and ignores the duplicate.

### Security and operations

- **Code Grounds' isolation depends on the operating system.** JavaScript's `vm` is not a security boundary. Containment comes from Node's permission model, which is required by default, and from a network namespace. Without user namespaces, for example in many containers, code can reach the network, and the kernel panel says so. Fixing that means running code in a separate container or VM, which is a deployment choice outside Omnix.
- **Plugins are trusted code.** Local and command plugins run with the server's permissions. The owner can add an HTTP plugin at any address, including internal ones, on purpose: local MCP servers on `localhost` are a main use.
- **Importing slideshows parses untrusted files.** The zip guard relies on the sizes declared inside the archive, and LibreOffice reads `.ppt`, `.odp` and `.key` files directly. Run LibreOffice in its own container if strangers can upload slideshows.
- **Uploads up to 4 GB by default.** Long videos need it. Lower `OMNIX_MAX_UPLOAD_MB` on a server shared with people you do not know.
- **The sign-in limit is per server process.** Several Omnix processes behind one address each keep their own count.
- **Asset files stay as long as history refers to them.** There is no pruning of old history yet, so a deleted file's bytes may stay for good.

### Editors and tools

- **Code Grounds' Ctrl+Z is the editor's own undo.** It takes back your typing in that file, as code editors do. History and the toolbar undo whole changes across the project. Document paragraphs use the project's undo.
- **Screen readers have not been tried.** The pages pass axe in three themes and the keyboard checks, but nobody has tested them with NVDA or VoiceOver. Drawing on a canvas and dragging on the timeline need a pointer; the same changes can be made from the properties panels, commands or Claude.
- **Generation without an image model is limited.** The built-in provider fills from the surroundings and cannot paint new objects. Video fill suits steady shots, and video extend fills with a blurred copy (see Phase 4).
- **The command parser covers common edits only.** Compound conditions and numbers written as words go to Claude, or come back as not understood.
- **Style matching transfers easing and timing, not motion paths.**
- **Built-in runner runs stop on restart.** **Try again** resumes them from the saved conversation. Runs driven by Claude over MCP survive restarts.
- **Slideshow import limits.**
  - PowerPoint tables arrive as text, and SmartArt and ink are skipped.
  - Gradients become solid colors, and motion paths are not imported.
  - PDF pages arrive as pictures.
  - PDF export draws slides as pictures with a selectable text layer.
- **Look-alike detection is visual only.** Re-encoded audio is caught only when the bytes are identical.
- **Presets cannot be exported to a file.**
- **OAuth issues no client secrets.** It supports public clients with PKCE, which is what Claude uses.
- **Some parameter names differ by design.** These are slide elements' `w` and `h`, image `filter` versus video `effect`, and `documentId` meaning any document (see Decisions).
