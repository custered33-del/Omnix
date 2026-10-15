# Omnix

Omnix is a creative studio where an AI collaborator is a first-class participant. It combines an image editor, a video editor, an animation maker, a code workspace (Code Grounds), a document editor and a slideshow builder in one project. Every capability is exposed through the Model Context Protocol (MCP), so Claude can read the canvas, make edits, render previews and hand finished work back, while you set the direction and approve the results.

> **Status:** under active construction, phase by phase. See [`docs/phases`](docs/phases) for what each phase delivered and what is still incomplete.

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
| `pnpm build` | Build the web app |
| `pnpm dev` | Server and web app with live reload |
| `pnpm dev:server` | Run the server with auto-reload |
| `pnpm test` | Run the unit and integration tests (server, engines and web) |
| `pnpm test:e2e` | Drive the app in Chromium against a fresh server (run `pnpm build` first) |
| `pnpm typecheck` | Type-check every package |
| `pnpm catalog` | Regenerate the MCP tool catalog in `docs/` |
| `pnpm mcp:stdio` | MCP over stdio (bridges to the running server) |

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMNIX_PORT` | `4317` | HTTP port |
| `OMNIX_PUBLIC_URL` | `http://localhost:4317` | Public base URL (used for Claude connector and share links) |
| `OMNIX_DATA_DIR` | `.omnix-data` | Local data folder |
| `OMNIX_DATABASE_URL` | unset | `postgres://...` to store projects in Postgres |
| `OMNIX_S3_BUCKET`, `OMNIX_S3_ENDPOINT`, `OMNIX_S3_REGION`, `OMNIX_S3_ACCESS_KEY_ID`, `OMNIX_S3_SECRET_ACCESS_KEY` | unset | S3-compatible media storage |
| `OMNIX_OPEN_SIGNUP` | `false` | Allow more than the first account to sign up |
| `OMNIX_FFMPEG`, `OMNIX_FFPROBE` | `ffmpeg`, `ffprobe` | Paths to the media tools |
| `OMNIX_PDFTOPPM` | `pdftoppm` | Poppler tool used to import PDF pages as slides |
| `OMNIX_SOFFICE` | `soffice` | LibreOffice, used to convert `.ppt`, `.odp` and `.key` files before importing them |
| `ANTHROPIC_API_KEY` | unset | Optional: lets Omnix's built-in agent runner run goals with Claude, and hand commands the built-in parser does not understand to Claude |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Optional gateway or proxy for the Claude API |
| `OMNIX_AGENT_MODEL` | newest available | Model for the agent runner; when unset Omnix asks the Models API for the newest model your key can use |
| `OMNIX_IMAGE_GEN_URL`, `OMNIX_IMAGE_GEN_API_KEY`, `OMNIX_IMAGE_GEN_MODEL` | unset | Optional image model for generative fill and extend: any server speaking the OpenAI images edit API (`…/images/edits`). Without one, Omnix fills areas from their surroundings |
| `OMNIX_STT_URL` | unset | OpenAI-compatible speech-to-text endpoint for automatic captions (otherwise speech detection leaves timed caption slots) |

## Connect Omnix to Claude

The quickest way is the built-in guide: **Help → Claude setup guide** (`/setup`). It walks through seven steps, saves your progress, and ends with a connection test that reads your project list and writes a blank test note exactly as Claude would, with a fix for anything that fails. **Help → Troubleshooting** covers connection errors, expired sign-ins, permission problems and disconnecting.

Omnix speaks MCP at `http://localhost:4317/mcp` (Streamable HTTP) and `/sse` (legacy). Claude.ai and the Claude apps reach connectors over the internet, so a server on your own computer needs an HTTPS address (for example a tunnel such as `cloudflared tunnel --url http://localhost:4317`) set as `OMNIX_PUBLIC_URL`. Claude Code and Claude Desktop with a local config work with `localhost` directly.

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

## Project layout

| Package | Purpose |
| --- | --- |
| `packages/core` | Scene graph, operations, history (undo, redo, branches, proposals, snapshots), keyframes, paths, IK, timeline edits, markdown, validation |
| `packages/imaging` | Pixel algorithms shared by browser and server (adjustments, LUTs, filters, blend modes, selections, content-aware fill, background removal, upscaling, style transfer) |
| `packages/render` | Canvas 2D renderer for canvases, video and animation frames, slides, charts and thumbnails |
| `packages/exporters` | PSD (read and write), SVG, GIF, APNG, Lottie, sprite sheets, captions, ffmpeg pipelines, DOCX/PDF/Markdown/HTML documents, PowerPoint export and import, slide PDFs |
| `packages/sandbox` | Isolated code kernels for Code Grounds (Python via Pyodide, JavaScript, TypeScript) |
| `packages/server` | HTTP API, realtime hub, storage, asset pipeline, jobs, exports, imports, public presentation links, MCP server, OAuth for the Claude connector, the agent runner, commands, generative fill and style reference |
| `packages/web` | The web app: dashboard, the six editors, presenter, history, proposals, Claude runs, the command bar, settings, the Claude setup guide and troubleshooting |

Documentation:

- [`docs/MCP_TOOLS.md`](docs/MCP_TOOLS.md): MCP tool catalog (generated)
- [`docs/phases`](docs/phases): what was built in each phase, decisions and gaps

## License

Not yet specified.
