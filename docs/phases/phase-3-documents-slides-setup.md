# Phase 3: Documents, slideshows and the Claude setup guide

Phase 3 adds the last two editors (documents and slideshows), the seven-step guide that connects Claude, and the troubleshooting page. Both editors work on the same scene graph as the rest of Omnix, so every edit is attributed, undoable, synced live and reachable by Claude through MCP.

## Walkthrough

```bash
pnpm install
pnpm build      # builds the web app into packages/web/dist
pnpm start      # http://localhost:4317
```

### Claude setup guide (Help → Claude setup guide, or `/setup`)

A new account lands here automatically. The left column shows the seven steps; done steps have a check, the current one is highlighted, and the bar on top shows overall progress. **Back** and **Continue** move between steps, any step can be opened directly, and progress is saved to your account, so the guide resumes where you left it on any device.

1. **Your Omnix account.** Who you are signed in as, and what Omnix keeps where: projects and history in the data folder (or Postgres), files in the same folder (or S3), the account with a salted password hash, connection keys as hashes only. It also states that nothing goes to Anthropic unless Claude asks for it through tools you allow.
2. **Open Claude's connector settings.** A button opens Claude's Settings → Connectors. A drawing of that page shows where **Add custom connector** is. Team and Enterprise notes, plus instructions for Claude Code (`claude mcp add …`) and a ready-made Claude Desktop config for local use.
3. **Add Omnix as a connector.** Name and connector URL, each with a copy button. If Omnix runs on a local address or without HTTPS, the step says so and links to the fix.
4. **Sign in and approve.** What the approval window will ask, one permission at a time in plain words, and how to untick what you do not want.
5. **Choose what Claude may do.** Three presets (View only, Edit with approval, Autonomous), each with what Claude can and cannot do. They work as a radio group (mouse or arrow keys), and the choice is saved.
6. **Test the connection.** **Run the test** checks the address Claude will use. Omnix then connects to its own MCP endpoint with a temporary key in the chosen mode, reads the project list and writes a blank note, as Claude would. Each line shows passed, check, failed or skipped, with a fix and a link to the matching troubleshooting entry. In Edit with approval the test note waits for your approval, which shows how that mode works. Below, **Now try it from Claude** gives a prompt to paste and turns green when Claude really reaches Omnix.
7. **Start your first project.** Open the sample project or go to the dashboard, take a one-minute tour, and see example requests to try in Claude. The sample (*Launch kit*) has a notebook whose chart is linked live into a brief and a slideshow, plus a poster that appears on a slide. **Allow AI** for it is a checkbox you can untick.

**Troubleshooting** (Help → Troubleshooting) covers connection errors, expired sign-ins, permission problems and disconnecting. Each entry gives the symptom, the reason and the fix. A filter narrows the list, and links from the connection test open the matching entry.

### Documents (features 33–37)

Create a **Document** from the dashboard.

- **Writing.** Type as in any editor. Markdown shortcuts turn `#`, `-`, `1.`, `[]`, `>` and three backticks into headings, lists, to-dos, quotes and code. `/` opens the insert menu (table, image, code, divider, live link). Selecting text shows bold, italic, strike, code, link and comment.
- **Styles and outline.** The Styles panel edits named styles (font, size, weight, color, spacing) for the whole document. The outline pane lists headings and jumps to them.
- **Comments and suggestions.** Switch to **Suggesting** and type: your edits become suggestions with a word-level diff that anyone, human or Claude, can accept or reject. Comments anchor to a selection and take replies.
- **Live links.** Insert a chart, table or output from a Code Grounds cell, a canvas, a video or animation frame, a slide, or any asset. They update when the source changes.
- **Export** (download icon): Word (comments and open suggestions become Word comments and tracked changes), PDF (real, searchable text in every script, with links and bookmarks), Markdown (with an images folder when needed) and HTML. Live links are exported as they look at that moment.

### Slideshows (features 38–42)

Create a **Slideshow**.

- **Canvas, layouts, masters, themes.** **+ Slide** offers six layouts built from master slides. Click to select, drag to move with smart guides, and use the handles to resize or rotate. Double-click text to edit it (inline markdown: bullets, bold, links). The inspector covers element, slide and theme: five theme presets plus every color, font and size token, masters, slide size, backgrounds and transitions.
- **Builds on a timeline** (bottom panel → Animations). Each element can fade, fly, zoom, pulse, spin or exit, on entering the slide, on a click or with the previous effect. Bars sit in columns per click: drag a bar to change its delay, drag across columns (or press ↑/↓) to move it to another click, and drag its end to change the duration. **Enter**, **Click 1** and so on preview each step, using the same animation engine as the timeline editors.
- **Notes and rehearsal.** Speaker notes sit under the slide. **Present** (F5 from the start, Shift+F5 from the current slide) shows transitions and builds, plays video, animation and live charts, and adds a presenter view with notes, the next slide and timers. **Rehearse** records time per slide and saves it.
- **Import and export.** **Import** takes PowerPoint (.pptx), PDF, and, when LibreOffice is installed, .ppt, .odp and .key.
  - PowerPoint brings in text with formatting and bullets, positions, shapes, pictures (with crops), video, native charts, backgrounds, notes, hidden slides, transitions, and entrance, emphasis and exit animations with their clicks.
  - PDF pages arrive as pictures.
  - **Export** writes PowerPoint (editable text, shapes, native charts, pictures, video, notes, transitions and builds), PDF (searchable), a PDF handout with notes, or PNG images.
- **Web link.** Theme tab → **Web link**: anyone with the link can watch the deck at `/present/<id>`, always the latest version, without an account. The link shows the deck and what its live links need, nothing else: no speaker notes, no code, no comments, no other media. Turning it off (or undoing the change that turned it on) closes the link.
- **Live content.** Slides embed video clips (playing while presenting), animated sequences (looping) and live charts from Code Grounds.

## What was built

**Core** (`packages/core`):
- Document blocks, outline, suggestions (`suggestOp`, atomic accept and reject) and comments.
- Slide layouts and masters, theme presets, slide creation, duplication and re-layout.
- `deckDependencies` (everything a deck needs, following live links).
- `spansToInline` (styled text back to inline markdown, used by importers).
- Vertical text alignment and explicit click steps for animations.

**Renderer** (`packages/render`):
- `renderSlide` with build playheads, playing media and per-element skipping.
- Transitions, plus shared helpers (`slideTextLook`, `slideBackground`, `fitShape`) that keep the editor, presenter and PowerPoint export consistent.

**Exporters** (`packages/exporters`):
- `document.ts`: DOCX, PDF, Markdown and HTML.
- `deck.ts`: PowerPoint via pptxgenjs, plus a finishing pass that fixes multi-run paragraphs, renumbers shape ids, and adds transitions and timing XML. Also PDF and handouts.
- `pptxImport.ts` with a small OOXML reader (`ooxml.ts`): placeholders resolved through layouts and masters, theme colors with modifiers, fonts, bullets, groups, preset and custom geometry, charts, video, notes, transitions and animations.

**Server** (`packages/server`):
- Document export handler.
- Slides module:
  - export as `pptx`, `pdf`, `pdf-notes`, `png`
  - import at `POST /api/projects/:id/decks/:deckId/import`
  - share at `POST/DELETE …/share`
  - public `GET /api/present/:shareId`, with deck-scoped asset routes
- Asset routes refactored so the same code serves the signed-in library and shared decks.
- Claude module:
  - `POST /api/claude/self-test`, the connection test, through a real MCP client
  - `GET /api/claude/setup-info`
- `add_note` MCP tool.
- *Launch kit* sample template.
- Setup progress keeps the chosen preset.
- Projects created from templates use the creator's AI choice.

**Web** (`packages/web`):
- Document editor, slideshow editor (stage, sorter, inspector, build timeline, notes, presenter) and public presentation page.
- Setup guide, troubleshooting page and dashboard tour.
- All new strings live in the message catalog.

## Tests

`pnpm test` runs 250 tests in two projects (node and web), and `pnpm test:e2e` runs 7 browser tests. This phase adds:
- **Core:** document and deck helpers, `deckDependencies`, and round trips for the inline-markdown serializer.
- **Renderer:** click steps across elements, shapes stretching with their element, the title text look.
- **Exporters:** the PowerPoint importer against a real `.pptx` made with python-pptx (`packages/exporters/test/fixtures/make-pptx.py`), an export → import round trip, valid slide and timing XML, colors, and PDF pages and handouts.
- **Server:**
  - document exports checked with LibreOffice, pandoc and pdftotext when present
  - PowerPoint import through the API
  - PPTX export that LibreOffice opens
  - searchable PDF and handout
  - PNG export and PDF import
  - share links: public view without notes, the asset allow-list, closing on turn-off and reopening on undo
  - setup progress, the connection test in every mode, the sample project, and AI consent from templates
- **Web (jsdom):** the setup guide (resume, save and move on, back, storage explanation, copy URL, local address warning, permissions, preset keyboard control, test results with fixes, sample consent) and troubleshooting (anchors and the filter).

`pnpm test:e2e` adds `e2e/phase3.spec.ts`. It covers:
- a document with shortcuts, a table, an accepted suggestion and a comment that survive a reload
- a slideshow that is edited, animated, presented, imported into and watched through its public link while signed out, until the link is turned off
- the setup guide from start to finish, with the connection test, troubleshooting, the sample project and the tour

## Decisions and why

- **Inline markdown inside blocks.** Text is stored as `**bold**`, `[link](url)` and so on inside each block. Claude reads and writes it without a schema lesson, diffs stay readable, and the same text renders in documents, slides and exports.
- **Suggestions are nodes, and accepting is one atomic change.** Claude's suggestions and yours behave the same, and an accepted suggestion undoes as one step.
- **Live links resolve at render and export time.** Documents and slides never hold stale copies; exports state that live links were captured as they looked.
- **One renderer for everything a slide becomes.** The editor stage, sorter thumbnails, presenter, public link, PDF and PNG all call `renderSlide`. PowerPoint export takes text styling from the same `slideTextLook`, so what you see matches what you send.
- **Click steps are explicit.** Builds used to count clicks per element, so "A on click 1, B on click 2" was impossible. Each on-click animation now records its click, PowerPoint builds map one to one, and the timeline can move bars between clicks.
- **The deck's `shareId` is the source of truth for public links.** The share index only finds the deck. Undo and redo of "turn on link" work naturally, and turning sharing off takes effect immediately. The shared view is built from the deck and what it links to, with notes, code and other media removed.
- **The connection test does what Claude does.** It goes over HTTP through the real MCP endpoint with a short-lived key in the chosen mode, so it catches proxy, auth and permission problems that a health check would miss. It writes into a small dedicated project rather than one of yours.
- **AI consent is never inherited from a template.** Whoever creates the project decides. The sample project shows the choice as a checkbox.
- **PowerPoint through pptxgenjs plus a finishing pass.** pptxgenjs is reliable for shapes, charts and media. The finishing pass fixes what it gets wrong (paragraph properties repeated per run, duplicate shape ids) and adds what it lacks (transitions and build timing), and it is verified by re-importing and by opening the file in LibreOffice.

## Incomplete in this phase

- **Claude.ai sign-in (OAuth) is Phase 4.** Steps 3–4 describe the connector and approval screen, and the connection test and Claude Code/Desktop with access tokens work now. Adding Omnix in claude.ai needs the OAuth endpoints, which come with the connector work in Phase 4.
- **Claude's write tools for documents and slides** (beyond `add_note`) are Phase 4. Suggestions and proposals already accept AI authors.
- **Slides import limits:**
  - PowerPoint tables arrive as text, and SmartArt and ink are skipped.
  - Gradient fills become solid colors, and elbow connectors become straight lines.
  - Motion paths are not imported.
  - Custom keyframe animations are not written to PowerPoint.
  - PDF import brings pages in as pictures.
- **PDF slide export** draws each slide as a picture with an invisible text layer (searchable and selectable), not as vector shapes.
- **The audience view does not follow the presenter.** Someone watching the public link moves through slides on their own. A follow mode belongs with the collaboration work in Phase 5.
