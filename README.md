# Omnix

Omnix is a creative studio where an AI collaborator is a first-class participant. It combines an image editor, a video editor, an animation maker, a code workspace (Code Grounds), a document editor and a slideshow builder in one project. Every capability is exposed through the Model Context Protocol (MCP), so Claude can read the canvas, make edits, render previews and hand finished work back, while you set the direction and approve the results.

> **Status:** under active construction, phase by phase. See [`docs/phases`](docs/phases) for what each phase delivered and what is still incomplete.

## Requirements

- Node.js 22 or newer and pnpm 10 (`corepack enable` gives you pnpm)
- ffmpeg and ffprobe on your `PATH` (video and audio import, proxies, export)
- Optional: PostgreSQL (otherwise Omnix stores everything in a local folder)

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
| `ANTHROPIC_API_KEY` | unset | Optional: lets Omnix's own agent runner and command parser call Claude directly |
| `OMNIX_AGENT_MODEL` | newest available | Model for the agent runner; when unset Omnix picks the newest model your key can use |
| `OMNIX_STT_URL` | unset | OpenAI-compatible speech-to-text endpoint for automatic captions (otherwise speech detection leaves timed caption slots) |

## Connect Omnix to Claude

Omnix speaks MCP at `http://localhost:4317/mcp` (Streamable HTTP) and `/sse` (legacy).

**Claude Desktop or Claude Code (stdio).** Create a personal access token in **Settings → Access tokens**, then add Omnix as a local MCP server:

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

## Project layout

| Package | Purpose |
| --- | --- |
| `packages/core` | Scene graph, operations, history (undo, redo, branches, proposals, snapshots), keyframes, paths, IK, timeline edits, markdown, validation |
| `packages/imaging` | Pixel algorithms shared by browser and server (adjustments, LUTs, filters, blend modes, selections, content-aware fill, background removal, upscaling, style transfer) |
| `packages/render` | Canvas 2D renderer for canvases, video and animation frames, slides, charts and thumbnails |
| `packages/exporters` | PSD (read and write), SVG, GIF, APNG, Lottie, sprite sheets, captions and ffmpeg export pipelines |
| `packages/sandbox` | Isolated code kernels for Code Grounds (Python via Pyodide, JavaScript, TypeScript) |
| `packages/server` | HTTP API, realtime hub, storage, asset pipeline, jobs, exports, imports, MCP server |
| `packages/web` | The web app: dashboard, editors, history, proposals and settings |

Documentation:

- [`docs/MCP_TOOLS.md`](docs/MCP_TOOLS.md): MCP tool catalog (generated)
- [`docs/phases`](docs/phases): what was built in each phase, decisions and gaps

## License

Not yet specified.
