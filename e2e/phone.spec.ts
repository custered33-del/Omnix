import { expect, signIn, test } from './fixtures.js';

test('phone: a QR code and link to open Omnix on a phone', async ({ page, errors }) => {
  await signIn(page);
  // This test machine has no home-network address, so give it one; the phone signs in through it.
  const port = new URL(page.url()).port;
  await page.route('**/api/claude/setup-info', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), lanUrls: [`http://127.0.0.1:${port}`] } });
  });
  await page.getByRole('button', { name: 'Open on your phone' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open Omnix on your phone' });
  await expect(dialog.getByRole('img', { name: `QR code for http://127.0.0.1:${port}` })).toBeVisible();
  await expect(dialog.getByText('same Wi-Fi')).toBeVisible();
  // The link works: a "phone" (a fresh browser) signs in through it.
  const phone = await page.context().browser()!.newContext({ viewport: { width: 390, height: 844 } });
  const p = await phone.newPage();
  await p.goto(`http://127.0.0.1:${port}/`);
  await p.fill('#email', 'seb@example.com');
  await p.fill('#password', 'correct-horse-battery');
  await p.click('button[type=submit]');
  await expect(p.locator('.create-row')).toBeVisible();
  await phone.close();
  expect(errors).toEqual([]);
});
