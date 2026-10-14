# Phase 2: Dashboard and the core editors

Phase 2 adds the web app: the calm dashboard and four of the six editors (image, video, animation and Code Grounds). Each editor reads and writes the shared scene graph from Phase 1, so every edit lands in the same history as Claude's edits. Every edit can be undone, shows up in the activity feed, and syncs live to everyone in the project.

## Walkthrough

Start Omnix with the web app:

```bash
pnpm install
pnpm build      # builds the web app into packages/web/dist
pnpm start      # http://localhost:4317
```

1. **First run.** Open the app and create the owner account. Omnix then opens the Claude setup guide; that page arrives in Phase 3, so go back to **Home**.
2. **Dashboard.** The dashboard shows your recent projects with thumbnails, a create row for all six tools plus templates, recent assets (drop files anywhere on the strip), the Claude status card and the activity feed. There is no chat box: you work in the editors, and Claude works through MCP. Press **Ctrl/⌘ K** for the command palette and **?** for every shortcut.
3. **Image editor.** Click **Image editor**.
   - Draw a shape (U), paint (B), add text (T, click on the canvas and type), select with the marquee (M), lasso (L), magic wand (W), quick select (Q) or object select (O; drag a box around the object).
   - With an active selection, the toolbar offers content-aware fill, fill, clear, crop, mask from selection and invert. Painting stays inside the selection.
   - **Layers** (top right): drag to reorder, drop onto a group's middle to nest, double-click to rename, use the eye and lock icons, and change blend mode and opacity. Add pixel, text, shape, fill and group layers, place images, open a PSD, or add any of eight adjustment layers: brightness and contrast, levels, curves, hue and saturation, color balance, temperature, invert, and a LUT (`.cube` files).
   - **Properties** edit the selected layer: transform, text (variable weight, tracking, baseline, text on a curve), shapes, adjustment controls (including an interactive curves editor), the layer mask, and smart filters that stay editable.
   - Clone stamp and healing brush: Alt-click to set the source, then paint. Space held pans, Ctrl/⌘ +/−/0 zoom, arrows nudge, `[` and `]` resize the brush, X swaps colors.
4. **Video editor.** Create a video project and drop a video and an audio file onto the **Media** panel. Double-click (or drag) them onto the timeline.
   - Edit tools along the timeline bar: select, ripple, roll, slip, slide and razor (Alt+V/B/N/Y/U/C). Edges trim; snapping (magnet) catches clip edges and the playhead.
   - **S** splits at the playhead, **Shift+Del** ripple-deletes, Space/J/K/L control playback, arrows step frames, ↑/↓ jump between edits.
   - The inspector edits position, scale, rotation, opacity, blur and volume. The diamond adds a keyframe at the playhead, and each keyframe has an easing curve you can draw. It also covers speed (rippling later clips), reverse, speed ramps, transitions in and out, effects, chroma-key or automatic background removal, titles and captions.
   - **Captions**: generate them (with a speech-to-text service, or speech detection that leaves timed slots to type into), import SRT/VTT, and edit every line in one table.
   - **Mixer**: per-track gain fader, pan, mute, solo, ducking (for example, music ducks under dialogue) and live level meters.
5. **Animation maker.** Draw on the stage with the brush; **+** in Frames adds the next drawing, holds stretch a drawing over several frames, and onion skin shows the neighbours. Build a skeleton with the bone tool (start at a bone's tip to chain), then switch to pose mode and drag a bone's end: the chain follows with IK and the pose is saved at the playhead. Draw a motion path for the layer to follow, tween any transform with keyframes and curves, import a sprite sheet, and pick once, loop or ping-pong playback.
6. **Code Grounds.** Run `main.py` (Ctrl/⌘ Enter). Open the notebook and run cells with Shift+Enter. Python cells can call `omnix.chart(...)` and `omnix.table(...)`. Charts are interactive: hover for values, or switch to a table view. The terminal accepts `run <file>`, `python <code>`, `js <code>`, `ls`, `cat`, `restart`. **History** shows every change as a git commit with diffs, and Claude's changes are marked. **Sandbox** controls network access and bundled packages.
7. **Export** (download icon in the project bar): PNG, JPEG, WebP, AVIF, SVG or layered PSD for images; social, web and broadcast presets plus audio-only for video; GIF, APNG, WebM, MP4, Lottie and sprite sheets for animation; ZIP or Jupyter for code.

## What was built

**App shell** (`packages/web`): Vite + React 19. Pages for sign-in, dashboard, asset library, activity, settings (appearance, pen pressure, access tokens) and projects. There is a command palette and a shortcut sheet. Themes are light, dark and high-contrast with a reduced-motion option, and all strings go through `t()` for translation.

**Project frame**: document tabs, live save status, presence avatars, undo/redo of your own changes, and drawers for proposals (preview, accept, modify, reject), history (restore any version, revert one change), session memory notes and activity. There are also export and per-project AI consent.

**Editing model in the browser**:
- Edits apply instantly and go to the server over WebSocket. The server confirms or rejects each one, and a rejected edit rolls back.
- Unconfirmed edits are kept in local storage. After a crash or reload they are recovered and sent again.
- Sliders and drags preview with transient overrides and commit a single history entry when you let go.

**Media in any browser**: when a browser cannot decode H.264 or AAC (some Linux Chromium and Firefox builds), the video editor switches automatically. It draws frames rendered by the server (`/api/assets/:id/frame`) and plays an MP3 audio track made on demand (`/api/assets/:id/audio`).

**Server additions**:
- Built-in templates and user templates.
- Claude status endpoint.
- PSD import into editable layers (`POST /api/projects/:id/import/psd`).
- Code workspace export as ZIP or `.ipynb`.
- Frame and audio fallback endpoints.

## Tests

`pnpm test` now runs 189 tests in two projects:
- **node** covers the server, the engines and the new endpoints:
  - PSD round trip that renders identically
  - code ZIP and Jupyter export
  - a startup check that loads the server under plain Node, catching CommonJS/ESM interop crashes that Vitest hides
- **web** runs in jsdom:
  - the optimistic store (instant edits, confirmation, rejection, crash recovery, transient commits)
  - timeline snapping and timecode
  - animation layer-space maths
  - markdown rendering and link sanitizing
  - the chart table view
  - code outputs
  - the easing editor (mouse and keyboard)
  - the dashboard

`pnpm test:e2e` (after `pnpm build`) drives the real app in Chromium against a fresh server:
- image editing that survives a reload
- video import, titles, split, playback and the mixer
- animation frames and bones
- Code Grounds files, cells and charts

## Decisions and why

- **One timeline engine for video and animation.** Both are sequences of tracks; the animation maker adds frame drawing, onion skin, rigs and motion paths on animation tracks. Edits, keyframes, easing, export and MCP tools are shared.
- **Non-destructive by default.** Background removal becomes a layer mask, and clearing selected pixels subtracts from the mask. Fill creates a masked fill layer, and content-aware fill adds a new layer. Nothing is lost, and Claude's edits can be reviewed the same way.
- **Selections are document data** (stored on the canvas), so Claude can see and use the current selection, and painting respects it on every renderer.
- **Server frames as a fallback, not a requirement.** Real-time preview uses the browser's decoder when it can. The fallback keeps the editor usable everywhere rather than refusing to open.
- **Text layers name themselves** after their first line until renamed, as in Photoshop, so the layers list stays readable for people and for Claude.

## Incomplete in this phase

- The document editor, slideshow builder, Claude setup guide and troubleshooting pages are placeholders. They are Phase 3.
- Generative fill, extend and style reference, natural-language commands and Claude's write tools are Phase 4. The image editor already has the non-generative versions (content-aware fill, extend canvas through canvas size, style transfer in the imaging library).
- Pinned comments on canvases and timelines, live cursors in every editor and the visual version diff are Phase 5. Presence, cursors in the image editor and playhead sharing work now.
- Layers do not yet show which were made by Claude. Attribution is in history and activity; a per-layer marker comes with Phase 4.
