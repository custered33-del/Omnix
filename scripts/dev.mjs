// Run the Omnix server (auto-reload) and the web app (hot reload) together.
// The web app on http://localhost:5173 proxies API, WebSocket and MCP calls to the server.
import { spawn } from 'node:child_process';

const procs = [
  { name: 'server', color: 36, cmd: 'pnpm', args: ['exec', 'tsx', 'watch', '--clear-screen=false', 'packages/server/src/main.ts'] },
  { name: 'web', color: 35, cmd: 'pnpm', args: ['--filter', '@omnix/web', 'dev'] },
];

const children = procs.map((p) => {
  const env = { ...process.env, OMNIX_DEV_SERVER: process.env.OMNIX_DEV_SERVER ?? `http://localhost:${process.env.OMNIX_PORT ?? 4317}` };
  const child = spawn(p.cmd, p.args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  const prefix = `\x1b[${p.color}m[${p.name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) out.write(prefix + l + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(`${prefix}exited with code ${code}`);
    shutdown(code ?? 0);
  });
  return child;
});

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGINT');
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
