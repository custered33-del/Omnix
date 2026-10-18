import { createProject, expect, media, signIn, test } from './fixtures.js';

test('Recense: find the beats of a song and make a hype edit', async ({ page, errors }) => {
  await signIn(page);
  await createProject(page, 'Recense');
  await expect(page.getByText('Make an edit')).toBeVisible();
  await page.setInputFiles('.tl-media input[type=file]', [media.clip, media.beat]);
  await expect(page.locator('.media-item')).toHaveCount(2);
  await page.locator('.media-item', { hasText: 'clip.mp4' }).dblclick();
  await page.locator('.media-item', { hasText: 'beat.mp3' }).dblclick();
  await page.getByRole('button', { name: 'Find the beats' }).click();
  await expect(page.getByRole('button', { name: /Beats: \d+ · 1[12]\d(\.\d)? BPM/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('group', { name: 'Edit styles' }).getByRole('button', { name: 'Hype' }).click();
  await expect(page.getByText(/Hype edit: \d+ cuts/)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.tl-track-head', { hasText: 'Zoom punch on beat' }).or(page.getByText('Zoom punch on beat').first())).toBeVisible();
  // Play a moment: the effects draw without errors.
  await page.getByRole('button', { name: 'Play' }).first().click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Pause' }).first().click();
  expect(errors).toEqual([]);
});
