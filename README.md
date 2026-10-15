# Omnix

Omnix is a creative studio where an AI collaborator is a first-class participant. It combines an image editor, a video editor, an animation maker, a code workspace (Code Grounds), a document editor and a slideshow builder in one project. Every capability is exposed through the Model Context Protocol (MCP), so Claude can read the canvas, make edits, render previews and hand finished work back, while you set the direction and approve the results.

> **Status:** all six phases are built. [`docs/phases`](docs/phases) describes what each phase delivered and the decisions behind it; [the final review](docs/phases/phase-6-review.md) lists what was checked and fixed, and what is still not done and why.

## Requirements

- Node.js 22 or newer and pnpm 10 (`corepack enable` gives you pnpm)
- ffmpeg and ffprobe on your `PATH` (video and audio import, proxies, export)
- Optional: PostgreSQL (otherwise Omnix stores everything in a local folder)
- Optional: Poppler's `pdftoppm` (import PDF pages as slides) and LibreOffice (import `.ppt`, `.odp` and `.key` slideshows)

## Run Omnix locally

```bash
pnpm install
pnpm build          # builds the web app
pnpm start          # starts Omnix on http://localhost:4317
```

Open http://localhost:4317 and create the owner account. Data is stored in `./.omnix-data` (projects, the activity log, and content-addressed media). Stop the server with Ctrl+C; it saves before exiting, and recovers changes even after a crash. Edits you make in the browser are kept locally until the server confirms them, so a dropped connection or a closed tab does not lose work.

For development, `pnpm dev` runs the server with auto-reload and the web app with hot reload on http://localhost:5173 (it proxies the API to the server).

Useful scripts:

| Command | What it does |
| --- | --- |
| `pnpm start` | Run Omnix (serves the built web app) |
| `pnpm share` | Run Omnix with a public address for claude.ai, Claude Desktop and the phone app (needs cloudflared) |
| `pnpm build` | Build the web app |
| `pnpm dev` | Server and web app with live reload |
| `pnpm dev:server` | Run the server with auto-reload |
| `pnpm test` | Run the unit and integration tests (server, engines and web) |
| `pnpm test:e2e` | Drive the app in Chromium against a fresh server (run `pnpm build` first) |
| `pnpm typecheck` | Type-check every package |
| `pnpm catalog` | Regenerate the MCP tool catalog in `docs/` |
| `pnpm bench` | Time the hot paths (editing, history, comparisons, diffs, rendering) on a large project |
| `pnpm mcp:stdio` | MCP over stdio (bridges to the running server) |

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMNIX_PORT` | `4317` | HTTP port |
| `OMNIX_HOST` | `0.0.0.0` | Address to listen on (`127.0.0.1` keeps Omnix to this computer) |
| `OMNIX_PUBLIC_URL` | `http://localhost:4317` | Public base URL (used for Claude connector and share links) |
| `OMNIX_DATA_DIR` | `.omnix-data` | Local data folder |
| `OMNIX_DATABASE_URL` | unset | `postgres://...` to store projects in Postgres |
| `OMNIX_S3_BUCKET`, `OMNIX_S3_ENDPOINT`, `OMNIX_S3_REGION`, `OMNIX_S3_ACCESS_KEY_ID`, `OMNIX_S3_SECRET_ACCESS_KEY` | unset | S3-compatible media storage |
| `OMNIX_S3_FORCE_PATH_STYLE` | `true` | Path-style S3 addresses (set `false` for virtual-hosted buckets) |
| `OMNIX_MAX_UPLOAD_MB` | `4096` | Largest single upload. Long videos need the default; lower it on a server shared with people you do not know |
| `OMNIX_OPEN_SIGNUP` | `false` | Allow more than the first account to sign up |
| `OMNIX_FFMPEG`, `OMNIX_FFPROBE` | `ffmpeg`, `ffprobe` | Paths to the media tools |
| `OMNIX_PDFTOPPM` | `pdftoppm` | Poppler tool used to import PDF pages as slides |
| `OMNIX_SOFFICE` | `soffice` | LibreOffice, used to convert `.ppt`, `.odp` and `.key` files before importing them |
| `ANTHROPIC_API_KEY` | unset | Optional: lets Omnix's built-in agent runner run goals with Claude, and hand commands the built-in parser does not understand to Claude |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Optional gateway or proxy for the Claude API |
| `OMNIX_AGENT_MODEL` | newest available | Model for the agent runner; when unset Omnix asks the Models API for the newest model your key can use |
| `OMNIX_IMAGE_GEN_URL`, `OMNIX_IMAGE_GEN_API_KEY`, `OMNIX_IMAGE_GEN_MODEL` | unset | Optional image model for generative fill and extend: any server speaking the OpenAI images edit API (`…/images/edits`). Without one, Omnix fills areas from their surroundings |
| `OMNIX_STT_URL` | unset | OpenAI-compatible speech-to-text endpoint for automatic captions (otherwise speech detection leaves timed caption slots) |
| `OMNIX_PLUGINS_DIR` | `<data folder>/plugins` | Folder of installed plugins (see [`docs/PLUGINS.md`](docs/PLUGINS.md)) |
| `OMNIX_WEB_DIST` | `packages/web/dist` | The built web app to serve |
| `OMNIX_SANDBOX_ISOLATION` | `required` | Code Grounds runs code only where Node's permission model keeps it away from the server's files (Node 22.13 or newer). `best-effort` runs code anyway, for servers where only trusted people run code |

## Connect Omnix to Claude

**The short version is [`docs/CONNECT.md`](docs/CONNECT.md).** For Claude Code, run `pnpm start` and `claude mcp add --transport http omnix http://localhost:4317/mcp`. For claude.ai, Claude Desktop and the phone app, run `pnpm share` and paste the address it prints into https://claude.ai/settings/connectors.

The quickest way is the built-in guide: **Help → Claude setup guide** (`/setup`). It walks through seven steps, saves your progress, and ends with a connection test that reads your project list and writes a blank test note exactly as Claude would, with a fix for anything that fails. **Help → Troubleshooting** covers connection errors, expired sign-ins, permission problems and disconnecting.

Omnix speaks MCP at `http://localhost:4317/mcp` (Streamable HTTP) and `/sse` (legacy). Claude.ai and the Claude apps reach connectors over the internet, so a server on your own computer needs an HTTPS address. `pnpm share` opens a Cloudflare tunnel and sets `OMNIX_PUBLIC_URL` for you; on your own server, set `OMNIX_PUBLIC_URL` to its address. Claude Code and Claude Desktop with a local config work with `localhost` directly.

**claude.ai and the Claude apps.** In Claude, open **Settings → Connectors → Add custom connector**, name it Omnix and enter your MCP URL (`https://your-omnix-address/mcp`). Leave the OAuth fields empty: Omnix registers Claude itself. Click **Connect**; your Omnix server opens an approval screen that says what Claude is asking for, lets you pick the permission (view only, edit with approval, or autonomous) and which projects it may reach, and sends you back to Claude. You can change the permission or disconnect at any time from the dashboard's Claude card or **Settings → Claude**.

**Claude Code (HTTP).** Add the server, then type `/mcp` in Claude Code and choose **Authenticate**; your browser opens the same approval screen:

```bash
claude mcp add --transport http omnix http://localhost:4317/mcp
```

Or skip the browser with an access token from **Settings → Claude**:

```bash
claude mcp add --transport http omnix http://localhost:4317/mcp --header "Authorization: Bearer omx_..."
```

**Claude Desktop or Claude Code (stdio).** Create an access token in **Settings → Claude**, then add Omnix as a local MCP server:

```json
{
  "mcpServers": {
    "omnix": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/omnix", "mcp:stdio"],
      "env": { "OMNIX_URL": "http://localhost:4317", "OMNIX_TOKEN": "omx_..." }
    }
  }
}
```

Each change Claude makes is attributed to Claude in the project history, appears in the activity feed, and can be undone. Claude can only change a project after you turn on **Allow AI** for that project.

## Working with Claude in Omnix

- **Permission modes.** *View only*: Claude reads. *Edit with approval*: every change arrives as a proposal (related changes stack into one, with a named step each) that you preview on the canvas, accept, modify (keep or drop steps, edit values) or reject. *Autonomous*: changes apply directly in the projects you allowed, and long runs stop at your approval gates.
- **Describe a change** (the wand in a project, or `Ctrl+Shift+K`, or just type a sentence in the command palette). "Make the sky warmer and move the title to the lower third" becomes a proposal with one step per phrase. Omnix's own parser handles common edits in every editor; with `ANTHROPIC_API_KEY` set, requests it does not understand go to Claude and come back as a proposal too.
- **Run a goal with Claude** (the robot icon in a project). Claude plans stages, works across the editors, saves a named version after each stage, and pauses where you chose: approve the plan, review each stage, before exporting, before deleting, or at moments you describe. Approve, ask for changes, or stop and roll back to any checkpoint. The built-in runner needs `ANTHROPIC_API_KEY`; without it, ask Claude (connected in autonomous mode) to use `agent_start_run`, and the same gates and checkpoints apply.
- **Generative fill and extend.** Select an area in the image editor and click Generate, or grow the canvas to a new shape; mark an area on a video clip to fill it across every frame. The result keeps the generated area as a visible mask, and you can generate again or switch back to the original clip.
- **Match style.** Borrow the color, tone, texture, fonts or motion of a reference picture, clip, slideshow or document. It lands as editable settings: a look adjustment layer or color grade, grain, theme and text styles, easing.
- **Session memory.** The notes panel keeps decisions, prompts and rejected options. Omnix records commands, agent goals, gate decisions and rejected proposals (with your reason) automatically, so the next session, yours or Claude's, starts with the context.
- **AI markers.** A small sparkle marks layers, clips, blocks and slides that Claude changed last; it clears when you edit them.
- **Across tools.** Claude sees every tool in a project at once (`get_project`, `find_in_project`), can turn a document into slides, place code output in documents and slides, and reuse text from one tool in another.

[`docs/WALKTHROUGH.md`](docs/WALKTHROUGH.md) follows Claude through one whole goal, with screenshots: a poster, a brief, a deck built from it, a teaser and the exports, reviewed stage by stage.

## Working together

- **Comments where they belong.** Turn on comment mode (`Ctrl+Alt+M`) and click to pin a comment to a point on a canvas or slide, a moment in a video, a line of code or a phrase in a document. Code comments move with their lines. The Comments panel lists every thread; Claude reads them with `list_comments` and closes them with `resolve_comment`.
- **Typing together.** Two people (or a person and Claude) typing in the same paragraph or code file at once both keep their words: each edit carries the text it was typed over and is merged word by word. Undo takes back only your own words.
- **Live cursors.** Everyone in a project sees where the others are working, Claude included: cursors on canvases and slides, playheads on the timeline, tagged lines in code, and bars beside paragraphs.
- **Compare versions.** Compare any two versions as pictures (side by side, swipe, overlay, or the difference) and as text (paragraphs, code lines, slides), then go back to either one.
- **Asset library.** Uploads are tagged automatically and searchable by name, tag, color, size, kind or `unused`. Identical files are stored once; look-alike copies (resized or re-saved) are found and can be merged, with every use switched to the copy you keep.
- **Batch processing.** Select many files (**Process…**) or documents (**Apply to several documents…**) and resize, convert, grade, remove backgrounds, export, apply a preset or run a plain-language command on all of them as one job.
- **Templates and presets.** Save a project as a template, and layer effects, clip looks, animation rigs, document styles and slide themes as presets (**Presets** page, or the Presets menu in each editor). Presets can be shared with everyone on the same Omnix.
- **Plugins.** Add third-party tools as MCP servers or local modules (**Settings → Plugins**). They appear to Claude, in each project's Plugins panel and as batch operations, and their changes go through the same review and history as everything else. See [`docs/PLUGINS.md`](docs/PLUGINS.md).

## Project layout

| Package | Purpose |
| --- | --- |
| `packages/core` | Scene graph, operations, history (undo, redo, branches, proposals, snapshots), keyframes, paths, IK, timeline edits, markdown, validation, text diffs, version comparison, presets |
| `packages/imaging` | Pixel algorithms shared by browser and server (adjustments, LUTs, filters, blend modes, selections, content-aware fill, background removal, upscaling, style transfer, pixel diffs, perceptual hashes) |
| `packages/render` | Canvas 2D renderer for canvases, video and animation frames, slides, charts and thumbnails |
| `packages/exporters` | PSD (read and write), SVG, GIF, APNG, Lottie, sprite sheets, captions, ffmpeg pipelines, DOCX/PDF/Markdown/HTML documents, PowerPoint export and import, slide PDFs |
| `packages/sandbox` | Isolated code kernels for Code Grounds (Python via Pyodide, JavaScript, TypeScript) |
| `packages/server` | HTTP API, realtime hub and presence, storage, asset pipeline and library, jobs, batch processing, exports, imports, public presentation links, MCP server, OAuth for the Claude connector, the agent runner, commands, generative fill, style reference, version comparison, presets and templates, the plugin host |
| `packages/web` | The web app: dashboard, the six editors, presenter, history and version comparison, proposals, comments, Claude runs, the command bar, the library, presets, plugins, settings, the Claude setup guide and troubleshooting |

Documentation:

- [`docs/CONNECT.md`](docs/CONNECT.md): connecting Claude, the short version
- [`docs/WALKTHROUGH.md`](docs/WALKTHROUGH.md): Claude completing a whole goal, step by step
- [`docs/MCP_TOOLS.md`](docs/MCP_TOOLS.md): MCP tool catalog (generated)
- [`docs/PLUGINS.md`](docs/PLUGINS.md): writing a plugin
- [`docs/phases`](docs/phases): what was built in each phase, decisions and gaps
- [`docs/phases/phase-6-review.md`](docs/phases/phase-6-review.md): the final review, and what could not be fixed

## License

Not yet specified.
