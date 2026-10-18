import { createProject, expect, media, signIn, test } from './fixtures.js';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const fitsWidth = (page: import('@playwright/test').Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('phone: home has a bottom tab bar and nothing spills off the side', async ({ page, errors }) => {
  await signIn(page);
  await expect(page.getByRole('navigation', { name: 'Main (phone)' })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  await page.getByRole('navigation', { name: 'Main (phone)' }).getByRole('link', { name: 'Assets' }).click();
  await expect(page).toHaveURL(/\/assets/);
  expect(errors).toEqual([]);
});

for (const tool of ['Recense', 'Video editor', 'Image editor', 'Slideshow', 'Code Grounds', 'Document', 'Animation maker'] as const) {
  test(`phone: ${tool} fits the screen and its panels slide up from the bottom`, async ({ page, errors }) => {
    await signIn(page);
    await createProject(page, tool);
    const bar = page.getByRole('navigation', { name: 'Panels' });
    await expect(bar).toBeVisible();
    expect(await fitsWidth(page)).toBe(true);
    // Every panel button opens its sheet on screen, and tapping outside closes it.
    for (const btn of await bar.getByRole('button').all()) {
      const name = (await btn.innerText()).trim();
      if (name === 'Ask AI' || name === 'Comments') continue;
      await btn.click();
      await expect(btn).toHaveAttribute('aria-pressed', 'true');
      const sheet = page.locator('.workspace[data-sheet] :is(.tl-media, .tl-inspector, .image-editor > .inspector, .slide-sorter, .slide-inspector, .code-files, .code-side, .doc-outline)').filter({ visible: true }).first();
      const box = (await sheet.boundingBox())!;
      expect(box.width).toBeGreaterThan(380);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
      await page.locator('.phone-scrim').click({ position: { x: 10, y: 80 } });
      await expect(btn).toHaveAttribute('aria-pressed', 'false');
    }
    if (tool === 'Recense') {
      await bar.getByRole('button', { name: 'Edit' }).click();
      await page.setInputFiles('.tl-media input[type=file]', [media.clip]);
      await page.locator('.media-item', { hasText: 'clip.mp4' }).dblclick();
      await page.locator('.phone-scrim').click({ position: { x: 10, y: 80 } });
      await expect(page.locator('.tl-clip')).toHaveCount(1);
    }
    // The rest of the project's tools are one tap away.
    await page.getByRole('button', { name: 'More' }).click();
    await expect(page.getByRole('menuitem', { name: /History/ })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });
}
