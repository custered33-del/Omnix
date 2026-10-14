import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { createProject, expect, signIn, test } from './fixtures.js';

const projectState = (page: Page) =>
  page.evaluate(async () => {
    const id = location.pathname.split('/').pop();
    return (await (await fetch(`/api/projects/${id}`)).json()).state as { nodes: Record<string, { type: string; props: Record<string, unknown> }> };
  });

test('documents: markdown shortcuts, a table, suggestions, comments and reload', async ({ page, errors }) => {
  await signIn(page);
  await createProject(page, 'Document');
  await page.waitForSelector('.doc-page');
  const texts = page.locator('.blk-text');
  await texts.nth(1).click();
  await page.keyboard.type('Sales grew strongly this quarter.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('## Highlights');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- First point');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second point');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Plain text with ');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('bold');
  await page.keyboard.press('Control+b');
  await page.keyboard.type(' words.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/tab');
  await expect(page.locator('.slash-item').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.doc-table')).toHaveCount(1);
  await expect
    .poll(async () => Object.values((await projectState(page)).nodes).filter((n) => n.type === 'block').map((n) => `${n.props.blockType}:${n.props.text}`))
    .toEqual(expect.arrayContaining(['heading:Highlights', 'bullet:First point', 'bullet:Second point', 'paragraph:Plain text with **bold** words.']));

  // Suggest an edit, then accept it.
  await page.click('button:has-text("Suggesting")');
  await texts.nth(1).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Up 12%.');
  await expect(page.locator('.suggestion-card')).toHaveCount(1);
  await page.click('button:has-text("Editing")');
  await page.locator('.suggestion-card button:has-text("Accept")').click();
  await expect(texts.nth(1)).toContainText('Up 12%.');

  // Comment on a selection.
  await texts.nth(0).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.click('.sel-toolbar button:has-text("Comment")');
  await page.keyboard.type('Should this title be shorter?');
  await page.click('.doc-margin button:has-text("Comment")');
  await expect(page.locator('.doc-margin .comment-card')).toHaveCount(1);

  await page.reload();
  await page.waitForSelector('.doc-page');
  await expect(page.locator('.doc-table')).toHaveCount(1);
  await expect(texts.nth(1)).toContainText('Up 12%.');
  expect(errors).toEqual([]);
});

test('slides: build a slide, animate it, present it and share a public link', async ({ page, browser, errors }) => {
  await signIn(page);
  await createProject(page, 'Slideshow');
  await page.waitForSelector('.slides-editor');
  await page.locator('.editor-toolbar button:has-text("Slide")').first().click();
  await page.click('[role=menuitem]:has-text("Title and body")');
  await expect(page.locator('.sorter-item')).toHaveCount(2);

  // Edit the title in place.
  await page.locator('.el-box').first().dblclick();
  await page.waitForSelector('.el-text-editor');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Roadmap for Seb');
  await page.keyboard.press('Escape');
  await expect.poll(async () => Object.values((await projectState(page)).nodes).some((n) => n.type === 'slideElement' && n.props.text === 'Roadmap for Seb')).toBe(true);

  // A shape that fades in on the first click.
  await page.locator('.editor-toolbar button:has-text("Shape")').click();
  await page.click('[role=menuitem]:has-text("Ellipse")');
  await page.selectOption('select[aria-label="Add animation"]', 'fade-in');
  await page.click('[role=tab]:has-text("Animations")');
  await expect(page.locator('.build-bar')).toHaveCount(1);

  await page.click('[role=tab]:has-text("Speaker notes")');
  await page.fill('textarea[aria-label="Speaker notes"]', 'Mention the timeline.');
  await page.locator('textarea[aria-label="Speaker notes"]').blur();

  // Present from the start: two slides, notes in the presenter view.
  await page.keyboard.press('Shift+F5').catch(() => {});
  if (!(await page.locator('.presenter').count())) await page.click('.editor-toolbar button:has-text("Present")');
  await page.waitForSelector('.presenter');
  await page.keyboard.press('Escape');
  await expect(page.locator('.presenter')).toHaveCount(0);

  // Import a PowerPoint file through the API, then share the deck.
  const pptx = fs.readFileSync(fileURLToPath(new URL('../packages/exporters/test/fixtures/sample.pptx', import.meta.url)));
  const imported = await page.evaluate(async (b64) => {
    const id = location.pathname.split('/').pop();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const up = await (await fetch(`/api/assets?name=sample.pptx&projectId=${id}`, { method: 'POST', body: bytes })).json();
    const st = (await (await fetch(`/api/projects/${id}`)).json()).state;
    const deck = Object.values(st.nodes as Record<string, { id: string; type: string }>).find((x) => x.type === 'deck')!;
    return (await (await fetch(`/api/projects/${id}/decks/${deck.id}/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetId: up.asset.id }) })).json()).slides as number;
  }, pptx.toString('base64'));
  expect(imported).toBe(5);
  await expect(page.locator('.sorter-item')).toHaveCount(7);

  await page.click('.slide-inspector [role=tab]:has-text("Theme")');
  await page.click('text=Anyone with the link can watch');
  const link = page.locator('input[aria-label="Presentation link"]');
  await expect(link).toHaveValue(/\/present\/[\w-]+$/);
  const url = await link.inputValue();

  // Someone without an account watches it.
  const viewer = await browser.newContext();
  const watch = await viewer.newPage();
  await watch.goto(url);
  await watch.waitForSelector('.presenter');
  await expect(watch.locator('.presenter')).toHaveAttribute('aria-label', /slide 1 of 6/);
  await watch.keyboard.press('End');
  await expect(watch.locator('.presenter')).toHaveAttribute('aria-label', /slide 6 of 6/);
  await expect(watch.locator('.presenter-notes')).toHaveCount(0);

  // Turning sharing off closes the link.
  await page.click('text=Anyone with the link can watch');
  await expect(link).toHaveCount(0);
  await watch.reload();
  await expect(watch.getByRole('heading', { name: 'Presentation unavailable' })).toBeVisible();
  await viewer.close();
  expect(errors).toEqual([]);
});

test('setup guide: seven steps, saved progress, the connection test and the sample project', async ({ page, errors }) => {
  await signIn(page);
  await page.goto('/setup?step=account');
  await expect(page.getByRole('heading', { level: 2, name: 'Your Omnix account' })).toBeVisible();
  await expect(page.getByText(/salted hash of your password/)).toBeVisible();
  const steps = ["Open Claude's connector settings", 'Add Omnix as a connector', 'Sign in and approve', 'Choose what Claude may do'];
  for (const name of steps) {
    await page.click('.setup-footer .btn-primary');
    await expect(page.getByRole('heading', { level: 2, name })).toBeFocused();
  }
  await page.getByRole('radio', { name: /Autonomous/ }).click();
  await page.click('.setup-footer .btn-primary');
  await expect(page.getByRole('heading', { level: 2, name: 'Test the connection' })).toBeVisible();

  // Progress survives a reload.
  await page.goto('/setup');
  await expect(page.getByRole('heading', { level: 2, name: 'Test the connection' })).toBeVisible();
  await expect(page.locator('.setup-step.done')).toHaveCount(5);

  await page.getByRole('button', { name: /Run the test/ }).click();
  await expect(page.locator('.check')).toHaveCount(5, { timeout: 30_000 });
  await expect(page.locator('.check.pass')).toHaveCount(3);
  await expect(page.locator('.check', { hasText: 'Create a blank test note' })).toContainText('added');

  // Troubleshooting opens the matching entry.
  await page.locator('.check', { hasText: 'Address for Claude' }).getByRole('link', { name: 'More help' }).click();
  await expect(page.locator('#local-address')).toHaveAttribute('open', '');
  await page.goBack();

  await page.click('.setup-footer .btn-primary');
  await page.getByRole('button', { name: /Open the sample/ }).click();
  await page.waitForSelector('.slides-editor');
  await expect(page.locator('.sorter-item')).toHaveCount(3);
  await expect(page.getByText('AI is off for this project')).toHaveCount(0);

  // The dashboard tour.
  await page.goto('/?tour=1');
  await expect(page.locator('.tour-pop')).toBeVisible();
  for (let i = 0; i < 5; i++) await page.locator('.tour-pop .btn-primary').click();
  await page.locator('.tour-pop .btn-primary', { hasText: 'Done' }).click();
  await expect(page.locator('.tour-pop')).toHaveCount(0);
  expect(errors).toEqual([]);
});
