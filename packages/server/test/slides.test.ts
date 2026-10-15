import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { unzipSync } from 'fflate';
import { deckSlides, makeNode, nodesOfType, slideElements, type Operation, type ProjectState, type SceneNode } from '@omnix/core';
import { importPptx } from '@omnix/exporters';
import { startTestServer, json, type TestServer } from './helpers.js';

let ts: TestServer;
let projectId = '';
let deckId = '';
let otherAssetId = '';

const FIXTURE = path.resolve(__dirname, '../../exporters/test/fixtures/sample.pptx');
const has = (cmd: string) => spawnSync(cmd, ['-v'], { stdio: 'ignore' }).error === undefined;

const commit = async (op: Operation) => json(await ts.api(`/api/projects/${projectId}/commits`, { method: 'POST', json: { op } }));
const getState = async () => (await json(await ts.api(`/api/projects/${projectId}`))).state as ProjectState;

async function upload(name: string, data: Buffer, type: string) {
  return (await json(await ts.api(`/api/assets?name=${encodeURIComponent(name)}&projectId=${projectId}`, { method: 'POST', body: new Uint8Array(data), headers: { 'content-type': type } }))).asset as { id: string; mime: string };
}

async function exportAs(format: string) {
  const j = await json(await ts.api(`/api/projects/${projectId}/export?wait=true`, { method: 'POST', json: { nodeId: deckId, format } }));
  expect(j.job.status, j.job.error).toBe('done');
  const out = { name: j.job.result.name as string, notes: j.job.result.notes as string[], data: Buffer.from(await (await ts.api(j.job.result.downloadUrl)).arrayBuffer()) };
  if (process.env.OMNIX_TEST_DUMP) fs.writeFileSync(path.join(process.env.OMNIX_TEST_DUMP, out.name), out.data);
  return out;
}

beforeAll(async () => {
  ts = await startTestServer();
  projectId = (await json(await ts.api('/api/projects', { method: 'POST', json: { name: 'Pitch', primaryTool: 'slides' } }))).project.id;
  deckId = nodesOfType(await getState(), 'deck')[0]!.id;
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#e34948' } }).png().toBuffer();
  otherAssetId = (await upload('private.png', png, 'image/png')).id;
});

afterAll(async () => {
  await ts?.close();
});

describe('PowerPoint import', () => {
  it('imports slides with text, bullets, links, shapes, charts, video, notes, transitions and builds', async () => {
    const before = deckSlides(await getState(), deckId).length;
    const asset = await upload('sample.pptx', fs.readFileSync(FIXTURE), 'application/octet-stream');
    expect(asset.mime).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    const r = await json(await ts.api(`/api/projects/${projectId}/decks/${deckId}/import`, { method: 'POST', json: { assetId: asset.id } }));
    expect(r.slides).toBe(5);
    expect(r.notes).toContain('Tables were imported as text.');
    const state = await getState();
    const slides = deckSlides(state, deckId);
    expect(slides.length).toBe(before + 5);
    const [title, bullets, shapes, numbers, hidden] = slides.slice(before);
    expect(r.firstSlideId).toBe(title!.id);

    const titleEls = slideElements(state, title!.id);
    expect(titleEls.map((e) => e.props.text)).toEqual(['Quarterly Review', 'Prepared for Seb']);
    expect(titleEls[0]!.props.role).toBe('title');
    expect(title!.props.name).toBe('Quarterly Review');
    expect(title!.props.notes).toBe('Welcome everyone.\nKeep this short.');

    const body = slideElements(state, bullets!.id).find((e) => e.props.role === 'body')!;
    expect(body.props.text).toBe('- Revenue grew 12%\n- Costs **fell** *slightly*\n  - [Details on the website](https://example.com/report)');
    expect(body.props.animations).toEqual([expect.objectContaining({ kind: 'fade-in', trigger: 'on-click', click: 1, duration: 0.75 })]);
    expect(bullets!.props.transition.kind).toBe('push');

    const shapeEls = slideElements(state, shapes!.id);
    const kinds = shapeEls.map((e) => (e.props.elementType === 'shape' ? e.props.shape!.kind : e.props.elementType));
    expect(kinds).toEqual(['rect', 'text', 'ellipse', 'polygon', 'polygon', 'line', 'image', 'rect', 'text']);
    const inShape = shapeEls[1]!.props;
    expect(inShape.color).toBe('#ffffff');
    expect(inShape.valign).toBe('middle');
    expect(shapeEls.find((e) => e.props.elementType === 'shape' && e.props.shape!.kind === 'polygon')!.props.rotation).toBe(15);
    // The picture was cropped (left 25%) before it was stored.
    const pic = shapeEls.find((e) => e.props.elementType === 'image')!;
    const picAsset = await json(await ts.api(`/api/assets/${pic.props.assetId}`));
    expect(picAsset.asset.width).toBe(48);

    const chart = slideElements(state, numbers!.id).find((e) => e.props.elementType === 'chart')!;
    expect(chart.props.chart).toMatchObject({ type: 'bar', title: 'Sales by region', labels: ['Q1', 'Q2', 'Q3'], series: [{ name: 'North', values: [10, 14, 18] }, { name: 'South', values: [8, 9, 12] }] });
    expect(slideElements(state, numbers!.id).some((e) => e.props.chart?.type === 'pie')).toBe(true);

    expect(hidden!.props.hidden).toBe(true);
    expect(hidden!.props.background).toBe('#14161c');
    const video = slideElements(state, hidden!.id)[0]!;
    expect(video.props.elementType).toBe('video');
    const videoAsset = await json(await ts.api(`/api/assets/${video.props.assetId}`));
    expect(videoAsset.asset.kind).toBe('video');
  });

  it('refuses files that are not presentations', async () => {
    const asset = await upload('notes.txt', Buffer.from('hello'), 'text/plain');
    const r = await ts.api(`/api/projects/${projectId}/decks/${deckId}/import`, { method: 'POST', json: { assetId: asset.id } });
    expect(r.status).toBe(400);
    expect((await json(r)).error).toMatch(/PowerPoint/);
  });
});

describe('slideshow export', () => {
  it('writes PowerPoint that keeps text, charts, notes, transitions and builds', async () => {
    const out = await exportAs('pptx');
    expect(out.name).toBe('Pitch.pptx');
    const files = unzipSync(new Uint8Array(out.data));
    expect(Object.keys(files).some((f) => /^ppt\/media\/.*\.mp4$/.test(f))).toBe(true);
    expect(Object.keys(files).some((f) => /^ppt\/charts\/chart\d+\.xml$/.test(f))).toBe(true);
    const back = importPptx(new Uint8Array(out.data), { width: 1920, height: 1080 });
    const state = await getState();
    expect(back.slides.length).toBe(deckSlides(state, deckId).length);
    const texts = back.slides.flatMap((s) => s.elements.flatMap((e) => (e.kind === 'text' ? [e.text] : [])));
    expect(texts).toContain('Quarterly Review');
    expect(texts.some((t) => t.includes('[Details on the website](https://example.com/report)'))).toBe(true);
    expect(back.slides.some((s) => s.notes === 'Welcome everyone.\nKeep this short.')).toBe(true);
    expect(back.slides.some((s) => s.transition?.kind === 'push')).toBe(true);
    expect(back.slides.some((s) => s.hidden)).toBe(true);
    const built = back.slides.flatMap((s) => s.elements).find((e) => e.animations.length);
    expect(built?.animations[0]).toMatchObject({ kind: 'fade-in', trigger: 'on-click', click: 1 });
    const charts = back.slides.flatMap((s) => s.elements).filter((e) => e.kind === 'chart');
    expect(charts.map((c) => (c.kind === 'chart' ? c.spec.type : ''))).toEqual(expect.arrayContaining(['bar', 'pie']));
  });

  it('opens in LibreOffice', async () => {
    if (!has('soffice')) return;
    const out = await exportAs('pptx');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnix-pptx-'));
    fs.writeFileSync(path.join(dir, 'deck.pptx'), out.data);
    const r = spawnSync('soffice', ['--headless', '--norestore', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'pdf', '--outdir', dir, path.join(dir, 'deck.pptx')], { timeout: 120_000 });
    expect(r.status).toBe(0);
    const text = spawnSync('pdftotext', [path.join(dir, 'deck.pdf'), '-']).stdout?.toString() ?? '';
    expect(text).toContain('Quarterly Review');
    expect(text).toContain('Revenue grew 12%');
    fs.rmSync(dir, { recursive: true, force: true });
  }, 180_000);

  it('writes a searchable PDF without hidden slides, and a handout with notes', async () => {
    const state = await getState();
    const visible = deckSlides(state, deckId).filter((s) => !s.props.hidden).length;
    const pdf = await exportAs('pdf');
    expect(pdf.data.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.notes).toContain('Hidden slides were left out.');
    if (has('pdfinfo')) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnix-pdf-'));
      fs.writeFileSync(path.join(dir, 'a.pdf'), pdf.data);
      const info = spawnSync('pdfinfo', [path.join(dir, 'a.pdf')]).stdout.toString();
      expect(Number(/Pages:\s+(\d+)/.exec(info)?.[1])).toBe(visible);
      const text = spawnSync('pdftotext', [path.join(dir, 'a.pdf'), '-']).stdout.toString();
      expect(text).toContain('Quarterly Review');
      const handout = await exportAs('pdf-notes');
      fs.writeFileSync(path.join(dir, 'b.pdf'), handout.data);
      expect(spawnSync('pdftotext', [path.join(dir, 'b.pdf'), '-']).stdout.toString()).toContain('Welcome everyone.');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes one PNG per visible slide', async () => {
    const state = await getState();
    const out = await exportAs('png');
    const files = Object.keys(unzipSync(new Uint8Array(out.data)));
    expect(files.length).toBe(deckSlides(state, deckId).filter((s) => !s.props.hidden).length);
    expect(files[0]).toMatch(/^01-.*\.png$/);
  });
});

describe('PDF import', () => {
  it('turns each page into a slide with the page as a picture', async () => {
    if (!has('pdftoppm')) return;
    const pdf = await exportAs('pdf');
    const asset = await upload('deck.pdf', pdf.data, 'application/pdf');
    const before = deckSlides(await getState(), deckId).length;
    const r = await json(await ts.api(`/api/projects/${projectId}/decks/${deckId}/import`, { method: 'POST', json: { assetId: asset.id } }));
    const state = await getState();
    expect(deckSlides(state, deckId).length).toBe(before + r.slides);
    const added = deckSlides(state, deckId).slice(before);
    expect(added[0]!.props.name).toBe('Page 1');
    const els = slideElements(state, added[0]!.id);
    expect(els.length).toBe(1);
    expect(els[0]!.props).toMatchObject({ elementType: 'image', x: 0, y: 0, w: 1920, h: 1080 });
    // Undo the import so later tests see the PowerPoint slides only.
    await ts.api(`/api/projects/${projectId}/undo`, { method: 'POST', json: {} });
  }, 120_000);
});

describe('presentation links', () => {
  it('serves the deck publicly without notes and only the media it uses', async () => {
    // A live link to a canvas brings the canvas (and its pictures) along.
    let state = await getState();
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#1baf7a' } }).png().toBuffer();
    const canvasPic = await upload('canvas.png', png, 'image/png');
    const canvas = makeNode('canvas', { name: 'Poster', width: 400, height: 300 });
    const layer = makeNode('layer', { layerType: 'raster', name: 'Pic', assetId: canvasPic.id, width: 40, height: 40 });
    canvas.children = [layer.id];
    layer.parentId = canvas.id;
    await commit({ kind: 'create', parentId: state.rootId, nodes: [canvas, layer] });
    const firstSlide = deckSlides(state, deckId)[0]!;
    await commit({ kind: 'create', parentId: firstSlide.id, nodes: [makeNode('slideElement', { elementType: 'embed', x: 10, y: 10, w: 400, h: 300, embed: { kind: 'canvas', ref: canvas.id } })] });

    const share = await json(await ts.api(`/api/projects/${projectId}/decks/${deckId}/share`, { method: 'POST' }));
    expect(share.shareId).toMatch(/^[\w-]{20,}$/);
    expect(share.url).toBe(`${ts.url}/present/${share.shareId}`);
    state = await getState();
    expect((state.nodes[deckId] as SceneNode<'deck'>).props.shareId).toBe(share.shareId);

    // No cookie: anyone with the link.
    const pub = await fetch(`${ts.url}/api/present/${share.shareId}`);
    expect(pub.status).toBe(200);
    const body = (await pub.json()) as { name: string; deckId: string; state: ProjectState };
    expect(body.deckId).toBe(deckId);
    const shared = body.state;
    const sharedSlides = deckSlides(shared, deckId);
    expect(sharedSlides.length).toBe(deckSlides(state, deckId).length);
    expect(sharedSlides.every((s) => s.props.notes === '')).toBe(true);
    expect(shared.nodes[canvas.id]).toBeTruthy();
    expect(Object.values(shared.nodes).some((n) => n.type === 'comments' || n.type === 'project')).toBe(false);

    const pic = sharedSlides.flatMap((s) => slideElements(shared, s.id)).find((e) => e.props.elementType === 'image' && e.props.assetId)!;
    expect((await fetch(`${ts.url}/api/present/${share.shareId}/assets/${pic.props.assetId}`)).status).toBe(200);
    expect((await fetch(`${ts.url}/api/present/${share.shareId}/assets/${pic.props.assetId}/file`)).status).toBe(200);
    expect((await fetch(`${ts.url}/api/present/${share.shareId}/assets/${canvasPic.id}/file`)).status).toBe(200);
    // Assets the deck does not use stay private.
    expect((await fetch(`${ts.url}/api/present/${share.shareId}/assets/${otherAssetId}/file`)).status).toBe(404);
    expect((await fetch(`${ts.url}/api/assets/${pic.props.assetId}/file`)).status).toBe(401);
  });

  it('streams where the presenter is to people watching the public link', async () => {
    const state = await getState();
    const shareId = (state.nodes[deckId] as SceneNode<'deck'>).props.shareId!;
    const [first, second] = deckSlides(state, deckId);
    // Anyone with the link can listen; no cookie.
    const ctrl = new AbortController();
    const res = await fetch(`${ts.url}/api/present/${shareId}/live`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    let buffer = '';
    const nextEvent = async (): Promise<Record<string, unknown>> => {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const chunk = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (data) return JSON.parse(data.slice(6));
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += new TextDecoder().decode(value);
      }
    };
    try {
      expect(await nextEvent()).toEqual({ presenting: false });
      const r = await json(await ts.api(`/api/projects/${projectId}/decks/${deckId}/live`, { method: 'POST', json: { slideId: second!.id, step: 1 } }));
      expect(r).toEqual({ shared: true, watching: 1 });
      expect(await nextEvent()).toEqual({ presenting: true, slideId: second!.id, step: 1 });
      await ts.api(`/api/projects/${projectId}/decks/${deckId}/live`, { method: 'POST', json: { slideId: first!.id, step: 0 } });
      expect(await nextEvent()).toMatchObject({ slideId: first!.id });
      await ts.api(`/api/projects/${projectId}/decks/${deckId}/live`, { method: 'POST', json: { ended: true } });
      expect(await nextEvent()).toEqual({ presenting: false });
    } finally {
      ctrl.abort();
    }
    // Reporting needs an account with access; listening to a link that does not exist fails.
    expect((await fetch(`${ts.url}/api/projects/${projectId}/decks/${deckId}/live`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"slideId":"x"}' })).status).toBe(401);
    expect((await fetch(`${ts.url}/api/present/not-a-real-share-id/live`)).status).toBe(404);
  });

  it('closes the link when sharing is turned off, and undo brings it back', async () => {
    const state = await getState();
    const shareId = (state.nodes[deckId] as SceneNode<'deck'>).props.shareId!;
    await ts.api(`/api/projects/${projectId}/decks/${deckId}/share`, { method: 'DELETE' });
    const off = await fetch(`${ts.url}/api/present/${shareId}`);
    expect(off.status).toBe(404);
    expect(((await off.json()) as { error: string }).error).toMatch(/not available/);
    await ts.api(`/api/projects/${projectId}/undo`, { method: 'POST', json: {} });
    // The share cache keeps answers for a few seconds; a fresh id check goes through the deck.
    await new Promise((r) => setTimeout(r, 50));
    const back = await fetch(`${ts.url}/api/present/${shareId}`);
    expect(back.status).toBe(200);
    expect((await fetch(`${ts.url}/api/present/not-a-real-share-id`)).status).toBe(404);
  });

  it('only editors can turn sharing on', async () => {
    const anon = await fetch(`${ts.url}/api/projects/${projectId}/decks/${deckId}/share`, { method: 'POST' });
    expect(anon.status).toBe(401);
  });
});
