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
