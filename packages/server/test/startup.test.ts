import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');

describe('server startup under plain Node', () => {
  // Vitest smooths over CommonJS/ESM differences that real Node does not; `pnpm start`
  // runs under Node with tsx, so load every module the same way.
  it('imports the app and all modules without interop errors', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', "await import('./packages/server/src/app.ts'); await import('./packages/server/src/modules.ts'); console.log('ok')"], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    expect(r.stderr).not.toMatch(/SyntaxError|does not provide an export/);
    expect(r.stdout.trim()).toBe('ok');
  }, 70_000);
});
