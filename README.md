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
pnpm start          # starts the server on http://localhost:4317
```

Data is stored in `./.omnix-data` (projects, the activity log, and content-addressed media). Stop the server with Ctrl+C; it saves before exiting, and recovers changes even after a crash.

Useful scripts:

| Command | What it does |
| --- | --- |
| `pnpm start` | Run the server |
| `pnpm dev:server` | Run the server with auto-reload |
| `pnpm test` | Run the test suite |
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

## Connect Omnix to Claude

Omnix speaks MCP at `http://localhost:4317/mcp` (Streamable HTTP) and `/sse` (legacy).

**Claude Desktop or Claude Code (stdio).** Create a personal access token with `POST /api/auth/tokens` (a settings screen arrives with the web app), then add Omnix as a local MCP server:

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
| `packages/server` | HTTP API, realtime hub, storage, asset pipeline, jobs, MCP server |

Documentation:

- [`docs/MCP_TOOLS.md`](docs/MCP_TOOLS.md): MCP tool catalog (generated)
- [`docs/phases`](docs/phases): what was built in each phase, decisions and gaps

## License

Not yet specified.
