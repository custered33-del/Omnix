#!/usr/bin/env -S npx tsx
import { createOmnix } from './app.js';
import './modules.js';

/** Omnix server entry point: `pnpm start` (or `pnpm dev:server` with reload). */
const omnix = await createOmnix();
const port = await omnix.listen();
const c = omnix.config;
console.log(`\n  Omnix is running at ${c.publicUrl}${c.publicUrl.includes(String(port)) ? '' : ` (listening on ${port})`}`);
console.log(`  Storage: ${omnix.services.store.kind} (${c.databaseUrl ? 'postgres' : c.dataDir})`);
console.log(`  MCP endpoint for Claude: ${c.publicUrl}/mcp\n`);

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
