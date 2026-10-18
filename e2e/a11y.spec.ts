import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import { createProject, expect, signIn, test } from './fixtures.js';

/**
 * Accessibility: every page, each editor, the project panels and the main dialogs pass axe's
 * WCAG 2.1 A and AA rules and its best practices, in the light, dark and high-contrast themes. A failure
 * lists each rule with the elements that break it.
 */
type Found = { where: string; rule: string; impact: string | null | undefined; help: string; targets: string[] };

async function scan(page: Page, found: Found[], where: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  // Check the settled page, not a fade halfway through.
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
  await page.waitForTimeout(300);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  for (const v of result.violations) found.push({ where, rule: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 6).map((n) => `${n.target.join(' ')}${n.failureSummary ? ` :: ${n.failureSummary.replace(/\s+/g, ' ').slice(0, 220)}` : ''}`) });
}

function report(found: Found[], name: string): string {
  if (process.env.OMNIX_A11Y_REPORT) fs.writeFileSync(process.env.OMNIX_A11Y_REPORT.replace(/\.json$/, `-${name}.json`), JSON.stringify(found, null, 2));
  return found.map((f) => `${f.where}: ${f.rule} (${f.impact}) ${f.help}\n    ${f.targets.join('\n    ')}`).join('\n');
}

const PAGES = [
  ['/assets', 'library'],
  ['/presets', 'presets'],
  ['/activity', 'activity'],
  ['/settings', 'settings: account'],
  ['/settings/appearance', 'settings: appearance'],
  ['/settings/claude', 'settings: Claude'],
  ['/settings/plugins', 'settings: plugins'],
  ['/setup', 'setup guide'],
  ['/setup?ai=gpt', 'setup guide: ChatGPT & Codex'],
  ['/help/troubleshooting', 'troubleshooting'],
] as const;
const TOOLS = ['Image editor', 'Video editor', 'Recense', 'Animation maker', 'Code Grounds', 'Document', 'Slideshow'] as const;

/** The signed-in person's theme (kept on the server, so it is reset after each test). */
async function setTheme(page: Page, theme: 'system' | 'high-contrast'): Promise<void> {
  await page.evaluate(async (t) => {
    await fetch('/api/auth/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preferences: { theme: t } }) });
  }, theme);
}

test.afterEach(async ({ page }) => {
  if (page.url().startsWith('http')) await setTheme(page, 'system').catch(() => {});
});

async function paletteAction(page: Page, name: string): Promise<void> {
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill(name);
  await page.keyboard.press('Enter');
}

for (const scheme of ['light', 'dark', 'high-contrast'] as const) {
  test(`pages, editors, panels and dialogs pass axe (${scheme})`, async ({ page }) => {
    const found: Found[] = [];
    await page.emulateMedia({ colorScheme: scheme === 'light' ? 'light' : 'dark' });
    if (scheme === 'light') {
      await page.goto('/');
      await page.waitForSelector('form.auth-card');
      await scan(page, found, 'sign in');
    }
    await signIn(page);
    if (scheme === 'high-contrast') {
      await setTheme(page, 'high-contrast');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'high-contrast');
    }
    await scan(page, found, 'dashboard');
    for (const [path, name] of PAGES) {
      await page.goto(path);
      await scan(page, found, name);
    }
    for (const tool of TOOLS) {
      await page.goto('/');
      await page.waitForSelector('.create-row');
      await createProject(page, tool);
      await page.waitForSelector('.workbar');
      await scan(page, found, tool);
    }

    // The last project (a slideshow): its panels and dialogs.
    for (const panel of ['History', 'Session memory', 'Activity']) {
      await page.getByRole('button', { name: panel, exact: true }).click();
      await scan(page, found, `panel: ${panel}`);
      await page.getByRole('button', { name: panel, exact: true }).click();
    }
    for (const [panel, name] of [[/^Comments/, 'comments'], [/^Proposals/, 'proposals'], [/^Claude runs/, 'Claude runs']] as const) {
      await page.getByRole('button', { name: panel }).first().click();
      await scan(page, found, `panel: ${name}`);
      await page.getByRole('button', { name: panel }).first().click();
    }
    await paletteAction(page, 'Plugins');
    await expect(page.locator('aside.drawer')).toBeVisible();
    await scan(page, found, 'panel: plugins');

    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog')).toBeVisible();
    await scan(page, found, 'command palette');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+k');
    await expect(page.getByRole('dialog')).toBeVisible();
    await scan(page, found, 'command bar');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+?');
    await expect(page.getByRole('dialog')).toBeVisible();
    await scan(page, found, 'shortcuts');
    await page.keyboard.press('Escape');
    await paletteAction(page, 'Compare versions');
    await expect(page.getByRole('dialog', { name: 'Compare versions' })).toBeVisible();
    await scan(page, found, 'compare versions');
    await page.keyboard.press('Escape');
    await paletteAction(page, 'Apply to several documents');
    await expect(page.getByRole('dialog')).toBeVisible();
    await scan(page, found, 'batch');
    await page.keyboard.press('Escape');

    expect(found, report(found, scheme)).toEqual([]);
  });
}

test('keyboard focus moves through every editor with a visible focus ring', async ({ page }) => {
  await signIn(page);
  const problems: string[] = [];
  for (const tool of TOOLS) {
    await page.goto('/');
    await page.waitForSelector('.create-row');
    await createProject(page, tool);
    await page.waitForSelector('.workbar');
    await page.waitForLoadState('networkidle');
    const seen = new Set<string>();
    let repeats = 0;
    let last = '';
    for (let i = 0; i < 60; i++) {
      // Tab indents inside the code editor; Escape first lets the next Tab move on.
      if (await page.evaluate(() => !!document.activeElement?.closest('.cm-editor'))) await page.keyboard.press('Escape');
      await page.keyboard.press('Tab');
      const f = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body || el.classList.contains('skip-link')) return null;
        const cs = getComputedStyle(el);
        const ring = (cs.boxShadow !== 'none' && cs.boxShadow !== '') || (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || !!el.closest('.cm-editor');
        const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40);
        return { key: `${el.tagName.toLowerCase()}#${el.id}.${typeof el.className === 'string' ? el.className : ''}[${label}]`, ring };
      });
      if (!f) continue;
      repeats = f.key === last ? repeats + 1 : 0;
      last = f.key;
      if (repeats > 2) problems.push(`${tool}: focus stuck on ${f.key}`);
      if (!f.ring) problems.push(`${tool}: no focus ring on ${f.key}`);
      seen.add(f.key);
    }
    if (seen.size < 8) problems.push(`${tool}: only ${seen.size} focus stops`);
  }
  expect([...new Set(problems)]).toEqual([]);

  // Tab still indents code; Escape then Tab leaves the editor.
  await page.goto('/');
  await page.waitForSelector('.create-row');
  await createProject(page, 'Code Grounds');
  const content = page.locator('.code-pane .cm-content');
  await content.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(content).toBeFocused();
  await expect(content).toHaveAttribute('aria-describedby', /.+/);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await expect(content).not.toBeFocused();
  expect(await page.evaluate(() => !!document.activeElement?.closest('.cm-editor'))).toBe(false);
});
