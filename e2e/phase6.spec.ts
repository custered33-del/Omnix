import type { Page } from '@playwright/test';
import { createProject, expect, signIn, test } from './fixtures.js';

type State = { rootId: string; nodes: Record<string, { id: string; type: string; parentId: string | null; children: string[]; props: Record<string, any> }> };

const projectState = (page: Page) =>
  page.evaluate(async () => {
    const id = location.pathname.split('/').pop();
    return (await (await fetch(`/api/projects/${id}`)).json()).state;
  }) as Promise<State>;

const blockTexts = async (page: Page) =>
  Object.values((await projectState(page)).nodes)
    .filter((n) => n.type === 'block')
    .map((n) => n.props.text as string);

const codeFile = async (page: Page) => Object.values((await projectState(page)).nodes).find((n) => n.type === 'codeFile')!.props.content as string;

/** A second window on the same project (the same person, as when working in two tabs). */
async function secondWindow(page: Page): Promise<Page> {
  const other = await page.context().newPage();
  await other.goto(page.url());
  return other;
}

test('two people typing in one paragraph both keep their words, and undo takes back only one edit', async ({ page, errors }) => {
  await signIn(page);
  await createProject(page, 'Document');
  await page.waitForSelector('.doc-page');
  const para = page.locator('.blk-text').nth(1);
  await para.click();
  await page.keyboard.type('The lamp is bright.');
  await expect.poll(() => blockTexts(page)).toContain('The lamp is bright.');

  const other = await secondWindow(page);
  await other.waitForSelector('.doc-page');
  const otherPara = other.locator('.blk-text').nth(1);
  await expect(otherPara).toHaveText('The lamp is bright.');

  // Both type at once: one at the end, the other at the start.
  await para.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Buy it.');
  await otherPara.click();
  await other.keyboard.press('Home');
  await other.keyboard.type('Aurora: ');
  const both = 'Aurora: The lamp is bright. Buy it.';
  await expect.poll(() => blockTexts(page)).toContain(both);
  await expect(para).toHaveText(both);
  await expect(otherPara).toHaveText(both);

  // Ctrl+Z in the paragraph is the project's undo: the latest edit (the second window's) goes,
  // and the other edit stays.
  await para.click();
  await page.keyboard.press('Control+z');
  await expect.poll(() => blockTexts(page)).toContain('The lamp is bright. Buy it.');
  await expect(otherPara).toHaveText('The lamp is bright. Buy it.');
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => blockTexts(page)).toContain(both);
  await other.close();
  expect(errors).toEqual([]);
});

test('Code Grounds: edits from two windows merge, and Ctrl+Z only takes back your own typing', async ({ page, errors }) => {
  await signIn(page);
  await createProject(page, 'Code Grounds');
  await page.waitForSelector('.cm-content');
  const start = await codeFile(page);
  const other = await secondWindow(page);
  await other.waitForSelector('.cm-content');

  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('End');
  await page.keyboard.type('  # mine');
  await other.locator('.cm-content').click();
  await other.keyboard.press('Control+End');
  await other.keyboard.type('\n# theirs');
  const lines = start.split('\n');
  const mine = [`${lines[0]}  # mine`, ...lines.slice(1)].join('\n');
  await expect.poll(() => codeFile(page)).toBe(`${mine}\n# theirs`);
  await expect(page.locator('.cm-content')).toContainText('# theirs');

  // Undo in the editor removes only what this window typed.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+z');
  await expect.poll(() => codeFile(page)).toBe(`${start}\n# theirs`);
  await other.close();
  expect(errors).toEqual([]);
});

test('typing survives an immediate reload, and the status says so while it is saving', async ({ page, errors }) => {
  await signIn(page);
  await createProject(page, 'Document');
  await page.waitForSelector('.doc-page');
  await page.locator('.blk-text').nth(1).click();
  await page.keyboard.type('Saved before I left.');
  await expect(page.locator('.save-status')).toContainText('Saving');
  await page.reload();
  await page.waitForSelector('.doc-page');
  await expect(page.locator('.blk-text').nth(1)).toHaveText('Saved before I left.');
  await expect.poll(() => blockTexts(page)).toContain('Saved before I left.');
  await expect(page.locator('.save-status')).toContainText('saved');
  expect(errors).toEqual([]);
});

test('renaming: Escape cancels, the dashboard dialog starts from the current name and Enter saves', async ({ page, errors }) => {
  await signIn(page);
  await createProject(page, 'Slideshow');
  const title = page.locator('.title-input');
  const original = await title.inputValue();
  await title.fill('Oops typo');
  await title.press('Escape');
  await expect(title).toHaveValue(original);
  await title.fill('Quarterly review');
  await title.press('Enter');
  await expect
    .poll(() => page.evaluate(async () => (await (await fetch(`/api/projects/${location.pathname.split('/').pop()}`)).json()).project.name))
    .toBe('Quarterly review');

  await page.getByRole('button', { name: 'Home' }).click();
  await page.waitForSelector('.create-row');
  await page.getByRole('button', { name: 'More: Quarterly review' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const input = page.getByRole('dialog').getByRole('textbox');
  await expect(input).toHaveValue('Quarterly review');
  await input.fill('Weekly review');
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.project-card .name').first()).toHaveText('Weekly review');
  expect(errors).toEqual([]);
});

test('going back to an older version keeps the later ones in History', async ({ page, errors }) => {
  await signIn(page);
  await createProject(page, 'Slideshow');
  await page.waitForSelector('.slide-canvas');
  for (let i = 0; i < 2; i++) {
    await page.locator('.editor-toolbar').getByRole('button', { name: 'New slide' }).click();
    await page.getByRole('menuitem', { name: 'Title and body' }).click();
  }
  await expect.poll(async () => Object.values((await projectState(page)).nodes).filter((n) => n.type === 'slide').length).toBe(3);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const rows = page.locator('.drawer ol .list-row');
  const count = await rows.count();
  await rows.last().click();
  await page.getByRole('button', { name: 'Go to this version' }).click();
  // The oldest change added the second slide.
  await expect.poll(async () => Object.values((await projectState(page)).nodes).filter((n) => n.type === 'slide').length).toBe(2);
  // Every version is still listed, and the later ones are marked.
  await expect(rows).toHaveCount(count);
  await expect(page.locator('.drawer .list-row.off-branch').first()).toBeVisible();
  await expect(page.locator('.drawer .badge', { hasText: 'Later version' })).toHaveCount(1);
  expect(errors).toEqual([]);
});
