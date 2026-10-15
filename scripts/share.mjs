// `pnpm share`: start Omnix with a public HTTPS address (a Cloudflare quick tunnel), so claude.ai,
// Claude Desktop and the Claude phone app can connect to it. Prints the exact address to paste.
import { spawn, spawnSync } from 'node:child_process';

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
const onOutput = (d) => {
  const m = !found && /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(d.toString());
  if (!m) return;
  found = true;
  omnix = spawn('pnpm', ['start'], { stdio: 'inherit', env: { ...process.env, OMNIX_PUBLIC_URL: m[0] }, shell: process.platform === 'win32' });
  omnix.on('exit', (code) => stop(code ?? 0));
};
tunnel.stdout.on('data', onOutput);
tunnel.stderr.on('data', onOutput);
tunnel.on('exit', (code) => {
  if (!found) console.log('\n  cloudflared stopped before giving an address. Check your internet connection and try again.\n');
  stop(code ?? 1);
});
const timer = setTimeout(() => {
  if (!found) {
    console.log('\n  No public address after 60 seconds. Check your internet connection and try again.\n');
    stop(1);
  }
}, 60_000);

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  omnix?.kill('SIGINT');
  tunnel.kill();
  setTimeout(() => process.exit(code), 500).unref();
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
