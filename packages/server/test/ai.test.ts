import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { childrenOf, clipsOf, deckSlides, documentBlocks, layerProps, makeNode, newSlideOps, nodesOfType, notesContainer, primaryDocumentNodes, slideElements, tracksOf, type Operation, type ProjectState, type SceneNode } from '@omnix/core';
import { splitClauses } from '../src/ai/nl/parser.js';
import { colorFrom, toneFrom, positionFrom } from '../src/ai/nl/vocab.js';
import { startTestServer, json, type TestServer } from './helpers.js';

let ts: TestServer;
let auto: Client;
const TINY_MP4 = fileURLToPath(new URL('../../exporters/test/fixtures/tiny.mp4', import.meta.url));

const state = async (projectId: string) => (await json(await ts.api(`/api/projects/${projectId}`))).state as ProjectState;
const commit = async (projectId: string, op: Operation, label = 'Setup') => {
  const r = await ts.api(`/api/projects/${projectId}/commits`, { method: 'POST', json: { op, label } });
  if (r.status !== 201) throw new Error(`commit failed: ${await r.text()}`);
};
async function project(primaryTool: string, aiConsent = true): Promise<{ id: string; doc: string }> {
  const p = (await json(await ts.api('/api/projects', { method: 'POST', json: { name: `${primaryTool} test`, primaryTool, aiConsent } }))).project;
  const s = await state(p.id);
  const doc = childrenOf(s, s.rootId).find((n) => ['canvas', 'sequence', 'deck', 'document', 'codeWorkspace'].includes(n.type))!.id;
  return { id: p.id, doc };
}
async function upload(name: string, data: Buffer, projectId: string, type: string) {
  return (await json(await ts.api(`/api/assets?name=${encodeURIComponent(name)}&projectId=${projectId}`, { method: 'POST', body: new Uint8Array(data), headers: { 'content-type': type } }))).asset as { id: string; duration?: number };
}
async function command(projectId: string, text: string, extra: Record<string, unknown> = {}) {
  const r = await ts.api(`/api/projects/${projectId}/commands`, { method: 'POST', json: { text, ...extra } });
  const body = await json(r);
  if (r.status !== 200) throw new Error(`command failed: ${JSON.stringify(body)}`);
  return body;
}
async function accept(projectId: string, proposalId: string, ops?: Operation[]) {
  const r = await ts.api(`/api/projects/${projectId}/proposals/${proposalId}/accept`, { method: 'POST', json: ops ? { ops } : {} });
  if (r.status !== 200) throw new Error(`accept failed: ${await r.text()}`);
}
async function waitJob(id: string, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const j = (await json(await ts.api(`/api/jobs/${id}`))).job;
    if (['done', 'failed', 'cancelled'].includes(j.status)) return j;
    if (Date.now() > end) throw new Error(`job ${id} still ${j.status}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** A landscape: blue sky gradient on top, green ground below, a white "Title" text layer. */
async function landscape(projectId: string, canvasId: string): Promise<{ photo: string; title: string }> {
  const W = 400;
  const H = 300;
  const px = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (y < 140) {
        px[i] = 90 + Math.round(y * 0.4);
        px[i + 1] = 150 + Math.round(y * 0.3);
        px[i + 2] = 235;
      } else {
        px[i] = 50 + ((x * 7 + y * 13) % 23);
        px[i + 1] = 120 + ((x * 3 + y * 5) % 31);
        px[i + 2] = 40;
      }
      px[i + 3] = 255;
    }
  const png = await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const asset = await upload('landscape.png', png, projectId, 'image/png');
  const photo = makeNode('layer', layerProps('raster', { name: 'Photo', assetId: asset.id, width: W, height: H }));
  const title = makeNode('layer', layerProps('text', { name: 'Title', text: 'Summer', fontSize: 40, color: '#ffffff', x: 40, y: 20 }));
  await commit(projectId, { kind: 'batch', ops: [{ kind: 'update', id: canvasId, set: { width: W, height: H } }, { kind: 'create', parentId: canvasId, nodes: [photo] }, { kind: 'create', parentId: canvasId, nodes: [title] }] });
  return { photo: photo.id, title: title.id };
}

beforeAll(async () => {
  ts = await startTestServer();
  const { token } = await json(await ts.api('/api/auth/tokens', { method: 'POST', json: { name: 'Claude', scopes: ['omnix:read', 'omnix:edit', 'omnix:autonomous'] } }));
  auto = new Client({ name: 'claude', version: '1' });
  await auto.connect(new StreamableHTTPClientTransport(new URL(`${ts.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
});

afterAll(async () => {
  await auto?.close().catch(() => {});
  await ts?.close();
});

describe('command vocabulary', () => {
  it('splits clauses on verbs, keeps quoted text and color names intact', () => {
    expect(splitClauses('Make the sky warmer and move the title to the lower third')).toEqual(['Make the sky warmer', 'move the title to the lower third']);
    expect(splitClauses('Add a title "Salt and pepper", then make it black and white.')).toEqual(['Add a title "Salt and pepper"', 'make it black and white']);
    expect(splitClauses('blur the photo; hide the logo')).toEqual(['blur the photo', 'hide the logo']);
    expect(toneFrom('a bit warmer')).toEqual({ tone: 'warmer', strength: 0.5 });
    expect(toneFrom('black and white')!.tone).toBe('grayscale');
    expect(positionFrom('the lower third of the frame')).toBe('lower-third');
    expect(colorFrom('navy')).toBe('#1b2a4a');
    expect(colorFrom('#f00')).toBe('#ff0000');
    expect(colorFrom('table')).toBeNull();
  });
});

describe('natural-language commands', () => {
  it('turns an image command into one reviewable proposal with a step per phrase', async () => {
    const p = await project('image');
    const { title, photo } = await landscape(p.id, p.doc);
    const r = await command(p.id, 'Make the sky warmer and move the title to the lower third', { documentId: p.doc });
    expect(r.status).toBe('proposed');
    expect(r.steps).toEqual(['Warmer: the sky', 'Move the title to the lower third']);
    // Nothing changes until the person accepts.
    let s = await state(p.id);
    expect((s.nodes[title] as SceneNode<'layer'>).props.y).toBe(20);
    const preview = await json(await ts.api(`/api/projects/${p.id}/proposals/${r.proposalId}/preview`));
    expect(preview.diff.added.length).toBe(1);
    await accept(p.id, r.proposalId);
    s = await state(p.id);
    const layers = childrenOf(s, p.doc) as SceneNode<'layer'>[];
    const warm = layers.find((l) => l.props.layerType === 'adjustment')!;
    expect(warm.props.adjustment).toEqual({ kind: 'temperature', amount: 25 });
    // The sky is a mask over the top of the image only.
    expect(warm.props.mask?.source.kind).toBe('mask');
    const maskId = (warm.props.mask!.source as { assetId: string }).assetId;
    const mask = await sharp(Buffer.from(await (await ts.api(`/api/assets/${maskId}/file`)).arrayBuffer())).greyscale().raw().toBuffer({ resolveWithObject: true });
    expect(mask.data[10 * 400 + 200]).toBeGreaterThan(200);
    expect(mask.data[250 * 400 + 200]).toBeLessThan(40);
    const t = s.nodes[title] as SceneNode<'layer'>;
    expect(t.props.y).toBeGreaterThan(200);
    expect(t.props.y).toBeLessThan(260);
    expect(s.nodes[photo]).toBeTruthy();
    // The command was remembered in session memory.
    const notes = childrenOf(s, notesContainer(s).id) as SceneNode<'note'>[];
    expect(notes.some((n) => n.props.kind === 'prompt' && n.props.text.includes('Make the sky warmer') && n.props.auto)).toBe(true);
  });

  it('lets the person keep only some steps', async () => {
    const p = await project('image');
    const { title } = await landscape(p.id, p.doc);
    const r = await command(p.id, 'make the title red, then make everything a little cooler', { documentId: p.doc });
    expect(r.steps).toHaveLength(2);
    const proposal = (await json(await ts.api(`/api/projects/${p.id}/proposals?status=open`))).proposals.find((x: { id: string }) => x.id === r.proposalId);
    expect(proposal.steps).toEqual(r.steps);
    expect(proposal.ops).toHaveLength(2);
    await accept(p.id, r.proposalId, [proposal.ops[0]]);
    const s = await state(p.id);
    expect((s.nodes[title] as SceneNode<'layer'>).props.color).toBe('#e03131');
    expect((childrenOf(s, p.doc) as SceneNode<'layer'>[]).some((l) => l.props.layerType === 'adjustment')).toBe(false);
  });

  it('removes a background, recolors it, and reports what it did not understand', async () => {
    const p = await project('image');
    const W = 200;
    const H = 160;
    const png = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 230, g: 230, b: 228, alpha: 1 } } })
      .composite([{ input: await sharp({ create: { width: 70, height: 90, channels: 4, background: { r: 180, g: 40, b: 30, alpha: 1 } } }).png().toBuffer(), left: 65, top: 40 }])
      .png()
      .toBuffer();
    const a = await upload('product.png', png, p.id, 'image/png');
    const photo = makeNode('layer', layerProps('raster', { name: 'Product', assetId: a.id, width: W, height: H }));
    await commit(p.id, { kind: 'batch', ops: [{ kind: 'update', id: p.doc, set: { width: W, height: H } }, { kind: 'create', parentId: p.doc, nodes: [photo] }] });
    const r = await command(p.id, 'Remove the background and frobnicate the widget', { documentId: p.doc, allowClaude: false });
    expect(r.status).toBe('proposed');
    expect(r.steps).toEqual(['Remove the background from "Product"']);
    expect(r.unmatched).toHaveLength(1);
    expect(r.unmatched[0].clause).toBe('frobnicate the widget');
    await accept(p.id, r.proposalId);
    expect(((await state(p.id)).nodes[photo.id] as SceneNode<'layer'>).props.mask?.source.kind).toBe('mask');
    const r2 = await command(p.id, 'make the background navy', { documentId: p.doc });
    await accept(p.id, r2.proposalId);
    const s = await state(p.id);
    const fill = (childrenOf(s, p.doc) as SceneNode<'layer'>[]).find((l) => l.props.name === 'New background')!;
    expect(fill.props.fillColor).toBe('#1b2a4a');
    expect(fill.props.mask).toBeTruthy();
    const none = await command(p.id, 'frobnicate the widget', { documentId: p.doc });
    expect(none.status).toBe('not-understood');
    expect(none.examples.length).toBeGreaterThan(2);
  });

  it('edits a video timeline', async () => {
    const p = await project('video');
    const s0 = await state(p.id);
    const tracks = tracksOf(s0, p.doc);
    const v1 = tracks.find((t) => t.props.trackType === 'video')!;
    const a1 = tracks.find((t) => t.props.trackType === 'audio')!;
    const clips = [0, 1, 2].map((i) => makeNode('clip', { name: `Shot ${i + 1}`, assetId: `asset${i}`, start: i * 4, in: 0, out: 4, sourceDuration: 10 }));
    const music = makeNode('clip', { name: 'Music', assetId: 'song', start: 0, in: 0, out: 12, sourceDuration: 60 });
    await commit(p.id, { kind: 'batch', ops: [...clips.map((c) => ({ kind: 'create', parentId: v1.id, nodes: [c] }) as Operation), { kind: 'create', parentId: a1.id, nodes: [music] }, { kind: 'update', id: p.doc, set: { duration: 12 } }] });
    const r = await command(p.id, 'Make clip 2 warmer, add a title "Coming soon" and move it to the lower third. Add crossfades between all clips and turn the music down', { documentId: p.doc, time: 1 });
    expect(r.status).toBe('proposed');
    expect(r.unmatched).toEqual([]);
    expect(r.steps).toHaveLength(5);
    await accept(p.id, r.proposalId);
    const s = await state(p.id);
    const c2 = s.nodes[clips[1]!.id] as SceneNode<'clip'>;
    expect(c2.props.effects[0]).toMatchObject({ effect: 'colorGrade', params: expect.objectContaining({ temperature: 25 }) });
    expect(c2.props.transitionIn?.kind).toBe('crossfade');
    expect((s.nodes[clips[2]!.id] as SceneNode<'clip'>).props.transitionIn?.kind).toBe('crossfade');
    const titleClip = tracksOf(s, p.doc).flatMap((t) => clipsOf(s, t.id)).find((c) => c.props.title?.text === 'Coming soon')!;
    expect(titleClip.props.start).toBe(1);
    expect(titleClip.props.y).toBeGreaterThan(200);
    expect((s.nodes[music.id] as SceneNode<'clip'>).props.volume).toBe(-6);
  });

  it('edits slides and documents', async () => {
    const p = await project('slides');
    const r = await command(p.id, 'Use the Midnight theme and add a slide titled "Q3 results". Make the title on slide 1 gold and add fade transitions to all slides', { documentId: p.doc });
    expect(r.unmatched).toEqual([]);
    await accept(p.id, r.proposalId);
    let s = await state(p.id);
    const deck = s.nodes[p.doc] as SceneNode<'deck'>;
    expect(deck.props.theme.name).toBe('Midnight');
    const slides = deckSlides(s, p.doc);
    expect(slides).toHaveLength(2);
    expect(slideElements(s, slides[1]!.id).find((e) => e.props.role === 'title')!.props.text).toBe('Q3 results');
    expect(slideElements(s, slides[0]!.id).find((e) => e.props.role === 'title')!.props.color).toBe('#d4a017');
    expect(slides.every((x) => x.props.transition.kind === 'fade')).toBe(true);

    const d = await project('document');
    const blocks = [makeNode('block', { blockType: 'heading', level: 1, text: 'Plan' }), makeNode('block', { blockType: 'paragraph', text: 'First idea.' }), makeNode('block', { blockType: 'paragraph', text: 'A quote worth keeping.' })];
    await commit(d.id, { kind: 'batch', ops: blocks.map((b) => ({ kind: 'create', parentId: d.doc, nodes: [b] }) as Operation) });
    const r2 = await command(d.id, 'make the headings blue, turn the second paragraph into a quote and add a heading "Next steps"', { documentId: d.doc });
    expect(r2.unmatched).toEqual([]);
    await accept(d.id, r2.proposalId);
    s = await state(d.id);
    const doc = s.nodes[d.doc] as SceneNode<'document'>;
    expect(doc.props.styles.h1!.color).toBe('#1c7ed6');
    const after = documentBlocks(s, d.doc);
    expect(after.find((b) => b.id === blocks[2]!.id)!.props.blockType).toBe('quote');
    expect(after.at(-1)!.props).toMatchObject({ blockType: 'heading', text: 'Next steps' });
  });

  it('runs commands for Claude through MCP in its permission mode', async () => {
    const p = await project('image');
    const { title } = await landscape(p.id, p.doc);
    const r = await auto.callTool({ name: 'run_command', arguments: { projectId: p.id, documentId: p.doc, text: 'center the title and make it bold' } });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { status: string }).status).toBe('committed');
    const t = (await state(p.id)).nodes[title] as SceneNode<'layer'>;
    expect(t.props.fontWeight).toBe(700);
    expect(Math.abs(t.props.y - 130)).toBeLessThan(15);
  });
});

describe('generative fill and extend', () => {
  it('fills a selection from its surroundings, keeping the generated area visible as a mask', async () => {
    const p = await project('image', false);
    const W = 160;
    const H = 120;
    const png = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 40, g: 120, b: 200, alpha: 1 } } })
      .composite([{ input: await sharp({ create: { width: 30, height: 30, channels: 4, background: { r: 250, g: 250, b: 30, alpha: 1 } } }).png().toBuffer(), left: 60, top: 40 }])
      .png()
      .toBuffer();
    const a = await upload('sky.png', png, p.id, 'image/png');
    const photo = makeNode('layer', layerProps('raster', { name: 'Sky', assetId: a.id, width: W, height: H }));
    await commit(p.id, { kind: 'batch', ops: [{ kind: 'update', id: p.doc, set: { width: W, height: H } }, { kind: 'create', parentId: p.doc, nodes: [photo] }] });
    // The built-in provider needs no AI consent: nothing leaves the server.
    const r = await ts.api(`/api/projects/${p.id}/generative/fill`, { method: 'POST', json: { canvasId: p.doc, prompt: '', selection: { kind: 'rect', x: 55, y: 35, width: 40, height: 40 } } });
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(body.provider).toBe('builtin');
    const s = await state(p.id);
    const layer = s.nodes[body.layerId] as SceneNode<'layer'>;
    expect(layer.props.generation).toMatchObject({ kind: 'fill', provider: 'builtin' });
    expect(layer.props.mask?.source.kind).toBe('mask');
    const render = await sharp(Buffer.from(await (await ts.api(`/api/projects/${p.id}/render?nodeId=${p.doc}&format=png`)).arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
    const i = (55 * W + 75) * 4;
    expect(render.data[i + 2]).toBeGreaterThan(150); // blue again where the yellow square was
    expect(render.data[i]).toBeLessThan(120);
  });

  it('extends the canvas and uses an external image model when one is configured (with AI consent)', async () => {
    const calls: { prompt: string; size: string }[] = [];
    const fake = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('latin1');
      const field = (name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(raw)?.[1] ?? '';
      calls.push({ prompt: field('prompt'), size: field('size') });
      const out = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: out.toString('base64') }] }));
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    ts.omnix.config.imageGen = { url: `http://127.0.0.1:${(fake.address() as { port: number }).port}/v1`, apiKey: 'test', model: 'test-image-model' };
    try {
      const p = await project('image', false);
      const png = await sharp({ create: { width: 100, height: 80, channels: 4, background: { r: 20, g: 160, b: 60, alpha: 1 } } }).png().toBuffer();
      const a = await upload('field.png', png, p.id, 'image/png');
      const photo = makeNode('layer', layerProps('raster', { name: 'Field', assetId: a.id, width: 100, height: 80 }));
      await commit(p.id, { kind: 'batch', ops: [{ kind: 'update', id: p.doc, set: { width: 100, height: 80 } }, { kind: 'create', parentId: p.doc, nodes: [photo] }] });
      // An outside model needs the project's AI consent.
      const refused = await ts.api(`/api/projects/${p.id}/generative/extend`, { method: 'POST', json: { canvasId: p.doc, left: 20, right: 20, prompt: 'more meadow' } });
      expect(refused.status).toBe(403);
      await ts.api(`/api/projects/${p.id}`, { method: 'PATCH', json: { aiConsent: true } });
      const r = await json(await ts.api(`/api/projects/${p.id}/generative/extend`, { method: 'POST', json: { canvasId: p.doc, left: 20, right: 20, prompt: 'more meadow' } }));
      expect(r.width).toBe(140);
      expect(calls[0]).toEqual({ prompt: 'more meadow', size: '1024x1024' });
      const s = await state(p.id);
      const layers = childrenOf(s, p.doc) as SceneNode<'layer'>[];
      expect(layers[1]!.id).toBe(r.layerId);
      expect(layers[1]!.props.generation).toMatchObject({ kind: 'extend', provider: 'http', prompt: 'more meadow' });
      expect((s.nodes[photo.id] as SceneNode<'layer'>).props.x).toBe(20);
      // The built-in provider is still there to choose.
      const caps = await json(await ts.api('/api/ai/capabilities'));
      expect(caps.imageProviders.map((x: { id: string }) => x.id)).toEqual(['http', 'builtin']);
    } finally {
      ts.omnix.config.imageGen = null;
      fake.close();
    }
  });

  it('fills a region across a video clip as a background job', async () => {
    if (!fs.existsSync(TINY_MP4)) return;
    const p = await project('video', false);
    const a = await upload('tiny.mp4', fs.readFileSync(TINY_MP4), p.id, 'video/mp4');
    // Wait for the asset to be probed (dimensions are needed to map the region).
    let meta = (await json(await ts.api(`/api/assets/${a.id}`))).asset;
    for (let i = 0; i < 100 && !meta.width; i++) {
      await new Promise((r) => setTimeout(r, 100));
      meta = (await json(await ts.api(`/api/assets/${a.id}`))).asset;
    }
    const s0 = await state(p.id);
    const v1 = tracksOf(s0, p.doc).find((t) => t.props.trackType === 'video')!;
    const clip = makeNode('clip', { name: 'Tiny', assetId: a.id, start: 0, in: 0, out: Math.min(1, meta.duration), sourceDuration: meta.duration });
    await commit(p.id, { kind: 'create', parentId: v1.id, nodes: [clip] });
    const seq = s0.nodes[p.doc] as SceneNode<'sequence'>;
    const r = await json(await ts.api(`/api/projects/${p.id}/generative/video-fill`, { method: 'POST', json: { clipId: clip.id, region: { x: seq.props.width / 2 - 100, y: seq.props.height / 2 - 60, width: 200, height: 120 }, prompt: '' } }));
    const job = await waitJob(r.jobId, 120_000);
    expect(job.status, job.error ?? '').toBe('done');
    const s = await state(p.id);
    const c = s.nodes[clip.id] as SceneNode<'clip'>;
    expect(c.props.assetId).not.toBe(a.id);
    expect(c.props.generation).toMatchObject({ kind: 'fill', sourceAssetId: a.id });
    expect(c.props.generation!.region!.width).toBeGreaterThan(0);
  });
});

describe('style reference', () => {
  it('applies a reference image look to an image, a slideshow and a document', async () => {
    const p = await project('image');
    await landscape(p.id, p.doc);
    const warm = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 220, g: 140, b: 60, alpha: 1 } } })
      .composite([{ input: await sharp({ create: { width: 20, height: 64, channels: 4, background: { r: 120, g: 40, b: 20, alpha: 1 } } }).png().toBuffer(), left: 0, top: 0 }])
      .png()
      .toBuffer();
    const ref = await upload('sunset.png', warm, p.id, 'image/png');
    const r = await json(await ts.api(`/api/projects/${p.id}/style-match`, { method: 'POST', json: { targetId: p.doc, reference: { assetId: ref.id }, aspects: ['color', 'tone'], strength: 0.9 } }));
    expect(r.applied[0]).toMatch(/color and tone/);
    let s = await state(p.id);
    const look = (childrenOf(s, p.doc) as SceneNode<'layer'>[]).find((l) => l.props.adjustment?.kind === 'lut')!;
    expect(look.props.adjustment).toMatchObject({ kind: 'lut', intensity: 0.9 });
    const lutAsset = (await json(await ts.api(`/api/assets/${(look.props.adjustment as { assetId: string }).assetId}`))).asset;
    expect(lutAsset.kind).toBe('lut');

    // Slides: the reference palette becomes the theme; a deck reference passes on fonts and motion.
    const deckNodes = primaryDocumentNodes('slides', 'Pitch');
    deckNodes[0]!.parentId = s.rootId;
    await commit(p.id, { kind: 'create', parentId: s.rootId, nodes: deckNodes });
    const r2 = await json(await ts.api(`/api/projects/${p.id}/style-match`, { method: 'POST', json: { targetId: deckNodes[0]!.id, reference: { assetId: ref.id }, aspects: ['color'] } }));
    expect(r2.applied[0]).toMatch(/palette/);
    s = await state(p.id);
    const theme = (s.nodes[deckNodes[0]!.id] as SceneNode<'deck'>).props.theme;
    expect(theme.colors.background).not.toBe('#ffffff');

    const docNodes = primaryDocumentNodes('document', 'Brief');
    docNodes[0]!.parentId = s.rootId;
    await commit(p.id, { kind: 'create', parentId: s.rootId, nodes: docNodes });
    const r3 = await json(await ts.api(`/api/projects/${p.id}/style-match`, { method: 'POST', json: { targetId: docNodes[0]!.id, reference: { nodeId: deckNodes[0]!.id }, aspects: ['typography', 'color'] } }));
    expect(r3.applied[0]).toMatch(/typography/);
    s = await state(p.id);
    expect((s.nodes[docNodes[0]!.id] as SceneNode<'document'>).props.styles.h1!.color).toBe(theme.colors.accent);
  });

  it('carries the motion feel of one animation to another', async () => {
    const p = await project('animation');
    let s = await state(p.id);
    const track = tracksOf(s, p.doc)[0]!;
    const mk = (name: string, easing: string) => makeNode('animLayer', { name, start: 0, duration: 2, keyframes: { x: [{ time: 0, value: 0, easing }, { time: 1, value: 100, easing }] } as never });
    const a = mk('Bouncy', 'bounce-out');
    const second = makeNode('sequence', { name: 'Second', purpose: 'animation', width: 640, height: 360, fps: 24, duration: 2 });
    const t2 = makeNode('track', { name: 'Layers', trackType: 'animation' });
    const b = mk('Stiff', 'linear');
    await commit(p.id, { kind: 'batch', ops: [{ kind: 'create', parentId: track.id, nodes: [a] }, { kind: 'create', parentId: s.rootId, nodes: [{ ...second, parentId: s.rootId, children: [t2.id] }, { ...t2, parentId: second.id, children: [b.id] }, { ...b, parentId: t2.id }] }] });
    const r = await auto.callTool({ name: 'style_match', arguments: { projectId: p.id, targetId: second.id, reference: { nodeId: p.doc }, aspects: ['motion'] } });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    s = await state(p.id);
    expect((s.nodes[b.id] as SceneNode<'animLayer'>).props.keyframes.x![0]!.easing).toBe('bounce-out');
  });
});

describe('cross-tool context and session memory', () => {
  it('searches every tool, turns a document into slides, and remembers rejected proposals', async () => {
    const p = await project('document');
    const blocks = [
      makeNode('block', { blockType: 'heading', level: 1, text: 'Why now' }),
      makeNode('block', { blockType: 'paragraph', text: 'The launch date is 14 March. Everything else follows from it.' }),
      makeNode('block', { blockType: 'heading', level: 1, text: 'What we ship' }),
      makeNode('block', { blockType: 'bullet', text: 'The **studio**' }),
      makeNode('block', { blockType: 'bullet', text: 'The connector' }),
    ];
    await commit(p.id, { kind: 'batch', ops: blocks.map((b) => ({ kind: 'create', parentId: p.doc, nodes: [b] }) as Operation) });
    const found = await auto.callTool({ name: 'find_in_project', arguments: { projectId: p.id, query: 'launch date' } });
    const hits = (found.structuredContent as { hits: { nodeId: string; tool: string }[] }).hits;
    expect(hits[0]).toMatchObject({ nodeId: blocks[1]!.id, tool: 'document' });
    const r = await json(await ts.api(`/api/projects/${p.id}/slides-from-document`, { method: 'POST', json: { documentId: p.doc } }));
    expect(r.slides).toBe(2);
    const s = await state(p.id);
    const slides = deckSlides(s, r.deckId);
    expect(slides).toHaveLength(3);
    const body = slideElements(s, slides[2]!.id).find((e) => e.props.role === 'body')!;
    expect(body.props.text).toBe('- The studio\n- The connector');
    expect(slideElements(s, slides[1]!.id).find((e) => e.props.role === 'body')!.props.text).toBe('- The launch date is 14 March. Everything else follows from it.');

    // A rejected AI proposal is remembered with its reason.
    const { token } = await json(await ts.api('/api/auth/tokens', { method: 'POST', json: { name: 'Claude review', scopes: ['omnix:read', 'omnix:edit'] } }));
    const approve = new Client({ name: 'claude-review', version: '1' });
    await approve.connect(new StreamableHTTPClientTransport(new URL(`${ts.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const prop = await approve.callTool({ name: 'update_node', arguments: { projectId: p.id, nodeId: blocks[0]!.id, set: { text: 'Why NOW!!!' } } });
    const pid = (prop.structuredContent as { proposalId: string }).proposalId;
    await ts.api(`/api/projects/${p.id}/proposals/${pid}/reject`, { method: 'POST', json: { reason: 'Too shouty' } });
    await approve.close();
    const notes = childrenOf(await state(p.id), notesContainer(await state(p.id)).id) as SceneNode<'note'>[];
    const rejected = notes.find((n) => n.props.kind === 'rejected')!;
    expect(rejected.props.text).toMatch(/Too shouty/);
    expect(rejected.props.ref?.proposalId).toBe(pid);
    // Session memory is bookkeeping: it never lands on the person's undo stack.
    const undo = await json(await ts.api(`/api/projects/${p.id}/undo`, { method: 'POST' }));
    expect(undo.commit.label).toMatch(/Slides from/);
  });

  it('marks what the AI changed for the editors', async () => {
    const p = await project('image');
    const { title } = await landscape(p.id, p.doc);
    await auto.callTool({ name: 'update_node', arguments: { projectId: p.id, nodeId: title, set: { text: 'Winter' } } });
    const body = await json(await ts.api(`/api/projects/${p.id}`));
    expect(body.aiMarks[title]).toMatchObject({ by: 'Claude' });
    expect(Object.keys(body.aiMarks)).toEqual([title]);
    void nodesOfType;
    void newSlideOps;
  });
});
