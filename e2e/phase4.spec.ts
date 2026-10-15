import crypto from 'node:crypto';
import type { Page } from '@playwright/test';
import { createProject, expect, signIn, test } from './fixtures.js';

type State = { rootId: string; nodes: Record<string, { id: string; type: string; parentId: string | null; children: string[]; props: Record<string, any> }> };

const projectState = (page: Page) =>
  page.evaluate(async () => {
    const id = location.pathname.split('/').pop();
    return (await (await fetch(`/api/projects/${id}`)).json()).state;
  }) as Promise<State>;

test('Claude connects with OAuth: consent page, chosen permission, working token', async ({ page, errors }) => {
  await signIn(page);
  const redirect = 'http://127.0.0.1:59999/callback';
  const reg = await page.request.post('/oauth/register', { data: { client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] } });
  expect(reg.status()).toBe(201);
  const client = await reg.json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  // The browser follows the authorize redirect to the consent page; the final redirect back to Claude is captured.
  let landed = '';
  await page.route('http://127.0.0.1:59999/**', async (route) => {
    landed = route.request().url();
    await route.fulfill({ status: 200, body: 'Connected, you can close this window.' });
  });
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'omnix:read omnix:edit omnix:autonomous' });
  await page.goto(`/oauth/authorize?${q}`);
  await expect(page.getByRole('heading', { name: 'Claude wants to connect to Omnix' })).toBeVisible();
  await page.getByRole('radio', { name: /Autonomous/ }).click();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => landed).toContain('code=');
  const back = new URL(landed);
  expect(back.searchParams.get('state')).toBe('xyz');
  const tok = await page.request.post('/oauth/token', { form: { grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier } });
  expect(tok.status()).toBe(200);
  const { access_token } = await tok.json();
  // The token speaks MCP.
  const init = await page.request.post('/mcp', {
    headers: { authorization: `Bearer ${access_token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } },
  });
  expect(init.status()).toBe(200);
  // The dashboard shows Claude connected in autonomous mode.
  await page.goto('/');
  await expect(page.locator('.status-card')).toContainText('Connected');
  const status = await (await page.request.get('/api/claude/status')).json();
  expect(status.connections.some((c: { kind: string; mode: string }) => c.kind === 'oauth' && c.mode === 'autonomous')).toBe(true);
  expect(errors).toEqual([]);
});

test('commands: describe a change, review the steps, accept, and it is remembered', async ({ page, errors }) => {
  await signIn(page);
  await createProject(page, 'Image editor');
  await page.waitForSelector('.viewport canvas.doc');
  const s0 = await projectState(page);
  const canvas = s0.nodes[s0.rootId]!.children.find((id) => s0.nodes[id]!.type === 'canvas')!;
  const title = { id: `lyr_${crypto.randomBytes(6).toString('hex')}`, type: 'layer', parentId: canvas, children: [], props: { name: 'Title', layerType: 'text', text: 'Hello', fontSize: 80, color: '#111111', x: 100, y: 500, visible: true, locked: false, opacity: 1, blendMode: 'normal', scaleX: 1, scaleY: 1, rotation: 0, mask: null, vectorMask: null, filters: [] } };
  const projectId = page.url().split('/').pop()!;
  await page.request.post(`/api/projects/${projectId}/commits`, { data: { op: { kind: 'create', parentId: canvas, nodes: [title] }, label: 'Add title' } });
  await expect(page.locator('.layer-row', { hasText: 'Title' })).toBeVisible();

  await page.getByRole('button', { name: 'Describe a change' }).click();
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('make the title red and move it to the top');
  await page.keyboard.press('Enter');
  const steps = page.locator('.command-body .proposal-steps li');
  await expect(steps).toHaveText(['Make the title red', 'Move it to the top']);
  // Nothing changed yet: it is a proposal.
  expect((await projectState(page)).nodes[title.id]!.props.color).toBe('#111111');
  await page.locator('.command-body').getByRole('button', { name: 'Accept all' }).click();
  await expect.poll(async () => (await projectState(page)).nodes[title.id]!.props.color).toBe('#e03131');
  expect((await projectState(page)).nodes[title.id]!.props.y).toBeLessThan(200);

  // Session memory has the command.
  await page.getByRole('button', { name: 'Session memory' }).click();
  await expect(page.locator('.note-card').first()).toContainText('make the title red and move it to the top');

  // Phrases it cannot parse come back with examples (no Claude API key on this server).
  await page.keyboard.press('Control+Shift+K');
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('frobnicate the widget');
  await page.keyboard.press('Enter');
  await expect(page.locator('.unmatched')).toContainText('frobnicate the widget');
  await expect(page.locator('.command-body .chip').first()).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('runs: without an API key the runner explains how to start the goal from Claude', async ({ page, errors }) => {
  await signIn(page);
  await createProject(page, 'Document');
  await page.waitForSelector('.doc-page');
  await page.getByRole('button', { name: /^Claude runs/ }).click();
  await page.locator('.drawer').getByRole('button', { name: 'Run a goal with Claude' }).click();
  await page.locator('#agent-goal').fill('Write a launch brief and turn it into slides');
  await expect(page.locator('.ai-note')).toContainText('needs a Claude API key');
  await expect(page.locator('.copy-block')).toContainText('agent_start_run');
  await expect(page.locator('.copy-block')).toContainText('Write a launch brief and turn it into slides');
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(errors).toEqual([]);
});
