# Connect Omnix to Claude

First, open Omnix at **http://localhost:4317** and turn on **Allow AI** in each project Claude may work on.

## Claude Code

1. Start Omnix:

   ```bash
   pnpm start
   ```

2. Add it to Claude Code:

   ```bash
   claude mcp add --transport http omnix http://localhost:4317/mcp
   ```

3. In Claude Code, type `/mcp`, pick **omnix**, then **Authenticate**. A browser window opens. Click **Allow**.

## Claude chat (claude.ai), Claude Desktop and your phone

These connect over the internet, so Omnix needs a public address. `pnpm share` makes one for you.

1. Install cloudflared once:
   - Windows: `winget install --id Cloudflare.cloudflared`
   - Mac: `brew install cloudflared`
2. Start Omnix with:

   ```bash
   pnpm share
   ```

   It prints the address to paste, like this:

   ```
   Settings → Connectors → Add custom connector → paste  https://quiet-river-1234.trycloudflare.com/mcp
   ```

3. Go to **https://claude.ai/settings/connectors** and click **Add custom connector**.
   - Name: `Omnix`
   - URL: the address `pnpm share` printed
4. Click **Add**, then **Connect**, then **Allow**.

That's it. Omnix now works in claude.ai, in Claude Desktop and in the Claude phone app, as long as you are signed in to the same Claude account. In a chat, make sure **Omnix** is switched on in the tools menu.

Keep `pnpm share` running while you use Claude. If you restart it, the address changes. Paste the new one into the connector at **https://claude.ai/settings/connectors**.

## Try it

- "List my Omnix projects."
- "Make a square poster for my lamp and show me a preview."
- "Turn my brief into a slideshow."
- "Make a six-second teaser from the poster and export it as MP4."

## If it doesn't work

- **Claude can't reach Omnix:** check that `pnpm share` is still running and that the connector has its latest address.
- **"AI is not allowed on this project":** turn on **Allow AI** in that project.
- **"This connection is view-only":** change it in Omnix under **Settings → Claude**.

There are other ways to connect (an access token, or Claude Desktop's config file) in the [README](../README.md#connect-omnix-to-claude).

## ChatGPT

ChatGPT connects to Omnix the same way Claude chat does, so Omnix needs a public address. On Windows, `Omnix-PC.bat` makes one with cloudflared (free, no account). The black window shows it as a line ending in `/mcp`. The address changes each time Omnix starts.

1. In ChatGPT, open **Settings → Apps & Connectors → Advanced settings** and turn on **Developer mode**. Custom connectors with editing tools need it (Plus or Pro).
2. Back in **Apps & Connectors**, click **Create**.
   - Name: `Omnix`
   - MCP server URL: the `https://….trycloudflare.com/mcp` address from the black window
   - Authentication: **OAuth**
3. Click **Create**, then **Connect**. Omnix shows its approval screen. Pick the permission and click **Allow**.
4. In a chat, choose Omnix from the tools menu (**+ → Developer mode** or **Connectors**), and ask: "List my Omnix projects."

Changes ChatGPT makes are credited to ChatGPT in Omnix's history and can be undone. When the address changes, edit the connector's URL in ChatGPT.
