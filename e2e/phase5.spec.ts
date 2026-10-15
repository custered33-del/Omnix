import type { Page } from '@playwright/test';
import { createProject, expect, signIn, test } from './fixtures.js';

type State = { rootId: string; nodes: Record<string, { id: string; type: string; parentId: string | null; children: string[]; props: Record<string, any> }> };

const projectState = (page: Page) =>
  page.evaluate(async () => {
    const id = location.pathname.split('/').pop();
    return (await (await fetch(`/api/projects/${id}`)).json()).state;
  }) as Promise<State>;

const comments = async (page: Page) => {
  const s = await projectState(page);
  return Object.values(s.nodes).filter((n) => n.type === 'comment');
};

test('comments pin to slides and code lines, and the panel jumps back to them', async ({ page, errors }) => {
  await signIn(page);
  await createProject(page, 'Slideshow');
  await page.waitForSelector('.slide-canvas');

  // Comment mode: click the slide, write, and a numbered pin stays there.
  await page.keyboard.press('Control+Alt+m');
  await expect(page.locator('.commenting-banner')).toBeVisible();
  const box = (await page.locator('.slide-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.25);
  await page.getByRole('textbox', { name: 'Comment' }).fill('Room for the logo here?');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Comment 1 by Seb' })).toBeVisible();
  const [onSlide] = await comments(page);
  expect(onSlide!.props.anchor).toMatchObject({ tool: 'slides', x: expect.any(Number), y: expect.any(Number) });
  expect(onSlide!.props.anchor.x).toBeGreaterThan(1300);

  // Code: clicking a line in comment mode pins a comment to that line.
  await page.getByRole('button', { name: 'Add to this project' }).click();
  await page.getByRole('menuitem', { name: /Code Grounds/ }).click();
  await page.waitForSelector('.cm-content');
  await page.locator('.cm-line').nth(1).click();
  await page.getByRole('textbox', { name: 'Comment' }).fill('Explain this step');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.locator('.cm-comment-marker')).toHaveText('1');
  const onLine = (await comments(page)).find((c) => c.props.text === 'Explain this step')!;
  expect(onLine.props.anchor).toMatchObject({ tool: 'code', line: 2 });
  await page.keyboard.press('Escape');
  await expect(page.locator('.commenting-banner')).toHaveCount(0);

  // The comments panel lists both; Show opens the slideshow with the thread.
  await page.getByRole('button', { name: /^Comments \(/ }).click();
  const panel = page.locator('.drawer');
  await expect(panel.getByText('Room for the logo here?')).toBeVisible();
  await expect(panel.getByText(/line 2/)).toBeVisible();
  await panel.locator('[id^="comment-"]', { hasText: 'Room for the logo' }).getByRole('button', { name: 'Show' }).click();
  await expect(page.locator('.slide-canvas')).toBeVisible();
  await expect(page.locator('.pin-popover')).toContainText('Room for the logo here?');

  // Resolving from the pin updates the count everywhere.
  await page.locator('.pin-popover').getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByRole('button', { name: /^Comments \(1 comment\)/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a saved version compares with the current one as pictures and as text', async ({ page, errors }) => {
  await signIn(page);
  await createProject(page, 'Image editor');
  await page.waitForSelector('.viewport canvas.doc');
  const projectId = page.url().split('/').pop()!;
  const s = await projectState(page);
  const canvas = Object.values(s.nodes).find((n) => n.type === 'canvas')!;
  const layer = { id: 'lyr_e2esky', type: 'layer', parentId: canvas.id, children: [], props: { name: 'Sky', layerType: 'fill', fillColor: '#3366cc', visible: true, locked: false, opacity: 1, blendMode: 'normal', x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, mask: null, vectorMask: null, filters: [] } };
  expect((await page.request.post(`/api/projects/${projectId}/commits`, { data: { op: { kind: 'create', parentId: canvas.id, nodes: [layer] }, label: 'Add sky' } })).ok()).toBe(true);
  // Save a version from the History panel, then change the picture.
  await page.getByRole('button', { name: 'History' }).click();
  await page.getByRole('textbox', { name: 'Version name' }).fill('Blue');
  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.locator('.version-row')).toContainText('Blue');
  expect((await page.request.post(`/api/projects/${projectId}/commits`, { data: { op: { kind: 'update', id: 'lyr_e2esky', set: { fillColor: '#cc3333' } }, label: 'Red sky' } })).ok()).toBe(true);

  await page.getByRole('button', { name: 'Compare with current: Blue' }).click();
  const dialog = page.getByRole('dialog', { name: 'Compare versions' });
  await expect(dialog.getByText(/of the picture changed/)).toBeVisible();
  await expect(dialog.getByRole('img', { name: 'Blue' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Difference' }).click();
  await expect(dialog.getByRole('img', { name: /of the picture changed/ })).toBeVisible();
  await dialog.getByRole('button', { name: 'Swipe' }).click();
  await dialog.getByRole('slider', { name: 'Swipe between versions' }).fill('20');
  // Going back to the saved version restores it.
  await dialog.getByRole('button', { name: 'Go back to "Blue"' }).click();
  await expect.poll(async () => (await projectState(page)).nodes['lyr_e2esky']?.props.fillColor).toBe('#3366cc');
  expect(errors).toEqual([]);
});

test('people watching the public link follow the presenter, and can browse on their own', async ({ page, browser, errors }) => {
  await signIn(page);
  await createProject(page, 'Slideshow');
  await page.waitForSelector('.slide-canvas');
  for (let i = 0; i < 2; i++) {
    await page.locator('.editor-toolbar').getByRole('button', { name: 'New slide' }).click();
    await page.getByRole('menuitem', { name: 'Title and body' }).click();
  }
  await expect(page.locator('.sorter-item')).toHaveCount(3);
  await page.click('.slide-inspector [role=tab]:has-text("Theme")');
  await page.click('text=Anyone with the link can watch');
  const url = await page.locator('input[aria-label="Presentation link"]').inputValue();

  const viewer = await browser.newContext();
  const watch = await viewer.newPage();
  await watch.goto(url);
  await expect(watch.locator('.presenter')).toHaveAttribute('aria-label', /slide 1 of 3/);
  await expect(watch.locator('.follow-banner')).toHaveCount(0);

  // Seb presents from the start; the viewer follows.
  await page.locator('.sorter-item').first().click();
  await page.click('.editor-toolbar button:has-text("Present")');
  await page.waitForSelector('.presenter');
  await expect(watch.getByText('Following the presenter')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(watch.locator('.presenter')).toHaveAttribute('aria-label', /slide 2 of 3/);
  await page.keyboard.press('ArrowRight');
  await expect(watch.locator('.presenter')).toHaveAttribute('aria-label', /slide 3 of 3/);

  // Moving on their own stops following; following again jumps back to the presenter.
  await watch.keyboard.press('Home');
  await expect(watch.getByText('Browsing on your own')).toBeVisible();
  await expect(watch.locator('.presenter')).toHaveAttribute('aria-label', /slide 1 of 3/);
  await page.keyboard.press('ArrowLeft');
  await expect(watch.locator('.presenter')).toHaveAttribute('aria-label', /slide 1 of 3/);
  await watch.getByRole('button', { name: 'Follow the presenter' }).click();
  await expect(watch.locator('.presenter')).toHaveAttribute('aria-label', /slide 2 of 3/);

  // When Seb stops presenting, the banner goes and the viewer is free again.
  await page.keyboard.press('Escape');
  await expect(page.locator('.presenter')).toHaveCount(0);
  await expect(watch.locator('.follow-banner')).toHaveCount(0);
  await viewer.close();
  expect(errors).toEqual([]);
});
