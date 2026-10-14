import { test as base, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const media = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnix-e2e-media-'));
  const clip = path.join(dir, 'clip.mp4');
  const music = path.join(dir, 'music.mp3');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', music]);
  return { clip, music };
})();

let accountMade = false;

/** Sign in (creating the owner account on first use) and land on the dashboard. */
export async function signIn(page: Page): Promise<void> {
  await page.addInitScript(() => sessionStorage.setItem('omnix.setupShown', '1'));
  await page.goto('/');
  await page.waitForSelector('form.auth-card');
  await page.waitForLoadState('networkidle');
  if (!accountMade && (await page.locator('#name').count())) await page.fill('#name', 'Seb');
  await page.fill('#email', 'seb@example.com');
  await page.fill('#password', 'correct-horse-battery');
  await page.click('button[type=submit]');
  await page.waitForSelector('form.auth-card', { state: 'detached' });
  accountMade = true;
  await page.goto('/');
  await page.waitForSelector('.create-row');
}

export async function createProject(page: Page, tool: 'Image editor' | 'Video editor' | 'Animation maker' | 'Code Grounds' | 'Document' | 'Slideshow'): Promise<void> {
  await page.click(`.create-tile:has-text("${tool}")`);
  await page.waitForURL(/\/projects\//);
}

export const test = base.extend<{ errors: string[] }>({
  errors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
    await use(errors);
  },
});
export { expect };
