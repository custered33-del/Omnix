import { test, expect, signIn, createProject, media } from './fixtures.js';

test.describe.configure({ mode: 'serial' });

test('image editor: shapes, brush strokes, text and selection save and survive a reload', async ({ page, errors }) => {
  await signIn(page);
  await createProject(page, 'Image editor');
  const vp = page.locator('.viewport');
  await expect(vp.locator('canvas.doc')).toBeVisible();
  const box = (await vp.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.keyboard.press('u');
  await page.mouse.move(cx - 200, cy - 120);
  await page.mouse.down();
  await page.mouse.move(cx - 40, cy + 20, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('b');
  await page.mouse.move(cx - 100, cy + 100);
  await page.mouse.down();
  for (let i = 0; i < 20; i++) await page.mouse.move(cx - 100 + i * 10, cy + 100 + Math.sin(i / 3) * 40);
  await page.mouse.up();
  await page.keyboard.press('t');
  await page.mouse.click(cx + 60, cy - 100);
  await page.keyboard.type('Hello Seb');
  await page.mouse.click(box.x + 10, box.y + 10);
  await expect(page.locator('.layer-row .name')).toHaveCount(4);
  await expect(page.getByText('Hello Seb', { exact: false }).first()).toBeAttached();
  await expect(page.locator('.workbar [role=status]')).toHaveText('All changes saved');
  await page.reload();
  await expect(page.locator('.layer-row .name')).toHaveCount(4);
  await expect(page.locator('.layer-row .name').filter({ hasText: 'Hello Seb' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('video editor: media, titles, split, playback and the mixer', async ({ page, errors }) => {
  await signIn(page);
  await createProject(page, 'Video editor');
  await page.setInputFiles('.tl-media input[type=file]', [media.clip, media.music]);
  await expect(page.locator('.media-item')).toHaveCount(2);
  await page.locator('.media-item', { hasText: 'clip.mp4' }).dblclick();
  await page.locator('.media-item', { hasText: 'music.mp3' }).dblclick();
  await page.click('.tl-media button:has-text("Add title")');
  await expect(page.locator('.tl-clip')).toHaveCount(3);
  const ruler = (await page.locator('.tl-ruler').boundingBox())!;
  await page.mouse.click(ruler.x + 2 * 60 + 1, ruler.y + 10);
  await expect(page.locator('.timecode')).toHaveText(/00:00:0[12]:\d\d/);
  const before = await page.locator('.timecode').innerText();
  await page.locator('.tl-clip').first().click();
  await page.keyboard.press('s');
  await expect(page.locator('.tl-clip')).toHaveCount(4);
  await page.keyboard.press('Space');
  await page.waitForTimeout(700);
  await page.keyboard.press('Space');
  await expect(page.locator('.timecode')).not.toHaveText(before);
  await page.click('button[role=tab]:has-text("Mixer")');
  await expect(page.locator('.strip strong')).toHaveText(['Video 1', 'Audio 1']);
  expect(errors).toEqual([]);
});

test('animation maker: frames, onion skin and a rig', async ({ page, errors }) => {
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
  await draw(60);
  await expect(page.locator('.frame-cell')).toHaveCount(2);
  await page.click('button[aria-label="Add bone"]');
  await page.mouse.move(cx + 100, cy + 100);
  await page.mouse.down();
  await page.mouse.move(cx + 180, cy + 60, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('[aria-label="Bones"] li')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('Code Grounds: run a file, run cells and draw a chart', async ({ page, errors }) => {
  await signIn(page);
  await createProject(page, 'Code Grounds');
  await page.click('.code-tabs button:has-text("Run")');
  await expect(page.locator('.terminal')).toContainText('Hello from Omnix', { timeout: 60_000 });
  await page.click('.code-files .file-row:has-text("Notebook")');
  await page.locator('.notebook .cell-gutter button').first().click();
  await expect(page.locator('.cell-outputs').first()).toContainText('45', { timeout: 60_000 });
  await page.click('.notebook button:has-text("Add cell")');
  await page.keyboard.type("omnix.chart(type='line', labels=['a','b','c'], series=[{'name':'s','values':[1,3,2]}])");
  await page.keyboard.press('Shift+Enter');
  await expect(page.locator('.chart-box canvas')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Show as table' }).click();
  await expect(page.locator('.chart-box table')).toContainText('3');
  expect(errors).toEqual([]);
});
