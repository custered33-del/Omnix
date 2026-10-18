import { createProject, expect, media, signIn, test } from './fixtures.js';

test('video: fade the sound and record movement by dragging on the preview', async ({ page, errors }) => {
  await signIn(page);
  await createProject(page, 'Video editor');
  await page.setInputFiles('.tl-media input[type=file]', [media.clip]);
  await page.locator('.media-item', { hasText: 'clip.mp4' }).dblclick();
  const clip = page.locator('.tl-clip').first();
  await clip.click();
  // Fades: a quick button, shown on the clip.
  await page.getByRole('group', { name: 'Quick fades' }).getByRole('button', { name: 'Fade 1s' }).click();
  await expect(clip.locator('.fade.in')).toHaveCount(1);
  await expect(clip.locator('.fade.out')).toHaveCount(1);

  // Record movement: drag at 1 s, then at 3 s; the clip gets keyframes and moves between them.
  await page.locator('.tl-toolbar').getByRole('button', { name: 'Record movement' }).click();
  const ruler = (await page.locator('.tl-ruler').boundingBox())!;
  const stage = (await page.locator('.tl-stage').boundingBox())!;
  const cx = stage.x + stage.width / 2;
  const cy = stage.y + stage.height / 2;
  const dragBy = async (dx: number, dy: number) => {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx / 2, cy + dy / 2);
    await page.mouse.move(cx + dx, cy + dy);
    await page.mouse.up();
  };
  await page.mouse.click(ruler.x + 1 * 60 + 1, ruler.y + 10);
  await clip.click({ position: { x: 5, y: 10 } });
  await dragBy(-80, 0);
  await page.mouse.click(ruler.x + 3 * 60 + 1, ruler.y + 10);
  await clip.click({ position: { x: 5, y: 10 } });
  await dragBy(160, 40);
  // Keys at 0 (where it started), 1 s and 3 s.
  await expect(clip.locator('.kf')).toHaveCount(3);
  const x = page.getByRole('textbox', { name: 'X', exact: true });
  await page.mouse.click(ruler.x + 2 * 60 + 1, ruler.y + 10);
  const mid = Number(await x.inputValue());
  await page.mouse.click(ruler.x + 3 * 60 + 1, ruler.y + 10);
  const end = Number(await x.inputValue());
  expect(end).toBeGreaterThan(mid);
  expect(errors).toEqual([]);
});
