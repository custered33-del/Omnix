import { expect, signIn, test } from './fixtures.js';

test('setup guide: switching to ChatGPT & Codex shows how to connect them', async ({ page, errors }) => {
  await signIn(page);
  await page.goto('/setup');
  await page.getByRole('button', { name: 'ChatGPT & Codex' }).click();
  await expect(page.getByRole('heading', { name: /ChatGPT/ }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /Codex/ }).first()).toBeVisible();
  await expect(page.getByText('[mcp_servers.omnix]')).toBeVisible();
  await page.getByRole('button', { name: 'Claude', exact: true }).click();
  await expect(page.locator('.setup-steps')).toBeVisible();
  expect(errors).toEqual([]);
});
