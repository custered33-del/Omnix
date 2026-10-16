// Connect the AI apps on this computer to Omnix: Claude Desktop (claude_desktop_config.json) and
// OpenAI Codex (~/.codex/config.toml). Both start Omnix's stdio bridge, which uses the access token
// a local Omnix writes into its data folder. Other settings in those files are kept.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = process.execPath;
const args = [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'packages', 'server', 'src', 'mcp', 'stdio.ts')];
const env = { OMNIX_URL: `http://localhost:${process.env.OMNIX_PORT ?? 4317}`, OMNIX_DATA_DIR: path.resolve(process.env.OMNIX_DATA_DIR ?? path.join(root, '.omnix-data')) };
const home = process.env.OMNIX_HOME_FOR_TESTS ?? os.homedir();

/** Claude Desktop: every settings folder it may use on this computer. */
export function connectClaudeDesktop() {
  const appData = process.env.APPDATA ?? (process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.config'));
  const dirs = [path.join(appData, 'Claude')];
  const packages = path.join(process.env.LOCALAPPDATA ?? '', 'Packages');
  try {
    for (const d of fs.readdirSync(packages)) if (/^(AnthropicPBC\.)?Claude/i.test(d)) dirs.push(path.join(packages, d, 'LocalCache', 'Roaming', 'Claude'));
  } catch {
    // not a Store install
  }
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, 'claude_desktop_config.json');
    let c = {};
    try {
      c = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      c = {};
    }
    c.mcpServers = { ...(c.mcpServers ?? {}), omnix: { command, args, env } };
    fs.writeFileSync(f, JSON.stringify(c, null, 2));
  }
}

/** Codex: replace Omnix's [mcp_servers.omnix] table in config.toml, leaving everything else as it is. */
export function connectCodex() {
  const dir = path.join(process.env.CODEX_HOME ?? path.join(home, '.codex'));
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'config.toml');
  let text = '';
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch {
    text = '';
  }
  // Drop an earlier Omnix table (and its sub-tables) up to the next unrelated table.
  const lines = text.split(/\r?\n/);
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[\s*([^\]]+?)\s*\]\s*$/.exec(line);
    if (header) skipping = header[1] === 'mcp_servers.omnix' || header[1].startsWith('mcp_servers.omnix.');
    if (!skipping) kept.push(line);
  }
  // TOML basic strings use the same escapes as JSON.
  const q = (s) => JSON.stringify(s);
  const block = ['[mcp_servers.omnix]', `command = ${q(command)}`, `args = [${args.map(q).join(', ')}]`, `env = { ${Object.entries(env).map(([k, v]) => `${k} = ${q(v)}`).join(', ')} }`];
  const body = kept.join('\n').replace(/\s+$/, '');
  fs.writeFileSync(f, `${body ? `${body}\n\n` : ''}${block.join('\n')}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [name, fn] of [['Claude Desktop', connectClaudeDesktop], ['Codex', connectCodex]]) {
    try {
      fn();
      console.log(`  ${name} is connected to Omnix.`);
    } catch (e) {
      console.log(`  Could not connect ${name}: ${e instanceof Error ? e.message : e}`);
    }
  }
}
