#!/usr/bin/env -S npx tsx
import fs from 'node:fs/promises';
import path from 'node:path';
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
    ? `    Claude chat, the Claude phone app and ChatGPT (this address changes each time Omnix starts):
      paste  ${c.publicUrl}/mcp  as a custom connector`
    : `    Claude chat, the phone app and ChatGPT need a public address:
      stop Omnix and run  pnpm share  instead of pnpm start`
}
`);

// Claude Desktop on this computer connects through `mcp:stdio`, which needs an access token. When
// Omnix keeps its data in a local folder, it writes a fresh token for the owner into that folder
// (readable only by this account), so the local connection works with nothing to copy.
const LOCAL_TOKEN_NAME = 'Claude Desktop (this computer)';
const writeLocalToken = async (): Promise<boolean> => {
  if (omnix.services.store.kind !== 'file') return true;
  const owner = (await omnix.services.users.list()).find((u) => u.role === 'owner');
  if (!owner) return false;
  for (const t of await omnix.services.users.listAccessTokens(owner.id)) if (t.name === LOCAL_TOKEN_NAME) await omnix.services.users.revokeAccessToken(owner.id, t.id);
  const { token } = await omnix.services.users.createAccessToken(owner.id, LOCAL_TOKEN_NAME, ['omnix:read', 'omnix:edit', 'omnix:autonomous']);
  await fs.writeFile(path.join(c.dataDir, 'claude-desktop-token'), token, { mode: 0o600 });
  return true;
};
if (!(await writeLocalToken().catch(() => true))) {
  // No account yet: write it as soon as the owner signs up.
  const wait = setInterval(() => void writeLocalToken().then((done) => done && clearInterval(wait), () => clearInterval(wait)), 3000);
  wait.unref();
}

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
