import { ExternalLink, Globe, TerminalSquare } from 'lucide-react';
import { CopyField } from './SetupGuide.js';

interface Info {
  publicUrl: string;
  mcpUrl: string;
  local: boolean;
  https: boolean;
  installDir?: string;
  dataDir?: string;
}

/** The setup guide in GPT mode: connecting OpenAI's ChatGPT and Codex to Omnix. */
export function GptGuide({ info }: { info: Info | null }) {
  const reachable = !!info && info.https && !info.local;
  const dir = info?.installDir ?? 'C:\\Users\\you\\Omnix';
  const win = dir.includes('\\');
  const join = (...p: string[]) => [dir, ...p].join(win ? '\\' : '/');
  const toml = [
    '[mcp_servers.omnix]',
    `command = "node"`,
    `args = [${JSON.stringify(join('node_modules', 'tsx', 'dist', 'cli.mjs'))}, ${JSON.stringify(join('packages', 'server', 'src', 'mcp', 'stdio.ts'))}]`,
    `env = { OMNIX_URL = "http://localhost:4317", OMNIX_DATA_DIR = ${JSON.stringify(info?.dataDir ?? join('.omnix-data'))} }`,
  ].join('\n');
  return (
    <div className="gpt-guide">
      <section className="card setup-panel" aria-labelledby="gpt-chatgpt">
        <h2 id="gpt-chatgpt">
          <Globe aria-hidden="true" /> ChatGPT
        </h2>
        <div className="setup-content">
          <p>ChatGPT reaches Omnix over the internet, so Omnix needs a public address. On Windows, Omnix-PC.bat makes one with cloudflared (free, no account); it changes each time Omnix starts.</p>
          {reachable ? (
            <CopyField label="Your Omnix link for ChatGPT" value={info!.mcpUrl} />
          ) : (
            <p className="notice warning">This Omnix has no public address right now ({info?.publicUrl ?? 'loading…'}). Start it with Omnix-PC.bat (or pnpm share) and reload this page to see your link.</p>
          )}
          <ol className="gpt-steps">
            <li>
              In ChatGPT, open <strong>Settings → Apps &amp; Connectors → Advanced settings</strong> and turn on <strong>Developer mode</strong> (ChatGPT Plus or Pro).
            </li>
            <li>
              In <strong>Apps &amp; Connectors</strong>, click <strong>Create</strong>. Name: <code>Omnix</code>. MCP server URL: the link above. Authentication: <strong>OAuth</strong>.
            </li>
            <li>
              Click <strong>Create</strong>, then <strong>Connect</strong>. Omnix asks what ChatGPT may do; pick it and click <strong>Allow</strong>.
            </li>
            <li>
              In a chat, turn on Omnix in the tools menu and ask: <em>“List my Omnix projects.”</em>
            </li>
          </ol>
          <p className="muted">When the link changes, edit the connector’s URL in ChatGPT. Everything ChatGPT does is credited to ChatGPT in History and can be undone.</p>
          <a className="btn" href="https://chatgpt.com/#settings/Connectors" target="_blank" rel="noreferrer">
            Open ChatGPT settings <ExternalLink aria-hidden="true" />
          </a>
        </div>
      </section>

      <section className="card setup-panel" aria-labelledby="gpt-codex">
        <h2 id="gpt-codex">
          <TerminalSquare aria-hidden="true" /> Codex
        </h2>
        <div className="setup-content">
          <p>
            <strong>On Windows, Omnix-PC.bat connects Codex for you</strong> (the Codex app, CLI and editor extension share one settings file). Start Omnix with it, then restart Codex, and ask: <em>“List my Omnix projects.”</em>
          </p>
          <p>To connect it yourself, add this to Codex’s settings file, <code>~/.codex/config.toml</code> (on Windows <code>%USERPROFILE%\.codex\config.toml</code>):</p>
          <CopyField label="Codex settings" value={toml} multiline />
          <p className="muted">Omnix must be running. Codex talks to it on this computer, so it needs no public address.</p>
        </div>
      </section>
    </div>
  );
}
