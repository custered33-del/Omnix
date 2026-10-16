import { createProject, expect, signIn, test } from './fixtures.js';

test('animation maker: playing shows the frames moving, without onion skin', async ({ page, errors }) => {
  await signIn(page);
  await createProject(page, 'Animation maker');
  const st = (await page.locator('.tl-stage').boundingBox())!;
  const cx = st.x + st.width / 2;
  const cy = st.y + st.height / 2;
  const draw = async (dx: number) => {
    await page.mouse.move(cx - 150 + dx, cy);
    await page.mouse.down();
    for (let i = 0; i < 12; i++) await page.mouse.move(cx - 150 + dx + i * 8, cy - 30 + Math.sin(i / 3) * 30);
    await page.mouse.up();
  };
  await draw(0);
  await page.click('button[aria-label="Add frame"]');
  await draw(160);
  await page.click('button[aria-label="Add frame"]');
  await draw(300);
  await page.getByRole('button', { name: 'Play' }).first().click();
  const canvas = page.locator('.tl-stage canvas').first();
  // While playing, the picture changes from one moment to the next.
  const seen = new Set<string>();
  for (let i = 0; i < 8; i++) {
    seen.add((await canvas.screenshot()).toString('base64'));
    await page.waitForTimeout(60);
  }
  expect(seen.size).toBeGreaterThan(1);
  expect(errors).toEqual([]);
});
