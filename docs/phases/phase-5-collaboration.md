# Phase 5: Collaboration and polish

Phase 5 is about working together, with people and with Claude, and about reuse:

- comments pinned to the exact place they are about, and live cursors
- versions compared as pictures and as text
- an asset library that finds copies by itself
- batch processing
- templates and presets
- a plugin API that adds third-party tools to Omnix and to Claude

The phase closes with performance work, an accessibility pass, and a [walkthrough of Claude completing a whole goal](../WALKTHROUGH.md), which is also an automated test.

## Walkthrough

```bash
pnpm install
pnpm build
pnpm start      # http://localhost:4317
```

Phase 5 adds one setting: `OMNIX_PLUGINS_DIR`, the plugins folder (default `<data folder>/plugins`).

### Comments and live cursors (feature 51)

Turn on comment mode with the speech-bubble button or **Ctrl+Alt+M**, then click where the comment belongs. A comment can be pinned to:

- a point on a canvas or a slide
- a moment and position in a video frame, or a time on the timeline ruler
- a line of code (in the gutter)
- a paragraph or a phrase in a document

The **Comments** panel lists every thread in the project and filters them by document or status. Clicking a comment opens its document and scrolls to the comment.

Comments follow what they point at:

- A code comment moves with its line when lines are added or removed above it, by anyone, Claude included.
- A comment whose target is deleted says so instead of disappearing.

Everyone in the project sees the others' cursors and selections live: on canvases, on slides, on the timeline (as playheads), in code (as a tagged line) and in documents (a bar beside the paragraph). Claude appears too, wherever it last changed something.

Claude reads threads with `list_comments`, which names the layer under a canvas pin, and closes them with `resolve_comment`, adding a reply.

### Compare versions (feature 52)

**History → Compare versions…** (or the compare button next to a saved version) compares any two versions:

| Document | How it is compared |
| --- | --- |
| Canvases, slides and video frames | As pictures: side by side, a draggable swipe, overlay, or the difference in magenta. Shows the share of the picture that changed and where. |
| Documents | Paragraph by paragraph, with word-level changes. |
| Code | Line by line, with unchanged runs folded. |
| Decks | Slide by slide: added, removed, edited, moved. |

**Go back to …** makes the older version current again. Later versions are kept, and new edits start a branch from there. Claude has the same comparison through `compare_versions`, and saves named versions with `save_version`.

### Asset library (feature 53)

The library tags every upload automatically: its shape (landscape, portrait, square), size (4k, full-hd, small), length for video and audio, its main colors, and where it came from (generated, export).

Search understands names, tags, colors, sizes such as `1920x1080`, `kind:video`, `tag:logo` and `unused`.

Duplicates are handled two ways:

- **Identical files** are stored once.
- **Look-alikes** (resized, re-encoded or re-saved copies) are found by a perceptual hash. The library offers to merge them: keep one, switch every use to it in every project you can edit, and remove the rest. In approval mode, the project changes go through review first.

Each file shows where it is used. **Select** allows tagging, removing or processing many files at once.

### Batch processing (feature 54)

In the library, select files, then choose **Process…**. In a project, use **Apply to several documents…**. Only operations that suit everything selected are offered.

| What you select | Operations |
| --- | --- |
| Pictures | resize, convert, crop, color grade, LUT, filter, watermark, background removal, upscaling, matching a reference look |
| Video | transcode, LUT, extract the audio |
| Audio | normalize, convert |
| Documents | run a plain-language command, export, match a reference look, apply a preset |

Batches run as jobs with progress, per-item results and a stop button. New files are tagged `batch` plus any tags you choose. Plugin tools that take one file or one document appear as batch operations too.

Claude has the same through `list_batch_operations` and `run_batch`.

### Templates and presets (feature 55)

**Presets** (the **Presets** page, and a Presets menu in each editor) save and reuse five kinds of thing:

- layer effects
- clip looks
- animation rigs
- document styles
- slide themes

Omnix ships with built-ins (film grain, vintage, warm film, a pendulum and a waving-arm rig, three document styles, five themes). Your own presets can be shared with everyone on the same Omnix.

**Templates:** **Project settings → Save as template** turns a project into a starting point. New projects, and Claude's `create_project`, can start from one.

### Plugins (feature 56)

A plugin adds tools that use the same schema as Omnix's own MCP tools. A plugin can be:

- any MCP server over HTTP, added in **Settings → Plugins** by the server owner
- an MCP server started as a command
- a local JavaScript module (the last two are installed in the plugins folder)

Plugin tools appear:

- to Claude, as `<plugin>__<tool>`
- in a project's **Plugins** panel, with a form built from the schema
- as batch operations

Plugins never write to projects directly. A tool returns Omnix operations and files, and Omnix applies them under the caller's permission mode, attributed and undoable. See [`docs/PLUGINS.md`](../PLUGINS.md), and the two working examples in [`examples/plugins`](../../examples/plugins).

### Claude, end to end

[`docs/WALKTHROUGH.md`](../WALKTHROUGH.md) follows Claude through a whole goal: a poster, a brief, a deck built from it, a teaser and exports. Seb approves the plan, reviews each stage, comments on the poster, compares versions and approves the exports. The screenshots come from `e2e/walkthrough.spec.ts`.

## What was built

**Core:**
- `textDiff.ts`: line and word diffs (Myers), and moving code comments along with their lines.
- `versions.ts`: comparing versions per document.
- `assetRefs.ts`: finding and replacing asset references anywhere in a project.
- `presets.ts`: preset data, built-ins, applying a preset to a node.
- `history.ts`: old versions are rebuilt by replaying their commits as one batch, and recently viewed versions are kept.

**Imaging and renderer:**
- Pixel diff, the difference overlay, perceptual hashing and color names.
- Constant-time blur at any radius.
- Simple layers draw straight onto the canvas instead of through a buffer of their own.

**Server:**

| Area | What it does |
| --- | --- |
| `realtime/presence.ts` | Live locations of people and Claude, and where a change happened. |
| `versions/` | Comparisons, picture comparisons (cached), restore. MCP: `save_version`, `compare_versions`. |
| `assets/library.ts` | Analysis, search, usage, look-alike groups, merging. MCP: `find_similar_assets`, `merge_assets`, search in `list_assets`. |
| `batch/` | Batch operations and their registry, jobs, REST, MCP: `list_batch_operations`, `run_batch`. |
| `presets/` | Presets and templates. MCP: `list_presets`, `save_preset`, `apply_preset`, and `create_project` from a template. |
| `plugins/` | The plugin host for HTTP and stdio MCP servers and local modules, the tool bridge, plugin batch operations, and live updates of the tool list in open MCP sessions. |
| `mcp/tools/docs.ts` | `list_comments` and `resolve_comment`. |
| `agent/` | Approval gates now cover batch exports, merges, removing commands and plugin tools. Tools say whether they may remove content (`destructiveHint`). A stage under review stays current until approved. |

**Web:**
- Comment pins, the comment gutter in code, timeline comment markers, the Comments panel and comment mode.
- Presence on every editor.
- The Compare versions dialog.
- The library: search, auto tags, look-alike review, details, selection and the bulk bar.
- Batch dialogs, and forms built from schemas.
- The Presets page and menus in each editor.
- The Plugins panel and settings.
- Accessibility fixes (below).

**Scripts:** `pnpm bench` runs the performance benchmarks.

## Performance

`pnpm bench` builds a project with 400 layers, 150 slides and 2,000 paragraphs (2,857 nodes) and times the hot paths. Before and after this phase's changes:

| Operation | Before | After |
| --- | --- | --- |
| Render the 400-layer canvas at 1920 × 1080 | 4,417 ms | 24 ms |
| Render it as a 960 px preview | 1,341 ms | 23 ms |
| Render the project thumbnail | 831 ms | 37 ms |
| Rebuild the state 1,500 commits back | 1,578 ms | 6 ms |
| Compare versions across every document | 1,487 ms | 51 ms |
| Blur a 1080 px picture by 130 px | about 7 s | about 150 ms |
| Apply one change (copies the node map) | 1.1 ms | 1.0 ms |

## Accessibility

[`e2e/a11y.spec.ts`](../../e2e/a11y.spec.ts) runs axe (WCAG 2.1 A and AA, plus best practices) on every page, each editor, the project panels and the main dialogs, in the light and dark themes. It also tabs through every editor and checks that focus never gets stuck and is always visible. Everything passes. The fixes it took:

- **Tab semantics.** Tab bars hold only tabs, and toggles that were tabs no longer also claim to be pressed. Selected rows without a list role use `aria-current` or `aria-pressed` instead of `aria-selected`.
- **Keyboard access.** Click-only rows (timeline track headers, animation layers) got real buttons.
- **Headings.** The project page has a level-one heading (the project) and a level-two heading (the open document).
- **Contrast.** Code comments, terminal hints, clip names, warning text, and the AI button and avatar in dark mode. Links inside running text are underlined.
- **The code editor's Tab trap.** Tab indents code, so the editor says how to leave it (Escape, then Tab), and the shortcuts dialog lists it.
- **Visual-only tooltips.** Tooltips repeat the control's own name, so screen readers skip them.

## Tests

`pnpm test` runs 355 tests in 38 files; `pnpm test:e2e` runs 16 browser tests. New in this phase:

- **Core:**
  - diffs and comment remapping (`textDiff.test.ts`)
  - version comparison (`versions.test.ts`)
  - presets (`presets.test.ts`)
  - replaying history across branches (`history.test.ts`)
- **Imaging:**
  - pixel diff and perceptual hashes (`compare.test.ts`)
  - the fast blur against the exact one, and its speed
- **Renderer:** the direct drawing path produces the same pixels as buffered compositing.
- **Server:**
  - comments and presence, versions, the library and merging, batches, presets and templates (`collab.test.ts`)
  - plugins of all three kinds, including permission modes, operations and assets returned by plugins, live tool updates, and plugin batches (`plugins.test.ts`)
  - the approval gates for batches, merges, commands and plugins, and asking for changes at a stage review (`agent.test.ts`)
  - writing into a new document and making a deck from it (`tools.test.ts`)
- **Web:**
  - comment pins, the panel and focus requests (`collab.test.tsx`)
  - a check that shared components never rely on a stylesheet that loads with only one screen (`styles.test.ts`)
- **Browser:**
  - comments pinned to slides and code (`phase5.spec.ts`)
  - comparing versions as pictures and text (`phase5.spec.ts`)
  - the accessibility checks (`a11y.spec.ts`)
  - the end-to-end walkthrough (`walkthrough.spec.ts`)

## Decisions and why

- **A comment points at a thing, not at a pixel position on screen.** Anchors are a node plus a position in that node's own terms: a canvas point, a time, a line, a text range. Pins stay put when people zoom, pan, reflow or edit around them. Code anchors follow their lines through a diff.
- **Presence is ephemeral.** Cursors and selections travel over the realtime channel and are never committed. Claude's location is the place it last changed, kept for 45 seconds.
- **Comparisons are computed, not stored.** Any two points in history can be compared, including ones nobody named. Picture comparisons are rendered on demand and cached.
- **Duplicates by content.** Identical bytes are stored once (SHA-256). Look-alikes are only *offered* for merging, because two similar pictures may be meant to differ. Merging switches uses through each project's normal permission path, so approval mode still applies, and a copy that is still in use is never removed.
- **One registry for batch operations.** Built-in operations, document commands and plugin tools register the same way. The batch dialog, the REST API and `run_batch` all list the same things.
- **Presets are data.** A preset is the properties it sets, not code. Applying one is an ordinary, undoable change, and built-ins and user presets work the same way.
- **Plugins return changes instead of making them.** A plugin cannot write to a project or get around review. It returns operations, and Omnix applies them as the caller. A tool that may remove things says so (MCP's `destructiveHint`). If it doesn't, Omnix assumes it might, and an autonomous run pauses before it.
- **Approvals check what a call does, not only its name.** Exporting through a batch is still exporting, and removing through a plain-language command is still removing.
- **Keep the node map a plain object.** Every edit copies it, which is about 1 ms at 3,000 nodes. A persistent map would make single edits cheaper but touches 300 places and the stored format. Replaying many commits as one batch already removed the cost where it hurt: old versions and comparisons.

## Incomplete in this phase

- **No character-level merging.** Typing in a paragraph, a slide text box or a code file saves the whole text after a short pause. If two people type in the *same* paragraph or file at the same moment, the later save wins for it. Different paragraphs, layers and files merge fine. Real-time co-editing of the same text needs a CRDT, which Omnix does not have yet.
- **Large projects make every edit copy the node map.** Each edit copies the whole node map: about 1 ms at 3,000 nodes and 17 ms at 30,000. Very large projects will feel it while dragging.
- **Look-alike detection is visual only.** It compares pictures, and videos by their thumbnails. Re-encoded audio is only caught when the bytes are identical.
- **Presets cannot be exported.** There is no file export or import for presets. Sharing works within one Omnix server.
- **Plugins are trusted code.** Local and command plugins run with the server's permissions. Only someone with access to the server's files can install them, and there is no sandbox. HTTP plugins can be added by the server owner.
- **Accessibility beyond the automated checks.** The pages pass axe and the keyboard checks, but they have not been tried with a screen reader such as NVDA or VoiceOver. Drawing on a canvas and dragging on the timeline need a pointer; the same changes can be made from the properties panels, commands or Claude.
- **Overlapping animation clips.** Two animation layers that overlap in time on one track draw over each other on the timeline (found in the accessibility screenshots, left for Phase 6).
