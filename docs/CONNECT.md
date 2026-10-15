# Connect Omnix to Claude

Once connected, Claude can work inside Omnix with you. It can open your projects, edit images, video, animation, code, documents and slides, check its own work as pictures, and export the results. This guide covers every Claude app:

| Where you use Claude | How it connects | What Omnix needs |
| --- | --- | --- |
| [claude.ai in a browser](#claudeai-in-a-browser) | Custom connector | A public HTTPS address |
| [Claude on your phone](#claude-on-your-phone-ios-and-android) | The same connector, added once on claude.ai | A public HTTPS address |
| [Claude Desktop (Windows, Mac)](#claude-desktop-on-windows-or-mac) | Custom connector, or a local config | Public HTTPS, or nothing extra on the same computer |
| [Claude Code](#claude-code) | `claude mcp add` | Nothing extra on the same computer |

The in-app guide (**Help → Claude setup guide**) walks through the same steps and ends with a connection test.

## Before you start

1. **Start Omnix** and create your account:

   ```bash
   pnpm install && pnpm build && pnpm start   # http://localhost:4317
   ```

2. **Turn on Allow AI** in each project Claude may change (the project's settings, or the badge in its top bar). Claude can read other projects but not change them.

3. **Give Omnix a public HTTPS address** if you will use claude.ai, the phone apps or Desktop's connector. Claude reaches connectors from Anthropic's servers, not from your computer, so `localhost` will not work for them. Two ways:

   - **A tunnel, for trying it out:**

     ```bash
     cloudflared tunnel --url http://localhost:4317
     # prints something like https://quiet-river-1234.trycloudflare.com
     OMNIX_PUBLIC_URL=https://quiet-river-1234.trycloudflare.com pnpm start
     ```

     A quick tunnel's address changes every time it restarts. When it does, update `OMNIX_PUBLIC_URL` and the connector's URL. A named Cloudflare tunnel, or a similar service, keeps one address.
   - **A server:** run Omnix on a machine with a domain and HTTPS, and set `OMNIX_PUBLIC_URL` to that address.

   With a public address, anyone can reach the sign-in page. Only the first account can sign up unless you set `OMNIX_OPEN_SIGNUP=true`, so create yours first.

Your connector URL is your public address followed by `/mcp`, for example `https://quiet-river-1234.trycloudflare.com/mcp`.

## claude.ai in a browser

1. Open [claude.ai](https://claude.ai) → **Settings → Connectors → Add custom connector**.
2. Name it **Omnix**, and paste your connector URL (`https://…/mcp`). Leave the OAuth client fields empty, because Omnix registers Claude itself.
3. Click **Add**, then **Connect**. Your Omnix opens an approval screen. Sign in if asked, then choose:
   - **Permission:**
     - *View only*: Claude can look but not change anything.
     - *Edit with approval*: every change waits for you as a proposal you can preview, change or reject.
     - *Autonomous*: changes apply directly, and long runs stop at the approval points you pick.
   - **Projects:** all, or only the ones you tick.
4. Click **Allow**. You are back in Claude, and Omnix is connected.
5. In a chat, open the tools menu (the sliders icon) and check that **Omnix** is switched on. Then ask, for example: *"List my Omnix projects."*

On a Team or Enterprise plan, an owner may need to allow custom connectors for the organization first.

## Claude on your phone (iOS and Android)

The phone apps use the connectors on your Claude account, so there is nothing new to install:

1. Add Omnix once on claude.ai (above) or in Claude Desktop, signed in with the same account.
2. Open the Claude app on your phone. In a chat, open the tools menu and make sure **Omnix** is on.
3. Ask away: *"In my Omnix project Aurora launch, make the headline bigger and show me a preview."* Claude can send back the preview pictures it renders.

If the connector asks you to connect again (sign-ins expire after a while), do it from claude.ai or Desktop. The phone apps use the result.

## Claude Desktop on Windows or Mac

**Option A: the same connector** (needs the public HTTPS address). In Claude Desktop open **Settings → Connectors → Add custom connector**, then follow the claude.ai steps. A connector added on claude.ai already shows up here.

**Option B: a local connection** (Omnix on the same computer, no public address needed):

1. In Omnix, open **Settings → Claude → Create token**. Choose the permission, then copy the token (`omx_…`).
2. In Claude Desktop, open **Settings → Developer → Edit Config** and add Omnix to `claude_desktop_config.json`:

   ```json
   {
     "mcpServers": {
       "omnix": {
         "command": "pnpm",
         "args": ["--dir", "C:\\path\\to\\omnix", "mcp:stdio"],
         "env": { "OMNIX_URL": "http://localhost:4317", "OMNIX_TOKEN": "omx_..." }
       }
     }
   }
   ```

   On a Mac, the path looks like `/Users/you/omnix`.
3. Quit Claude Desktop completely and open it again. Omnix appears in the tools menu.

## Claude Code

On the same computer as Omnix:

```bash
claude mcp add --transport http omnix http://localhost:4317/mcp
```

Then type `/mcp` inside Claude Code, pick **omnix → Authenticate**, and approve in the browser window that opens.

To skip the browser, use an access token from **Settings → Claude**:

```bash
claude mcp add --transport http omnix http://localhost:4317/mcp --header "Authorization: Bearer omx_..."
```

For Omnix on another machine, use its public address instead of `localhost` (`https://…/mcp`). Add `--scope user` to make Omnix available in every folder, not only the current one.

## What Claude can do once connected

Omnix gives Claude 91 tools ([the full catalog](MCP_TOOLS.md)). Things to try:

- **See and check its work.** *"Render the poster and tell me what you'd improve."* Claude renders canvases, frames and slides to pictures and looks at them.
- **Edit in every tool.**
  - Image: layers, masks, filters, background removal, generative fill and extend.
  - Video: cutting clips, titles, keyframes, captions, music.
  - Animation: frames and rigs.
  - Code: running code and charts.
  - Documents and slides: writing and reworking.
- **Work across tools.**
  - *"Turn the brief into a deck"* (`slides_from_document`).
  - *"Put the sales chart from the notebook on slide 3"* (`code_place_output`).
  - *"Give the teaser the poster's look"* (`style_match`).
- **Run a whole goal.** In autonomous mode: *"Make a launch kit for the Aurora lamp: a poster, a one-page brief, a short deck and a six-second teaser."* Claude plans stages, saves a version after each, and pauses where you chose: approving the plan, reviewing each stage, before exporting or deleting. See [the walkthrough](WALKTHROUGH.md).
- **Change things in plain words.** *"Make the sky warmer and move the title to the lower third"* (`run_command`).
- **Collaborate.**
  - Claude reads and answers your pinned comments.
  - It compares versions as pictures.
  - It remembers decisions in the project's session memory.
  - It works on many files at once with batch processing.
- **Export.** PNG, PSD, SVG, MP4, GIF, Lottie, DOCX, PDF, PPTX and more, with a download link.

Everything Claude does is credited to Claude in the history and the activity feed, and can be undone. Changes from one connection stack into one proposal when you use *Edit with approval*.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| claude.ai says it can't reach the server | Omnix needs the public HTTPS address. Check that the tunnel is running and that `OMNIX_PUBLIC_URL` matches it exactly. |
| It worked yesterday, not today | A quick tunnel's address changed. Update `OMNIX_PUBLIC_URL` and the connector URL, or use a named tunnel. |
| "AI is not allowed on this project yet" | Turn on **Allow AI** in that project. |
| "This connection is view-only" | Change the permission in **Settings → Claude**, or on the dashboard's Claude card. |
| Claude Code shows omnix as failed | Is Omnix running? Run `/mcp` → **Authenticate** again, or use the token form. |
| Desktop doesn't show Omnix | Check the path in the config and that Omnix is running, then quit and reopen Desktop completely. |

**Help → Troubleshooting** inside Omnix has more. To disconnect Claude, choose **Disconnect** next to it in **Settings → Claude**. Its access stops right away.
