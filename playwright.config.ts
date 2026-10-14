import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.env.OMNIX_E2E_PORT ?? 4455);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnix-e2e-'));
// Use a preinstalled Chromium when one is provided (CI images, sandboxes).
const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? (fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);

/**
 * End-to-end tests drive the real app in a browser against a fresh server.
 * Run `pnpm build` first so the server can serve the web app.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    launchOptions: { ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] },
  },
  webServer: {
    command: `node --import tsx packages/server/src/main.ts`,
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { OMNIX_PORT: String(port), OMNIX_DATA_DIR: dataDir, NODE_ENV: 'test' },
  },
});
