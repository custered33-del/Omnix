# Phase 1: Foundation

## What was built

**Scene graph and operation log (`packages/core`)**
- One typed scene graph covers all six tools. A project node holds canvases (layers), sequences (tracks, clips, animation layers), code workspaces (files, notebooks, cells), documents (blocks, suggestions), decks (slides, elements), plus session-memory notes and pinned comments.
- Every edit is an immutable `Operation` (`create`, `delete`, `update`, `move`, `listInsert`, `listRemove`, `listUpdate`, `batch`). `applyOp` returns the new state and an exact inverse. Batches are atomic. The applier enforces the node hierarchy, blocks cycles, duplicate ids and prototype-pollution keys.
- `ProjectSession` keeps an append-only commit tree:
  - **Undo/redo is per author** and recorded as new commits, so collaborators' later work is never thrown away and the log stays auditable.
  - **Branching**: `checkout` any commit; new commits start a branch; old branches stay reachable.
  - **Proposals**: AI (or human) changes can be proposed, previewed with a structural diff, accepted (optionally modified) or rejected. Accepted commits record both the proposer and the approver.
  - **Snapshots** name versions; `diffCommits` compares any two.
- Shared engines: keyframes and easing (CSS-exact cubic-bezier), bezier paths with arc-length sampling, 2D FABRIK inverse kinematics, timeline edit builders (split, ripple delete/trim, roll, slip, slide, move, speed with ramps and reverse), markdown <-> document blocks, and zod schemas that validate every operation arriving from outside the process.

**Imaging (`packages/imaging`)**: pure pixel operations shared by browser, server and workers: adjustments (curves, levels, hue/saturation, color balance, brightness/contrast, temperature, `.cube` 3D LUTs), smart filters, all 16 W3C blend modes, anti-aliased selections, magic wand, quick select, object select, content-aware fill (exemplar-based, onion-peel order, summed-area validity checks), healing, outpainting, Lanczos upscaling, chroma and automatic background removal, and Reinhard style transfer.

**Renderer (`packages/render`)**: one Canvas 2D renderer used by the browser and the server (Skia via `@napi-rs/canvas`): layer compositing with masks, adjustment layers, smart filters, a dab-based brush engine (pressure, hardness, custom tips, eraser, clone, heal), rich text and text on paths; sequence frames with transitions, keyframes, titles/captions, effects and background removal; animation layers (frame holds, onion skin, sprite sheets, IK rigs, motion paths); slides with build animations; live embeds; charts; project thumbnails.

**Server (`packages/server`)**
- Storage: one `DocStore` interface with three backends: a zero-config file store (atomic writes, JSON Lines logs), Postgres (JSONB), and memory. Blobs are content-addressed (SHA-256) on local disk or S3-compatible storage (own SigV4 signer, verified against the AWS test vector).
- Asset pipeline: magic-byte type detection, deduplication, metadata (dimensions, duration, fps, codecs, audio, ICC profile description, a privacy-conscious EXIF subset without GPS), thumbnails, waveforms, and H.264 editing proxies for heavy or non-browser codecs via a persistent job queue.
- Project service: validation, AI consent, roles (owner/editor/viewer), optimistic concurrency, durable commit log plus debounced checkpoints, crash recovery that replays commits logged after the last checkpoint, and the activity feed.
- REST API, WebSocket realtime hub (commits, presence, proposals, activity, jobs), and server-side rendering endpoints.
- **Minimal MCP server**: Streamable HTTP (`/mcp`), legacy SSE (`/sse`), and stdio (`pnpm mcp:stdio`, bridging to the running server). Read tools: `list_projects`, `get_project`, `get_node`, `get_history`, `get_selection`, `list_notes`, `render_preview`, `list_assets`, `get_asset`. Read-only resources for projects, scene tree, layers, timeline, code, document, slides, selection, notes and assets.

## Tests

`pnpm test` runs 126 tests at the end of this phase, covering the operation log (inverse round-trips for every op kind, atomic batches, hierarchy rules), history (per-author undo/redo, branching, proposals, snapshots, persistence), timeline edits, imaging algorithms, renderer output (pixel-checked), every storage backend (including a real throwaway Postgres cluster), the asset pipeline with real ffmpeg-generated media, the REST API, crash recovery, realtime fan-out, and MCP over all three transports with the official SDK client.

## Decisions and why

- **Selective, per-author undo recorded as commits** instead of moving a head pointer. In a shared project, Ctrl+Z must only undo *your* change, and an append-only log keeps every AI action attributable and reversible.
- **Canvas 2D for rendering, not WebGPU (yet).** The same renderer runs in the browser and on the server, so previews, thumbnails, Claude's `render_preview` and exports match pixel for pixel. WebGPU is not available headless on the server. Heavy pixel work is isolated in `@omnix/imaging` so it can move to WebGPU or workers later without changing callers.
- **File store by default, Postgres optional.** Omnix runs with zero setup; the same interface backs Postgres for teams.
- **Own SigV4 signer** instead of the full AWS SDK: four calls, verified against AWS's published example.
- **MCP write tools deferred to Phase 4** as the build plan specifies, but the tool registry, permission modes (view / approve / autonomous) and the proposal plumbing are in place now.

## Incomplete in this phase

- No web UI yet (Phase 2). The server serves a placeholder page.
- OAuth for the Claude connector arrives in Phase 4; Phase 1 authenticates MCP with personal access tokens.
