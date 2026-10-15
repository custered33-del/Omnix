#!/usr/bin/env -S npx tsx
import { createOmnix } from './app.js';
import './modules.js';

/** Omnix server entry point: `pnpm start` (or `pnpm dev:server` with reload). */
const omnix = await createOmnix();
const port = await omnix.listen();
const c = omnix.config;
const local = `http://localhost:${port}`;
const reachable = /^https:\/\//.test(c.publicUrl) && !/localhost|127\.0\.0\.1/.test(c.publicUrl);
console.log(`
  Omnix is running. Open it in your browser: ${local}
  Storage: ${omnix.services.store.kind} (${c.databaseUrl ? 'postgres' : c.dataDir})

  Connect Claude
    Claude Code (this computer):  claude mcp add --transport http omnix ${local}/mcp
${
  reachable
    ? `    claude.ai, Claude Desktop and the phone app:
      Settings → Connectors → Add custom connector → paste  ${c.publicUrl}/mcp`
    : `    claude.ai, Claude Desktop and the phone app need a public address:
      stop Omnix and run  pnpm share  instead of pnpm start`
}
`);

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  console.log(`\n  ${signal} received, saving and shutting down...`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await omnix.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
