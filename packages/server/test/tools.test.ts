import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { childrenOf, deckSlides, documentBlocks, nodesOfType, slideElements, tracksOf, clipsOf, type ProjectState, type SceneNode } from '@omnix/core';
import { startTestServer, json, type TestServer } from './helpers.js';

let ts: TestServer;
let auto: Client;
let approve: Client;
let viewer: Client;

async function connect(scopes: string[], name: string) {
  const { token } = await json(await ts.api('/api/auth/tokens', { method: 'POST', json: { name, scopes } }));
  const c = new Client({ name, version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${ts.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}

/** Call a tool and return its structured result; fail the test with the tool's message on error. */
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
  return (r.structuredContent ?? {}) as Record<string, any>;
}

async function callError(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const r = await c.callTool({ name, arguments: args });
  expect(r.isError, `${name} should fail`).toBe(true);
  return JSON.stringify(r.content);
}

const state = async (projectId: string) => (await json(await ts.api(`/api/projects/${projectId}`))).state as ProjectState;

async function upload(name: string, data: Buffer, projectId: string, type: string) {
  return (await json(await ts.api(`/api/assets?name=${encodeURIComponent(name)}&projectId=${projectId}`, { method: 'POST', body: new Uint8Array(data), headers: { 'content-type': type } }))).asset as { id: string };
}

beforeAll(async () => {
  ts = await startTestServer();
  auto = await connect(['omnix:read', 'omnix:edit', 'omnix:autonomous'], 'Claude');
  approve = await connect(['omnix:read', 'omnix:edit'], 'Claude reviewer');
  viewer = await connect(['omnix:read'], 'Claude viewer');
});

afterAll(async () => {
  for (const c of [auto, approve, viewer]) await c?.close().catch(() => {});
  await ts?.close();
});

describe('project tools', () => {
  it('creates projects and documents, edits any node, and refuses bad operations', async () => {
    const p = await call(auto, 'create_project', { name: 'Launch', primaryTool: 'document' });
    const meta = (await json(await ts.api(`/api/projects/${p.projectId}`))).project;
    expect(meta.aiConsent).toBe(true);
    const deck = await call(auto, 'add_document', { projectId: p.projectId, tool: 'slides', name: 'Launch slides' });
    expect(deck.status).toBe('committed');
    const s = await state(p.projectId);
    expect(s.nodes[deck.documentId]!.type).toBe('deck');
    await call(auto, 'update_node', { projectId: p.projectId, nodeId: deck.documentId, set: { name: 'Renamed deck' } });
    expect(((await state(p.projectId)).nodes[deck.documentId] as SceneNode<'deck'>).props.name).toBe('Renamed deck');
    const bad = await callError(auto, 'update_node', { projectId: p.projectId, nodeId: deck.documentId, set: { width: -5 } });
    expect(bad).toMatch(/Invalid operation/);
    const missing = await callError(auto, 'delete_node', { projectId: p.projectId, nodeId: 'nope' });
    expect(missing).toMatch(/No deletable node/);
    const raw = await call(auto, 'apply_operations', { projectId: p.projectId, label: 'Rename twice', operations: [{ kind: 'update', id: deck.documentId, set: { name: 'A' } }, { kind: 'update', id: deck.documentId, set: { name: 'B' } }] });
    expect(raw.status).toBe('committed');
    const undone = await call(auto, 'undo', { projectId: p.projectId });
    expect(undone.undone).toMatch(/Rename twice/);
    expect(((await state(p.projectId)).nodes[deck.documentId] as SceneNode<'deck'>).props.name).toBe('Renamed deck');
  });

  it('keeps view-only connections from changing anything', async () => {
    const p = await call(auto, 'create_project', { name: 'Read me', primaryTool: 'document' });
    expect(await callError(viewer, 'add_document', { projectId: p.projectId, tool: 'image', name: 'X' })).toMatch(/view-only/);
    expect(await callError(viewer, 'create_project', { name: 'X', primaryTool: 'image' })).toMatch(/view-only/);
  });
});

describe('documents', () => {
  it('writes markdown, suggests, comments and accepts', async () => {
    const p = await call(auto, 'create_project', { name: 'Report', primaryTool: 'document' });
    const doc = p.documentId as string;
    const w = await call(auto, 'doc_insert_markdown', { projectId: p.projectId, documentId: doc, markdown: '## Results\n\nSales grew **12%**.\n\n- North led\n- South recovered' });
    expect(w.blockIds).toHaveLength(4);
    const para = w.blockIds[1] as string;
    const sug = await call(approve, 'doc_suggest', { projectId: p.projectId, blockId: para, kind: 'replace', text: 'Sales grew **12%** year over year.', reason: 'Clarify the period' });
    // Suggestions are themselves reviewable, so they land directly even in approval mode.
    expect(sug.status).toBe('committed');
    const cm = await call(approve, 'add_comment', { projectId: p.projectId, nodeId: para, quote: '12%', text: 'Source?' });
    expect(cm.status).toBe('committed');
    await call(auto, 'add_comment', { projectId: p.projectId, replyTo: cm.commentId, text: 'Q3 report, page 4.' });
    await call(auto, 'doc_resolve_suggestion', { projectId: p.projectId, suggestionId: sug.suggestionId, accept: true });
    await call(auto, 'doc_set_style', { projectId: p.projectId, documentId: doc, style: 'h2', color: '#1d3557' });
    const s = await state(p.projectId);
    const blocks = documentBlocks(s, doc);
    expect(blocks.find((b) => b.id === para)!.props.text).toBe('Sales grew **12%** year over year.');
    const comment = s.nodes[cm.commentId] as SceneNode<'comment'>;
    expect(comment.props.anchor).toMatchObject({ tool: 'document', nodeId: para, range: [11, 14] });
    expect(comment.props.replies).toHaveLength(1);
    expect((s.nodes[doc] as SceneNode<'document'>).props.styles.h2!.color).toBe('#1d3557');
  });
});

describe('image', () => {
  it('builds layers, adjusts, selects, fills, masks and resizes', async () => {
    const p = await call(auto, 'create_project', { name: 'Poster', primaryTool: 'image' });
    const canvas = p.documentId as string;
    const png = await sharp({ create: { width: 200, height: 120, channels: 4, background: { r: 30, g: 120, b: 220, alpha: 1 } } })
      .composite([{ input: await sharp({ create: { width: 60, height: 60, channels: 4, background: { r: 240, g: 60, b: 40, alpha: 1 } } }).png().toBuffer(), left: 70, top: 30 }])
      .png()
      .toBuffer();
    const asset = await upload('photo.png', png, p.projectId, 'image/png');
    const photo = await call(auto, 'image_add_layer', { projectId: p.projectId, canvasId: canvas, kind: 'raster', assetId: asset.id, x: 0, y: 0 });
    const text = await call(auto, 'image_add_layer', { projectId: p.projectId, canvasId: canvas, kind: 'text', text: 'Spring sale\nNow on', x: 20, y: 20, fontSize: 40, color: '#ffffff' });
    await call(auto, 'image_add_adjustment', { projectId: p.projectId, canvasId: canvas, adjustment: { kind: 'temperature', amount: 30 }, name: 'Warmer' });
    const sel = await call(auto, 'image_select_smart', { projectId: p.projectId, canvasId: canvas, method: 'color', x: 100, y: 60, tolerance: 30 });
    expect(sel.bounds).toMatchObject({ x: 70, y: 30, width: 60, height: 60 });
    await call(auto, 'image_add_filter', { projectId: p.projectId, layerId: photo.layerId, filter: 'gaussianBlur', params: { radius: 2 } });
    const fill = await call(auto, 'image_content_aware_fill', { projectId: p.projectId, canvasId: canvas });
    await call(auto, 'image_mask_layer', { projectId: p.projectId, layerId: photo.layerId, from: 'selection', inverted: true });
    const bg = await call(auto, 'image_remove_background', { projectId: p.projectId, layerId: photo.layerId });
    expect(bg.keptPercent).toBeGreaterThan(0);
    await call(auto, 'image_paint', { projectId: p.projectId, layerId: photo.layerId, strokes: [{ points: [{ x: 10, y: 10 }, { x: 50, y: 40 }], color: '#ff0000', size: 8 }] });
    await call(auto, 'image_resize_canvas', { projectId: p.projectId, canvasId: canvas, width: 1200, height: 900, anchor: { x: 0, y: 0 } });
    const s = await state(p.projectId);
    const layers = childrenOf(s, canvas).map((l) => (l as SceneNode<'layer'>).props);
    expect(layers.map((l) => l.layerType)).toEqual(['fill', 'raster', 'text', 'adjustment', 'raster']);
    expect(layers.find((l) => l.layerType === 'text')!.name).toBe('Spring sale');
    expect(s.nodes[fill.layerId]).toBeTruthy();
    expect((s.nodes[photo.layerId] as SceneNode<'layer'>).props.mask?.source.kind).toBe('mask');
    expect((s.nodes[photo.layerId] as SceneNode<'layer'>).props.strokes).toHaveLength(1);
    expect((s.nodes[text.layerId] as SceneNode<'layer'>).props.x).toBe(20);
    const preview = await auto.callTool({ name: 'render_preview', arguments: { projectId: p.projectId, nodeId: canvas, maxSize: 256 } });
    expect((preview.content as { type: string }[]).some((c) => c.type === 'image')).toBe(true);
  });
});

describe('video and animation', () => {
  it('edits a timeline end to end', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnix-tools-'));
    const mp4 = path.join(dir, 'clip.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4]);
    const p = await call(auto, 'create_project', { name: 'Teaser', primaryTool: 'video' });
    const seq = p.documentId as string;
    const asset = await upload('clip.mp4', fs.readFileSync(mp4), p.projectId, 'video/mp4');
    const clip = await call(auto, 'video_add_clip', { projectId: p.projectId, sequenceId: seq, assetId: asset.id, in: 1, out: 5 });
    expect(clip.end).toBe(4);
    const title = await call(auto, 'video_add_title', { projectId: p.projectId, sequenceId: seq, text: 'Coming soon', start: 0.5, duration: 2 });
    const split = await call(auto, 'video_edit_clip', { projectId: p.projectId, clipId: clip.clipId, action: 'split', time: 2 });
    await call(auto, 'video_set_speed', { projectId: p.projectId, clipId: split.newClipId, speed: 2 });
    await call(auto, 'video_set_keyframe', { projectId: p.projectId, nodeId: clip.clipId, property: 'scale', time: 0, value: 1.2 });
    const k = await call(auto, 'video_set_keyframe', { projectId: p.projectId, nodeId: clip.clipId, property: 'scale', time: 1.5, value: 1 });
    expect(k.keyframes).toBe(2);
    await call(auto, 'video_set_transition', { projectId: p.projectId, clipId: split.newClipId, side: 'in', kind: 'crossfade', duration: 0.5 });
    await call(auto, 'video_add_effect', { projectId: p.projectId, clipId: clip.clipId, effect: 'colorGrade', params: { saturation: 20 } });
    const music = await call(auto, 'video_add_track', { projectId: p.projectId, sequenceId: seq, trackType: 'audio', name: 'Music' });
    const voice = await call(auto, 'video_add_track', { projectId: p.projectId, sequenceId: seq, trackType: 'audio', name: 'Voice' });
    await call(auto, 'video_mix_track', { projectId: p.projectId, trackId: music.trackId, gain: -6, duckUnder: voice.trackId, duckAmountDb: -12 });
    await call(auto, 'video_remove_background', { projectId: p.projectId, clipId: clip.clipId, method: 'chroma' });
    const s = await state(p.projectId);
    const videoTrack = tracksOf(s, seq).find((t) => t.props.trackType === 'video')!;
    const clips = clipsOf(s, videoTrack.id);
    expect(clips.map((c) => [c.props.start, c.props.in, c.props.out, c.props.speed])).toEqual([
      [0, 1, 3, 1],
      [2, 3, 5, 2],
    ]);
    expect((s.nodes[title.clipId] as SceneNode<'clip'>).props.title?.text).toBe('Coming soon');
    expect((s.nodes[music.trackId] as SceneNode<'track'>).props).toMatchObject({ gain: -6, ducking: { enabled: true, sourceTrackId: voice.trackId, amountDb: -12 } });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('animates layers with frames, paths and bones', async () => {
    const p = await call(auto, 'create_project', { name: 'Bounce', primaryTool: 'animation' });
    const seq = p.documentId as string;
    const layer = await call(auto, 'anim_add_layer', { projectId: p.projectId, sequenceId: seq, name: 'Ball', shapes: [{ id: 'b', kind: 'ellipse', x: -40, y: -40, width: 80, height: 80, fill: '#e8590c', stroke: null, strokeWidth: 0 }] });
    await call(auto, 'anim_add_frame', { projectId: p.projectId, layerId: layer.layerId, shapes: [{ id: 's', kind: 'ellipse', x: -50, y: -30, width: 100, height: 60, fill: '#e8590c', stroke: null, strokeWidth: 0 }], hold: 2 });
    await call(auto, 'anim_set_motion_path', { projectId: p.projectId, layerId: layer.layerId, points: [{ x: -400, y: 100 }, { x: 0, y: -100 }, { x: 400, y: 100 }] });
    const rig = await call(auto, 'anim_rig', { projectId: p.projectId, layerId: layer.layerId, addBones: [{ id: 'upper', name: 'Upper', parentId: null, length: 80, angle: 0.2 }, { id: 'lower', name: 'Lower', parentId: 'upper', length: 60, angle: 0.4 }], pose: { time: 1, angles: { upper: -0.5, lower: 1 } } });
    expect(rig.boneIds).toEqual(['upper', 'lower']);
    const s = await state(p.projectId);
    const l = s.nodes[layer.layerId] as SceneNode<'animLayer'>;
    expect(l.props.frames).toHaveLength(2);
    expect(l.props.motionPath?.path.anchors).toHaveLength(3);
    expect(l.props.rig?.poses).toHaveLength(1);
  });
});

describe('slides and code', () => {
  it('builds a deck, writes and runs code, and links the chart into the deck and a document', async () => {
    const p = await call(auto, 'create_project', { name: 'Pitch', primaryTool: 'slides' });
    const deck = p.documentId as string;
    const slide = await call(auto, 'slides_add_slide', { projectId: p.projectId, deckId: deck, layout: 'title-body', title: 'Pricing', body: '- Starter: free\n- Pro: $12', notes: 'One minute.' });
    expect(slide.elementIds).toHaveLength(2);
    const chart = await call(auto, 'slides_add_element', { projectId: p.projectId, slideId: slide.slideId, elementType: 'chart', x: 960, y: 300, w: 800, h: 500, chart: { type: 'bar', labels: ['A', 'B'], series: [{ name: 'S', values: [1, 2] }] } });
    await call(auto, 'slides_animate', { projectId: p.projectId, elementId: chart.elementId, kind: 'fade-in', trigger: 'on-click', click: 2 });
    await call(auto, 'slides_edit_slide', { projectId: p.projectId, slideId: slide.slideId, transition: { kind: 'push', duration: 0.6 } });
    const dup = await call(auto, 'slides_edit_slide', { projectId: p.projectId, slideId: slide.slideId, duplicate: true });
    await call(auto, 'slides_edit_slide', { projectId: p.projectId, slideId: dup.slideId, index: 0, hidden: true });
    await call(auto, 'slides_set_theme', { projectId: p.projectId, deckId: deck, preset: 'Midnight' });
    const outline = await call(auto, 'slides_outline', { projectId: p.projectId, deckId: deck });
    expect(outline.slides.map((s: { name: string }) => s.name)).toEqual(['Pricing copy', p.projectId ? 'Title' : '', 'Pricing'].filter(Boolean));
    expect(outline.slides[2].elements.find((e: { type: string }) => e.type === 'chart').animations).toEqual(['fade-in on-click #2']);

    const code = await call(auto, 'add_document', { projectId: p.projectId, tool: 'code', name: 'Numbers' });
    const file = await call(auto, 'code_write_file', { projectId: p.projectId, workspaceId: code.documentId, path: 'calc.py', content: 'print("total", 1 + 1)\n' });
    expect(file.created).toBe(true);
    await call(auto, 'code_edit_file', { projectId: p.projectId, fileId: file.fileId, edits: [{ find: '1 + 1', replace: '40 + 2' }] });
    const run = await call(auto, 'code_run', { projectId: p.projectId, workspaceId: code.documentId, fileId: file.fileId });
    expect(run.ok).toBe(true);
    expect(JSON.stringify(run.outputs)).toContain('total 42');
    let s = await state(p.projectId);
    const nb = nodesOfType(s, 'notebook')[0]!;
    const cell = await call(auto, 'code_add_cell', { projectId: p.projectId, notebookId: nb.id, source: 'import omnix\nomnix.chart(type="line", title="Trend", labels=["Q1","Q2"], series=[{"name": "Sales", "values": [10, 14]}])' });
    const ran = await call(auto, 'code_run', { projectId: p.projectId, workspaceId: code.documentId, cellId: cell.cellId });
    expect(ran.saved).toBe(true);
    const onSlide = await call(auto, 'code_place_output', { projectId: p.projectId, cellId: cell.cellId, slideId: slide.slideId });
    const doc = await call(auto, 'add_document', { projectId: p.projectId, tool: 'document', name: 'Notes' });
    const inDoc = await call(auto, 'code_place_output', { projectId: p.projectId, cellId: cell.cellId, documentId: doc.documentId });
    s = await state(p.projectId);
    expect((s.nodes[onSlide.nodeId] as SceneNode<'slideElement'>).props.embed).toEqual({ kind: 'chart', ref: cell.cellId });
    expect((s.nodes[inDoc.nodeId] as SceneNode<'block'>).props.embed).toEqual({ kind: 'chart', ref: cell.cellId });
    expect((s.nodes[deck] as SceneNode<'deck'>).props.theme.name).toBe('Midnight');

    // Export through MCP: the signed link downloads without a session; tampering fails.
    const exp = await call(auto, 'export_file', { projectId: p.projectId, nodeId: deck, format: 'pptx' });
    expect(exp.name).toBe('Pitch.pptx');
    const dl = await fetch(exp.url);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toContain('Pitch.pptx');
    expect((await fetch(exp.url.replace(/sig=[^&]+/, 'sig=forged'))).status).toBe(403);
  }, 120_000);
});

describe('edit with approval', () => {
  it('stacks related changes into one proposal that builds on itself', async () => {
    const p = await call(auto, 'create_project', { name: 'Review me', primaryTool: 'slides' });
    const deck = p.documentId as string;
    const before = deckSlides(await state(p.projectId), deck).length;
    const a = await call(approve, 'slides_add_slide', { projectId: p.projectId, deckId: deck, layout: 'title-body', title: 'Roadmap' });
    expect(a.status).toBe('proposed');
    // The new slide only exists in the proposal, yet the next change can build on it.
    const b = await call(approve, 'slides_add_element', { projectId: p.projectId, slideId: a.slideId, elementType: 'text', x: 100, y: 900, w: 800, h: 80, text: 'Draft' });
    expect(b.status).toBe('proposed');
    expect(b.proposalId).toBe(a.proposalId);
    expect(b.changes).toBe(2);
    // Claude reads its own pending work.
    const outline = await call(approve, 'slides_outline', { projectId: p.projectId, deckId: deck });
    expect(outline.slides).toHaveLength(before + 1);
    // Nothing is applied until the person accepts.
    expect(deckSlides(await state(p.projectId), deck)).toHaveLength(before);
    const proposals = (await json(await ts.api(`/api/projects/${p.projectId}/proposals?status=open`))).proposals;
    expect(proposals).toHaveLength(1);
    expect(proposals[0].steps).toHaveLength(2);
    await ts.api(`/api/projects/${p.projectId}/proposals/${a.proposalId}/accept`, { method: 'POST', json: {} });
    const s = await state(p.projectId);
    expect(slideElements(s, a.slideId).map((e) => e.props.text)).toContain('Draft');

    // An unrelated idea becomes its own proposal.
    const c = await call(approve, 'slides_set_theme', { projectId: p.projectId, deckId: deck, preset: 'Paper' });
    await call(approve, 'start_new_proposal', { projectId: p.projectId });
    const d = await call(approve, 'slides_set_theme', { projectId: p.projectId, deckId: deck, preset: 'Bold' });
    expect(d.proposalId).not.toBe(c.proposalId);
  });
});
