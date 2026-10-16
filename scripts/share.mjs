// `pnpm share`: start Omnix with a public HTTPS address (a Cloudflare quick tunnel), so claude.ai,
// Claude Desktop and the Claude phone app can connect to it. Prints the exact address to paste.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const port = process.env.OMNIX_PORT ?? '4317';
const has = spawnSync('cloudflared', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
if (!has) {
  console.log(`
  pnpm share needs cloudflared (free, from Cloudflare). Install it once, then run pnpm share again:

    Windows:  winget install --id Cloudflare.cloudflared
    Mac:      brew install cloudflared
    Linux:    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
`);
  process.exit(1);
}

console.log('\n  Opening a public address for Omnix...');
const tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
let omnix = null;
let found = false;
/** Start the server directly (no pnpm needed on the PATH), with the public address when there is one. */
function startOmnix(publicUrl) {
  if (omnix) return;
  const root = new URL('..', import.meta.url);
  const tsx = new URL('node_modules/tsx/dist/cli.mjs', root);
  const main = new URL('packages/server/src/main.ts', root);
  omnix = spawn(process.execPath, [fileURLToPath(tsx), fileURLToPath(main)], { stdio: 'inherit', cwd: fileURLToPath(root), env: { ...process.env, ...(publicUrl ? { OMNIX_PUBLIC_URL: publicUrl } : {}) } });
  omnix.on('exit', (code) => stop(code ?? 0));
}
const onOutput = (d) => {
  const m = !found && /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(d.toString());
  if (!m) return;
  found = true;
  clearTimeout(timer);
  startOmnix(m[0]);
};
tunnel.stdout.on('data', onOutput);
tunnel.stderr.on('data', onOutput);
// Without a public address, Omnix still runs on this computer.
const withoutTunnel = (why) => {
  if (found || omnix) return;
  console.log(`\n  ${why} Omnix runs on this computer only this time (Claude Desktop still works).\n`);
  startOmnix(null);
};
tunnel.on('exit', () => withoutTunnel('No public address: cloudflared stopped.'));
tunnel.on('error', () => withoutTunnel('No public address: cloudflared could not start.'));
const timer = setTimeout(() => withoutTunnel('No public address after 60 seconds.'), 60_000);

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  omnix?.kill('SIGINT');
  try {
    tunnel.kill();
  } catch {
    // already gone
  }
  setTimeout(() => process.exit(code), 500).unref();
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
