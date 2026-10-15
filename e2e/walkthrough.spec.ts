import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { expect, signIn, test } from './fixtures.js';

/**
 * The end-to-end walkthrough in docs/WALKTHROUGH.md, as a test: Claude, connected over MCP in
 * autonomous mode, completes a launch kit for a product (poster, brief, deck, teaser, exports)
 * as one agent run, while Seb approves the plan, reviews each stage in the browser, leaves a
 * comment on the poster, compares versions and approves the exports.
 *
 * OMNIX_WALKTHROUGH_DIR=docs/walkthrough saves the screenshots and a log of Claude's tool calls.
 */
const OUT = process.env.OMNIX_WALKTHROUGH_DIR ? path.resolve(process.env.OMNIX_WALKTHROUGH_DIR) : null;
const calls: { tool: string; args: Record<string, unknown>; result: string; error?: string }[] = [];

async function shot(page: Page, name: string, options: { keepPointer?: boolean } = {}): Promise<void> {
  if (!OUT) return;
  // Close notifications so they do not cover the picture, and wait for pictures to load.
  for (const close of await page.locator('.toast button[aria-label="Close"]').all()) await close.click({ timeout: 1000 }).catch(() => {});
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 8000 });
  if (!options.keepPointer) await page.mouse.move(2, 300);
  await expect.poll(() => page.evaluate(() => [...document.images].every((i) => i.complete))).toBe(true);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

const LAMP = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1100" viewBox="0 0 900 1100">
  <defs>
    <radialGradient id="glow" cx="50%" cy="38%" r="55%"><stop offset="0" stop-color="#fff4d6"/><stop offset="0.55" stop-color="#ffc861"/><stop offset="1" stop-color="#f08c00"/></radialGradient>
    <linearGradient id="stem" x1="0" x2="1"><stop offset="0" stop-color="#3a3f58"/><stop offset="0.5" stop-color="#6b7194"/><stop offset="1" stop-color="#3a3f58"/></linearGradient>
  </defs>
  <path d="M170 470 Q450 40 730 470 Z" fill="url(#glow)"/>
  <ellipse cx="450" cy="470" rx="282" ry="34" fill="#e8590c"/>
  <rect x="428" y="500" width="44" height="420" rx="18" fill="url(#stem)"/>
  <ellipse cx="450" cy="975" rx="230" ry="56" fill="#2b2f45"/>
  <ellipse cx="450" cy="958" rx="230" ry="50" fill="#4a5070"/>
</svg>`;

test('Claude completes a launch kit as one reviewed run', async ({ page, errors }) => {
  test.setTimeout(300_000);
  if (OUT) fs.mkdirSync(OUT, { recursive: true });

  // Seb: signs in, adds the product shot to the library, makes a project with AI allowed, and
  // connects Claude in autonomous mode (in real use: Settings → Claude, or the OAuth approval screen).
  await signIn(page);
  const api = page.request;
  const asset = (await (await api.post('/api/assets?name=aurora-lamp.svg', { data: Buffer.from(LAMP), headers: { 'content-type': 'image/svg+xml' } })).json()).asset;
  expect(asset.kind).toBe('image');
  const project = (await (await api.post('/api/projects', { data: { name: 'Aurora launch', primaryTool: 'image', aiConsent: true } })).json()).project;
  const { token } = await (await api.post('/api/auth/tokens', { data: { name: 'Claude', scopes: ['omnix:read', 'omnix:edit', 'omnix:autonomous'] } })).json();
  await page.goto(`/projects/${project.id}`);
  await page.waitForSelector('.viewport canvas.doc');

  const claude = new Client({ name: 'claude', version: '1' });
  await claude.connect(new StreamableHTTPClientTransport(new URL(`${new URL(page.url()).origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const call = async (tool: string, args: Record<string, unknown>) => {
    const t0 = Date.now();
    const r = await claude.callTool({ name: tool, arguments: args });
    if (process.env.OMNIX_WALKTHROUGH_TIMING) console.log(`${tool} ${Date.now() - t0}ms`);
    const text = ((r.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '').trim();
    calls.push({ tool, args, result: text.split('\n').slice(0, 6).join('\n').slice(0, 700), ...(r.isError ? { error: text } : {}) });
    if (r.isError) throw new Error(`${tool}: ${text}`);
    return (r.structuredContent ?? {}) as Record<string, any>;
  };
  const tryCall = async (tool: string, args: Record<string, unknown>) => {
    const r = await claude.callTool({ name: tool, arguments: args });
    const text = ((r.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '').trim();
    calls.push({ tool, args, result: text.slice(0, 700), ...(r.isError ? { error: text } : {}) });
    return { error: r.isError ? text : null, data: (r.structuredContent ?? {}) as Record<string, any> };
  };
  const runsPanel = async () => {
    const button = page.getByRole('button', { name: /^Claude runs/ });
    if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
    await expect(page.locator('.run-card')).toBeVisible();
  };
  const gate = (title: string | RegExp) => page.getByRole('group', { name: title });

  try {
    // ── Claude looks around ───────────────────────────────────────────────────
    const projects = await call('list_projects', {});
    expect(JSON.stringify(projects)).toContain('Aurora launch');
    const { outline } = await call('get_project', { projectId: project.id });
    const canvas = outline.documents.find((d: { tool: string }) => d.tool === 'image');
    const background = canvas.layers[0];
    const found = await call('list_assets', { query: 'lamp', kind: 'image' });
    expect(found.assets[0].id).toBe(asset.id);

    // ── The run, with Seb's usual approvals: the plan, each stage, exports and deletions ──
    const goal = 'Launch kit for the Aurora lamp: a square poster, a one-page brief, a short deck built from the brief and a six-second teaser, in one look, exported for the team.';
    const run = await call('agent_start_run', { projectId: project.id, goal, plan: ['Poster', 'Brief and deck', 'Teaser', 'Export'] });
    expect(run.status).toBe('awaiting_approval');
    const runId = run.runId as string;

    await runsPanel();
    await expect(gate('Approve the plan')).toBeVisible();
    await shot(page, '01-plan');
    let waiting = call('agent_wait', { runId, timeoutSeconds: 50 });
    await gate('Approve the plan').getByRole('button', { name: 'Approve' }).click();
    expect((await waiting).status).toBe('running');

    // ── Stage 1: the poster ───────────────────────────────────────────────────
    await call('update_node', { projectId: project.id, nodeId: canvas.id, set: { width: 1080, height: 1080, name: 'Poster' }, label: 'Square poster, 1080 × 1080' });
    await call('update_node', { projectId: project.id, nodeId: background.id, set: { fillColor: '#171a2e' }, label: 'Night-blue background' });
    await call('apply_preset', { projectId: project.id, preset: 'Film grain', nodeId: background.id });
    const glow = await call('image_add_layer', { projectId: project.id, canvasId: canvas.id, kind: 'shape', name: 'Glow', shapes: [{ id: 'g', kind: 'ellipse', x: 240, y: 60, width: 600, height: 600, fill: '#f59f00', stroke: null, strokeWidth: 0 }], opacity: 0.7, blendMode: 'screen' });
    await call('image_add_filter', { projectId: project.id, layerId: glow.layerId, filter: 'gaussianBlur', params: { radius: 130 } });
    await call('image_add_layer', { projectId: project.id, canvasId: canvas.id, kind: 'raster', name: 'Aurora lamp', assetId: asset.id, x: 330, y: 90, width: 420, height: 513 });
    const headline = await call('image_add_layer', { projectId: project.id, canvasId: canvas.id, kind: 'text', name: 'Headline', text: 'Light that follows the sun', x: 90, y: 690, boxWidth: 900, align: 'center', fontSize: 64, fontWeight: 800, color: '#ffffff' });
    await call('image_add_layer', { projectId: project.id, canvasId: canvas.id, kind: 'text', name: 'Date line', text: 'Aurora · in stores 14 March', x: 90, y: 900, boxWidth: 900, align: 'center', fontSize: 34, fontWeight: 600, color: '#ffc861' });
    const preview = await claude.callTool({ name: 'render_preview', arguments: { projectId: project.id, nodeId: canvas.id, maxSize: 512 } });
    const seen = (preview.content as { type: string; data?: string }[]).find((c) => c.type === 'image');
    expect(seen?.data).toBeTruthy();
    if (OUT) fs.writeFileSync(path.join(OUT, '02-what-claude-saw.png'), Buffer.from(seen!.data!, 'base64'));
    calls.push({ tool: 'render_preview', args: { projectId: project.id, nodeId: canvas.id, maxSize: 512 }, result: '(a 512 px picture of the poster, which Claude looks at before moving on)' });
    const cp1 = await call('agent_checkpoint', { runId, summary: 'Square 1080 × 1080: night-blue background with fine grain, a warm glow behind the lamp, the headline in white and the date line in the brand orange.' });
    expect(cp1.status).toBe('awaiting_approval');

    // Seb reviews the poster and pins a comment on the headline.
    await expect(gate('Stage finished')).toBeVisible();
    await shot(page, '02-poster-review');
    await page.keyboard.press('Control+Alt+m');
    const box = (await page.locator('.viewport canvas.doc').boundingBox())!;
    await page.mouse.click(box.x + box.width * (540 / 1080), box.y + box.height * (725 / 1080));
    await page.getByRole('textbox', { name: 'Comment' }).fill('Make the headline bigger: it has to read from across the shop.');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Comment 1 by Seb/ })).toBeVisible();
    await page.getByRole('button', { name: /^Comment 1 by Seb/ }).hover();
    await shot(page, '03-comment', { keepPointer: true });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    waiting = call('agent_wait', { runId, timeoutSeconds: 50 });
    await gate('Stage finished').getByRole('button', { name: 'Ask for changes' }).click();
    await page.getByLabel('What should change? Claude reads this.').fill('See my comment on the headline.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const answer = await waiting;
    expect(answer.decision).toMatchObject({ decision: 'changes', feedback: 'See my comment on the headline.' });

    // Claude reads the comment, finds the layer under the pin, fixes it and closes the comment.
    const open = await call('list_comments', { projectId: project.id, status: 'open' });
    const comment = open.comments[0];
    expect(comment).toMatchObject({ documentId: canvas.id, layerId: headline.layerId, where: expect.stringContaining('over the layer "Headline"') });
    await call('update_node', { projectId: project.id, nodeId: headline.layerId, set: { fontSize: 96, y: 650 }, label: 'Headline 50% larger' });
    await call('resolve_comment', { projectId: project.id, commentId: comment.id, reply: 'Done: the headline is 96 px now, half as big again, and moved up to keep the spacing.' });
    const versions = await call('get_history', { projectId: project.id, limit: 5 });
    const posterVersion = versions.versions.find((v: { name: string }) => v.name === 'Claude: Poster');
    const diff = await call('compare_versions', { projectId: project.id, from: posterVersion.id, documentId: canvas.id });
    expect(JSON.stringify(diff)).toMatch(/Headline/);
    await call('agent_checkpoint', { runId, summary: 'Revised after your comment: the headline is 96 px (was 64) and sits higher. Comment resolved.' });

    // Seb compares the reviewed version with the revision, then approves.
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.getByRole('button', { name: /Claude: Poster$/ }).last().click();
    await expect(page.getByRole('dialog', { name: 'Compare versions' })).toBeVisible();
    const compared = page.getByRole('dialog', { name: 'Compare versions' }).getByRole('img', { name: 'Current version' });
    await expect(compared).toBeVisible();
    await expect.poll(() => compared.evaluate((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0), { timeout: 30_000 }).toBe(true);
    await shot(page, '04-compare');
    await page.keyboard.press('Escape');
    await runsPanel();
    waiting = call('agent_wait', { runId, timeoutSeconds: 50 });
    await gate('Stage finished').getByRole('button', { name: 'Approve' }).click();
    expect((await waiting).status).toBe('running');

    // ── Stage 2: the brief, and a deck made from it ───────────────────────────
    const brief = await call('add_document', { projectId: project.id, tool: 'document', name: 'Launch brief' });
    await call('doc_insert_markdown', {
      projectId: project.id,
      documentId: brief.documentId,
      markdown: [
        'Aurora is a desk lamp that follows the color of daylight: cool and bright at noon, warm and low at dusk. It goes on sale on **14 March**.',
        '## Who it is for',
        '- People who work from home and feel the afternoon slump',
        '- Readers who want warm light at night without a dim room',
        '## What we say',
        '- Light that follows the sun',
        '- One touch, no app',
        '- A full day of color on one charge',
        '## Launch plan',
        '- **1 March**: teaser on social',
        '- **7 March**: press preview',
        '- **14 March**: in stores and online',
      ].join('\n\n'),
    });
    await call('apply_preset', { projectId: project.id, preset: 'Modern sans', nodeId: brief.documentId });
    const deck = await call('slides_from_document', { projectId: project.id, documentId: brief.documentId });
    await call('slides_set_theme', { projectId: project.id, deckId: deck.deckId, colors: { background: '#171a2e', surface: '#22263f', text: '#ffffff', muted: '#b7bad0', accent: '#ffc861', accent2: '#f59f00' }, fonts: { heading: 'Space Grotesk', body: 'Inter' } });
    const last = await call('slides_add_slide', { projectId: project.id, deckId: deck.deckId, layout: 'title', title: 'Light that follows the sun', subtitle: 'In stores 14 March', notes: 'Close on the poster.' });
    await call('slides_add_element', { projectId: project.id, slideId: last.slideId, elementType: 'embed', x: 1180, y: 300, w: 560, h: 560, embed: { kind: 'canvas', ref: canvas.id } });
    await call('agent_checkpoint', { runId, summary: `The brief has an introduction and three short sections in Modern sans. The deck turns it into ${deck.slides} slides in the poster's colors, with a closing slide that shows the poster itself as a live link, so poster edits show up.` });

    await page.getByRole('tab', { name: 'Launch brief', exact: true }).click();
    await expect(page.locator('.doc-page')).toBeVisible();
    await shot(page, '05-brief');
    await page.getByRole('tab', { name: 'Launch brief (slides)' }).click();
    await page.waitForSelector('.slide-canvas');
    await page.locator('.sorter-item').last().click();
    await runsPanel();
    await shot(page, '06-deck');
    waiting = call('agent_wait', { runId, timeoutSeconds: 50 });
    await gate('Stage finished').getByRole('button', { name: 'Approve' }).click();
    expect((await waiting).status).toBe('running');

    // ── Stage 3: the teaser ───────────────────────────────────────────────────
    const teaser = await call('add_document', { projectId: project.id, tool: 'video', name: 'Teaser' });
    const clip = await call('video_add_clip', { projectId: project.id, sequenceId: teaser.documentId, assetId: asset.id, start: 0, out: 6, name: 'Aurora lamp' });
    await call('apply_preset', { projectId: project.id, preset: 'Warm film', nodeId: clip.clipId });
    await call('video_add_title', { projectId: project.id, sequenceId: teaser.documentId, text: 'Light that follows the sun', start: 0.5, duration: 2.5, fontSize: 84, color: '#ffffff' });
    await call('video_add_title', { projectId: project.id, sequenceId: teaser.documentId, text: 'Aurora · 14 March', start: 3.2, duration: 2.8, fontSize: 72, color: '#ffc861' });
    await call('render_preview', { projectId: project.id, nodeId: teaser.documentId, time: 1.5, maxSize: 512 });
    await call('agent_checkpoint', { runId, summary: 'Six seconds: the lamp in the Warm film look with two titles, the headline and then the date.' });
    await page.getByRole('tab', { name: 'Teaser' }).click();
    await page.waitForSelector('.tl-clip');
    await runsPanel();
    await shot(page, '07-teaser');
    waiting = call('agent_wait', { runId, timeoutSeconds: 50 });
    await gate('Stage finished').getByRole('button', { name: 'Approve' }).click();
    expect((await waiting).status).toBe('running');

    // ── Stage 4: exports, each one approved ───────────────────────────────────
    const pdfs = { operation: 'document.export', params: { format: 'pdf' }, targets: [{ projectId: project.id, documentId: brief.documentId }, { projectId: project.id, documentId: deck.deckId }] };
    const held = await tryCall('run_batch', pdfs);
    expect(held.error).toMatch(/Before exporting \(run_batch\)/);
    await expect(gate('Before exporting (run_batch)')).toBeVisible();
    await shot(page, '08-export-gate');
    waiting = call('agent_wait', { runId, timeoutSeconds: 50 });
    await gate('Before exporting (run_batch)').getByRole('button', { name: 'Approve' }).click();
    await waiting;
    const batch = await call('run_batch', pdfs);
    let job: Record<string, any> = {};
    for (let i = 0; i < 60; i++) {
      job = await call('get_job', { jobId: batch.jobId });
      if (['done', 'failed'].includes(job.status)) break;
      await page.waitForTimeout(500);
    }
    expect(job.status).toBe('done');
    const png = { projectId: project.id, nodeId: canvas.id, format: 'png' };
    expect((await tryCall('export_file', png)).error).toMatch(/Before exporting \(export_file\)/);
    waiting = call('agent_wait', { runId, timeoutSeconds: 50 });
    await gate('Before exporting (export_file)').getByRole('button', { name: 'Approve' }).click();
    await waiting;
    const file = await call('export_file', png);
    expect(file.url).toMatch(/\/api\/files\//);

    const done = await call('agent_finish', {
      runId,
      summary: `Launch kit ready: a square poster (PNG), the brief and a ${deck.slides + 1}-slide deck (PDFs), and a six-second teaser to review with music. The headline is bigger after your comment. Every stage is a saved version you can go back to.`,
    });
    expect(done.status).toBe('done');

    // Seb's view at the end: the finished run, and the versions Claude saved at each stage.
    await page.getByRole('tab', { name: 'Poster' }).click();
    await page.waitForSelector('.viewport canvas.doc');
    await runsPanel();
    await expect(page.locator('.run-card').first()).toContainText('Launch kit ready');
    await shot(page, '09-done');
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.getByText('Claude: Teaser')).toBeVisible();
    await shot(page, '10-history');
    expect(errors).toEqual([]);
  } finally {
    await claude.close();
    // Download links are signed for a day; the log keeps them recognisable without the signature.
    if (OUT) fs.writeFileSync(path.join(OUT, 'calls.json'), JSON.stringify(calls, null, 2).replace(/([?&]sig=)[\w-]+/g, '$1…'));
  }
});
