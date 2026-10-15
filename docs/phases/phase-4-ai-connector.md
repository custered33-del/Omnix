# Phase 4: AI integration and the Claude connector

Phase 4 lets Claude work inside Omnix end to end. Claude connects as a connector with OAuth, every editor has write tools, AI changes arrive as reviewable proposals, and a person can describe a change in plain words. Claude can also run a whole goal across the editors, stopping at the approval points the person chooses. Generative fill and extend, style reference, session memory and cross-tool context complete features 43 to 50.

## Walkthrough

```bash
pnpm install
pnpm build
pnpm start      # http://localhost:4317
```

Optional settings:
- `ANTHROPIC_API_KEY` turns on the built-in agent runner, and lets Omnix hand commands it cannot parse to Claude.
- `OMNIX_IMAGE_GEN_URL` (with `…_API_KEY` and `…_MODEL`) connects an image model for generative fill.

Without them, everything else works. Claude runs goals through its own connection, and fills come from the image's surroundings.

### Connect Claude (feature 43)

In claude.ai: **Settings → Connectors → Add custom connector**, then enter `https://your-omnix/mcp`. Leave the OAuth fields empty.

When you click **Connect**, Omnix opens its approval screen. It:
- says in plain words what Claude asks for (see your projects, propose changes, work on its own)
- lets you pick the permission: view only, edit with approval, or autonomous
- lets you pick which projects Claude may reach (all, or the ones you tick)

**Approve** sends you back to Claude. In Claude Code, run `claude mcp add --transport http omnix http://localhost:4317/mcp`, then type `/mcp` and choose **Authenticate**. Access tokens from **Settings → Claude** still work for scripts.

Each connection appears on the dashboard's Claude card and in **Settings → Claude**. There you can switch its mode, which applies from Claude's next request, or disconnect it.

### Review what Claude changes (feature 45)

In **edit with approval**, every change Claude makes becomes a proposal. Related changes from the same conversation stack into one proposal, with a named step for each. Later changes build on the earlier ones even before you approve them.

Open the sparkle button to review a proposal:
- **Preview** shows it on the canvas.
- **Accept** applies it.
- **Modify** keeps or drops individual steps and edits values.
- **Reject** dismisses it, optionally with a reason. Claude sees the reason, and session memory keeps it.

Changes Claude made carry a small sparkle on their layer, clip, block or slide until you edit that item yourself.

### Describe a change (feature 48)

In any project, click **Describe a change** (or press `Ctrl+Shift+K`), or type a sentence in the command palette. For example, "Make the sky warmer and move the title to the lower third" becomes a proposal with two steps: a temperature adjustment masked to the sky, and the title moved. Nothing changes until you accept it, and you can keep only some steps.

The parser understands the common edits in every editor:

| Area | Examples |
| --- | --- |
| Look | color and tone, position and alignment, size, opacity, visibility, fonts and color |
| Content | text, adding titles, slides and paragraphs, renaming, duplicating, deleting |
| Images | filters, removing a photo's background, recoloring a background |
| Video | speed, volume, trims, fades and crossfades |
| Slides and documents | themes, layouts and transitions; turning paragraphs into headings, lists or quotes |

It also resolves "it" to whatever the previous phrase changed. Phrases it does not understand are listed with the reason and example commands. With an API key and AI allowed on the project, Omnix hands the whole command to Claude instead, and Claude's changes arrive as one proposal.

### Run a goal with Claude (feature 44)

Click the robot icon, then **Run a goal with Claude**. Describe the goal, for example "Make a 30-second teaser from these clips with titles and music". Then choose where Claude must stop:
- approve the plan
- review each stage
- before exporting
- before deleting anything
- any moments you describe

Claude plans stages, works through them with the same tools a connected Claude uses, and saves a named version after each stage. At a gate it waits, and nothing runs. You can then:
- **Approve** (optionally with a note)
- **Ask for changes**, with feedback Claude reads
- **Stop**, keeping its work, rolling back to a checkpoint, or undoing the whole run

The run card shows the plan, the checkpoints (each can be rolled back to later), the summary and an activity log.

Without an API key, the dialog gives you a message to paste into Claude. Claude, connected in autonomous mode, then drives the run itself with `agent_start_run`, `agent_checkpoint`, `agent_wait` and `agent_finish`. The same gates apply: while a run waits for you, Claude's changes to that project are held, and an export or deletion pauses until you approve that exact call.

### Generative fill and extend (feature 46)

In the image editor:
- **Generate:** select an area, click **Generate**, and optionally describe what goes there.
- **Extend:** use the expand icon to grow the canvas to a shape (16:9, 9:16, 1:1, 4:5, 3:1) or by custom margins.

Either way the result is a new layer whose mask is the generated area, so you can see it, turn the limit off, generate again, or delete the layer.

In the video editor, select a clip, then:
1. Click **Mark the area** and drag over something to remove (a logo, a watermark, a passer-by).
2. Optionally describe it.
3. Click **Fill across the clip**.

A background job fills the area through the clip, and the clip then plays the new render. The marked area stays outlined on the preview, and **Use the original clip** switches back.

**Reframe** changes a video to another shape (vertical, square, portrait) and fills the space around each shot with a blurred, darker copy of it.

### Match style (feature 47)

**Match style** is in the image, video, slides and document editors and in the command palette. Choose a reference: a picture or clip from the library, or another document in the project. Then choose what to borrow: color, tone, texture, fonts or motion. Everything arrives as settings you can edit:

| Target | What it gets |
| --- | --- |
| Images | a look adjustment layer (a 3D LUT computed from the reference) and grain |
| Video | a color grade with the look, as a clip effect or one effect clip over the whole video |
| Slideshows | a theme built from the reference's palette, or its fonts and colors |
| Documents | heading colors and fonts |
| Animations and slides | the reference's easing, transitions and timing ("motion feel") |

### Session memory and cross-tool context (features 49 and 50)

The notes panel collects decisions, prompts and rejected options, with filters by kind. Omnix records these for you:
- commands
- agent goals
- notes given at gates
- requests for changes
- rejected proposals with their reasons
- the summary of a finished run

Claude reads these notes when it resumes.

Claude sees the whole project at once (`get_project`). It can search every tool (`find_in_project`, also **Find in project** with `Ctrl+Shift+F`), turn a document into slides (**Make slides** in the document editor, or `slides_from_document`), and place code output in documents and slides.

## What was built

**Core:**
- `attribution.ts`: AI markers from history, folded incrementally on the client.
- Proposals pair named steps with operations, so stacked changes can be reviewed step by step.
- Notes record whether Omnix wrote them automatically, and what they refer to.
- Clips and layers carry the details of generated content.
- Clip effects can carry a LUT.

**Imaging and renderer:**
- `colorGrade` (exposure, contrast, saturation, temperature, tint, then an optional LUT).
- `styleLut` and `dominantColors`.
- Video color-grade effects now render in preview and export; before this phase they were skipped.

**Server:**

| Area | What it does |
| --- | --- |
| `oauth/` | OAuth 2.1 authorization server: discovery metadata, dynamic client registration, PKCE consent, rotating refresh tokens, revocation, per-connection mode and project scopes. Mode changes apply on Claude's next request. |
| `mcp/tools/*` | Write tools for every editor (80 tools in total; see `docs/MCP_TOOLS.md`), signed download links, and proposal stacking with a working state. |
| `agent/` | The runner, with internal (Claude API) and external (MCP) drivers, gates, checkpoints, rollback, retry and the step budget. Tool calls from a connection that is driving a run are gated. |
| `ai/nl/` | The command parser: clauses, targets in each editor, sky and subject regions, and actions. |
| `ai/commands.ts` | Turns a command into one proposal, or hands it to Claude. |
| `ai/generative.ts`, `ai/videoFill.ts` | Image providers (built-in, or an OpenAI-compatible images edit API), image fill and extend, and video region fill as a job. |
| `ai/style.ts` | References (assets, canvases, layers, clips, sequences, decks, slides, documents) and how they apply to each target. |
| `ai/module.ts` | REST routes and MCP tools: `run_command`, generative tools, `video_extend_frame`, `style_match`, `find_in_project`, `slides_from_document`, `get_job`, `get_ai_capabilities`. |
| `notes/` | Session memory recorder. |
| `ai/anthropic.ts` | A small Messages API client with model resolution and retries. |

**Web:**
- The approval page for connections.
- The command bar, and the palette's free-text action.
- The Claude runs panel and start dialog.
- Generative fill and extend dialogs, and a Generated section on generated layers.
- Video area marking and fill.
- Match style and Find in project dialogs.
- Reframe and Make slides.
- AI markers and the steps in proposals.
- Notes filters.
- Plurals and all new strings live in the message catalog.

## Tests

`pnpm test` runs 300 tests and `pnpm test:e2e` runs 10 browser tests. New in this phase:

- **OAuth** (`oauth.test.ts`): discovery, registration, PKCE, consent, refresh rotation, revocation, scopes, project limits, mode changes and the official MCP SDK's OAuth client end to end.
- **Write tools** (`tools.test.ts`): every editor's tools through real MCP clients in autonomous, approve and view modes, proposal stacking, and the working state.
- **Agent runner** (`agent.test.ts`), driven by a scripted fake Claude API:
  - plan, stage and export gates, approval with feedback, and checkpoints as named versions
  - attribution to the run
  - declining a gated deletion, stopping with full rollback, API errors and retry, the step budget, consent
  - commands handed to Claude becoming one proposal
  - Claude driving a run over MCP: held writes, the export gate, `agent_wait`
- **AI features** (`ai.test.ts`):
  - commands in image, video, slides and documents, including keeping only some steps; the sky mask covers the sky and not the ground
  - background removal and recoloring, and phrases it does not understand
  - generative fill and extend, with the built-in provider and a fake image model (which requires AI consent)
  - video region fill with real ffmpeg
  - style matching for images, slides and documents, and motion between animations
  - search, slides from a document, rejected proposals in memory, AI markers
- **Core:** attribution folding.
- **Web** (`ai.test.tsx`): command bar context and results, palette commands, AI markers appearing and clearing, notes filters, the run card's approve, changes and stop with rollback, and extend margins.
- **Browser** (`e2e/phase4.spec.ts`): connecting through the OAuth approval page and using the token for MCP; a command proposed, accepted and remembered; the runner's guidance without an API key.

## Decisions and why

- **One permission check for people, Claude and the agent.** Every AI write goes through the same `apply`: commit in autonomous mode, propose in approve mode. The runner uses the MCP tools and does not have its own copies, so whatever Claude can do over the connector, the runner can do, with the same checks, activity log and attribution.
- **Stacked proposals with a working state.** Claude often builds something in several calls (create a slide, then fill it). Separate proposals that cannot see each other would fail or need approving one by one. Stacking gives one diff to review, still split into named steps that can be kept or dropped. `start_new_proposal` separates unrelated work.
- **Gates live in Omnix, not in Claude's prompt.** The runner pauses before gated tool calls itself. For an external Claude, Omnix holds writes while a run waits and lets a gated call through only once it is approved. The person's control does not depend on the model following instructions.
- **Checkpoints are ordinary versions, and rollback is ordinary reverts.** Stopping and rolling back uses the same history as everything else, attributed to the person, so it can itself be undone.
- **A deterministic parser first, Claude second.** Common edits should be instant, free and predictable, and work without an API key. Anything else goes to Claude, as a proposal, only where AI is allowed.
- **Masks are made from the picture, not from what sits on top of it.** Regions like "the sky" ignore text and shapes, so moving a title later does not reveal a hole in the effect.
- **Generated content is always a separate, masked layer, or a clip that remembers its original.** It is visible, reversible and easy to regenerate, and the mask the feature asks for is part of the document, not a temporary overlay.
- **Built-in generation is honest about what it is.** It continues the surrounding texture (good for removing things) and says so in the dialog. Inventing new content needs a real image model, which is optional, plugged in through a standard API, and requires the project's AI consent because pixels leave the server.
- **Style as editable settings.** A LUT look layer or color grade, grain, theme tokens and easing can be tuned, hidden or removed later; a baked filter could not.
- **Session memory is bookkeeping, not an edit.** Automatic notes are committed by a dedicated "Session memory" author, so they never land on anyone's undo stack.
- **The model is not hard-coded.** `OMNIX_AGENT_MODEL` chooses it. Otherwise Omnix asks the Models API for the newest model the key can use, so new models are picked up without a release.

## Incomplete in this phase

- **Generation without an image model is limited to the surroundings.** The built-in provider cannot paint objects that are not there; prompts only tint the fill. Connecting an image model removes the limit for images.
- **Video fill quality.** Video fill works on keyframes and blends between them. It suits a fixed watermark or logo, or an object on a steady background. Fast camera moves will show it. An image model is used per keyframe, which can be slow and costly for long clips.
- **Video extend uses a blurred fill, not outpainting.** Video extend fills new space with a blurred copy of the shot rather than generating new content.
- **The parser's coverage.** The command parser covers common edits. Compound conditions ("make every title that mentions sales bold"), relative references beyond "it", and numeric expressions in words ("two thirds") go to Claude, or come back as not understood.
- **Style motion matching transfers easing and timing, not paths.** It does not invent motion paths or retime video cuts.
- **Agent run tracking across restarts.** Runs driven by the built-in runner fail with a clear message if Omnix restarts mid-run, and **Try again** resumes from the saved conversation. Runs driven by Claude over MCP survive restarts.
- **OAuth client authentication.** Only public clients with PKCE are supported, which is what Claude uses. Confidential client secrets are not issued.
