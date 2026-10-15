import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import sharp from 'sharp';
import { assetRefs, deckSlides, type ProjectState, type SceneNode } from '@omnix/core';
import { startTestServer, json, type TestServer } from './helpers.js';

let ts: TestServer;
let auto: Client;
let approve: Client;

async function connect(scopes: string[], name: string) {
  const { token } = await json(await ts.api('/api/auth/tokens', { method: 'POST', json: { name, scopes } }));
  const c = new Client({ name, version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${ts.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
  return (r.structuredContent ?? {}) as Record<string, any>;
}

const state = async (projectId: string) => (await json(await ts.api(`/api/projects/${projectId}`))).state as ProjectState;

beforeAll(async () => {
  ts = await startTestServer();
  auto = await connect(['omnix:read', 'omnix:edit', 'omnix:autonomous'], 'Claude');
  approve = await connect(['omnix:read', 'omnix:edit'], 'Claude reviewer');
});

afterAll(async () => {
  for (const c of [auto, approve]) await c?.close().catch(() => {});
  await ts?.close();
});

describe('comments pinned in every tool (51)', () => {
  it('keeps code-line comments on their line, lists them with context and resolves them', async () => {
    const p = await call(auto, 'create_project', { name: 'Review', primaryTool: 'code' });
    const ws = await call(auto, 'add_document', { projectId: p.projectId, tool: 'code', name: 'Scripts' });
    const file = await call(auto, 'code_write_file', { projectId: p.projectId, workspaceId: ws.documentId, path: 'calc.py', content: 'a = 1\nb = 2\nprint(a + b)\n' });
    const c = await call(auto, 'add_comment', { projectId: p.projectId, nodeId: file.fileId, line: 3, text: 'Should this be formatted?' });
    // Inserting two lines above the comment moves it with the code it points at.
    await call(auto, 'code_edit_file', { projectId: p.projectId, fileId: file.fileId, edits: [{ find: 'a = 1\n', replace: '# totals\nimport math\na = 1\n' }] });
    let s = await state(p.projectId);
    expect((s.nodes[c.commentId] as SceneNode<'comment'>).props.anchor.line).toBe(5);

    const listed = await call(auto, 'list_comments', { projectId: p.projectId });
    expect(listed.comments).toHaveLength(1);
    expect(listed.comments[0]).toMatchObject({ id: c.commentId, where: 'calc.py, line 5', context: 'print(a + b)', documentId: ws.documentId, resolved: false });

    // Resolving is a review action: it applies directly even for an approval-mode connection.
    const r = await call(approve, 'resolve_comment', { projectId: p.projectId, commentId: c.commentId, reply: 'Formatted with an f-string.' });
    expect(r.status).toBe('committed');
    s = await state(p.projectId);
    const done = s.nodes[c.commentId] as SceneNode<'comment'>;
    expect(done.props.resolved).toBe(true);
    expect(done.props.replies.at(-1)!.text).toBe('Formatted with an f-string.');
    expect((await call(auto, 'list_comments', { projectId: p.projectId })).comments).toHaveLength(0);
    expect((await call(auto, 'list_comments', { projectId: p.projectId, status: 'resolved' })).comments).toHaveLength(1);
  });

  it('describes where slide, timeline, canvas and paragraph comments point', async () => {
    const p = await call(auto, 'create_project', { name: 'Everywhere', primaryTool: 'slides' });
    const deck = await call(auto, 'add_document', { projectId: p.projectId, tool: 'slides', name: 'Deck' });
    const video = await call(auto, 'add_document', { projectId: p.projectId, tool: 'video', name: 'Cut' });
    const canvas = await call(auto, 'add_document', { projectId: p.projectId, tool: 'image', name: 'Poster' });
    const doc = await call(auto, 'add_document', { projectId: p.projectId, tool: 'document', name: 'Brief' });
    await call(auto, 'doc_insert_markdown', { projectId: p.projectId, documentId: doc.documentId, markdown: 'Revenue grew 12% this quarter.' });
    const s = await state(p.projectId);
    const slide = deckSlides(s, deck.documentId)[0]!;
    const block = s.nodes[doc.documentId]!.children.map((id) => s.nodes[id] as SceneNode<'block'>).find((b) => b.props.text.includes('12%'))!;
    await call(auto, 'add_comment', { projectId: p.projectId, nodeId: slide.id, x: 400, y: 300, text: 'Bigger logo' });
    await call(auto, 'add_comment', { projectId: p.projectId, nodeId: video.documentId, time: 3.5, text: 'Cut earlier' });
    await call(auto, 'add_comment', { projectId: p.projectId, nodeId: canvas.documentId, x: 120, y: 80, text: 'Too dark' });
    await call(auto, 'add_comment', { projectId: p.projectId, nodeId: block.id, quote: '12%', text: 'Year over year?' });
    const all = (await call(auto, 'list_comments', { projectId: p.projectId })).comments as { where: string; context?: string; documentId: string; text: string }[];
    const by = Object.fromEntries(all.map((c) => [c.text, c]));
    expect(by['Bigger logo']!.where).toBe('slide 1 at (400, 300)');
    expect(by['Cut earlier']!.where).toMatch(/at 3\.50s/);
    expect(by['Too dark']!.where).toMatch(/at \(120, 80\)/);
    expect(by['Year over year?']!).toMatchObject({ context: '12%', documentId: doc.documentId });
    const onlyDeck = (await call(auto, 'list_comments', { projectId: p.projectId, documentId: deck.documentId })).comments;
    expect(onlyDeck.map((c: { text: string }) => c.text)).toEqual(['Bigger logo']);
  });

  it('shows Claude to collaborators where it is working', async () => {
    const p = await call(auto, 'create_project', { name: 'Live', primaryTool: 'slides' });
    const deck = await call(auto, 'add_document', { projectId: p.projectId, tool: 'slides', name: 'Deck' });
    const s = await state(p.projectId);
    const slide = deckSlides(s, deck.documentId)[0]!;
    await call(auto, 'slides_add_element', { projectId: p.projectId, slideId: slide.id, elementType: 'text', text: 'Hello', x: 200, y: 150, w: 400, h: 80 });
    const here = ts.omnix.services.presence.inProject(p.projectId).find((x) => x.author.type === 'ai');
    expect(here).toBeTruthy();
    expect(here!.location).toMatchObject({ tool: 'slides', nodeId: slide.id, x: 200, y: 150 });
  });
});

describe('versions and visual diff (52)', () => {
  it('saves a version, then compares it with the current state as text, structure and pictures', async () => {
    const p = await call(auto, 'create_project', { name: 'Poster v2', primaryTool: 'image' });
    let s = await state(p.projectId);
    const canvas = Object.values(s.nodes).find((n) => n.type === 'canvas')!;
    await call(auto, 'image_add_layer', { projectId: p.projectId, canvasId: canvas.id, kind: 'fill', name: 'Sky', fillColor: '#3366cc' });
    const v = await call(auto, 'save_version', { projectId: p.projectId, name: 'Blue sky' });
    expect(v.versionId).toMatch(/^snap_/);
    s = await state(p.projectId);
    const sky = Object.values(s.nodes).find((n) => n.type === 'layer' && (n.props as { name?: string }).name === 'Sky')!;
    await call(auto, 'update_node', { projectId: p.projectId, nodeId: sky.id, set: { fillColor: '#cc3333' } });

    const hist = await call(auto, 'get_history', { projectId: p.projectId });
    expect(hist.versions.map((x: { name: string }) => x.name)).toEqual(['Blue sky']);

    const r = await auto.callTool({ name: 'compare_versions', arguments: { projectId: p.projectId, from: v.versionId, documentId: canvas.id } });
    expect(r.isError).toBeFalsy();
    const data = r.structuredContent as Record<string, any>;
    expect(data.from.label).toBe('Blue sky');
    expect(data.comparison.documents[0].structural.changed.map((c: { id: string }) => c.id)).toContain(sky.id);
    expect(data.pixels.changedPercent).toBeGreaterThan(90);
    const images = (r.content as { type: string }[]).filter((c) => c.type === 'image');
    expect(images).toHaveLength(3);

    // The same over HTTP for the app.
    const cmp = await json(await ts.api(`/api/projects/${p.projectId}/compare?from=${v.versionId}&to=current&doc=${canvas.id}`));
    expect(cmp.comparison.changed).toEqual([canvas.id]);
    const px = await json(await ts.api(`/api/projects/${p.projectId}/compare/pixels?from=${v.versionId}&to=current&node=${canvas.id}&size=256`));
    expect(px.fraction).toBeGreaterThan(0.9);
    expect(px.width).toBeLessThanOrEqual(256);
    const img = await ts.api(`/api/projects/${p.projectId}/compare/image?from=${v.versionId}&to=current&node=${canvas.id}&size=256&which=diff`);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect((await img.arrayBuffer()).byteLength).toBeGreaterThan(100);
    // Comparing a version with itself finds nothing.
    const same = await json(await ts.api(`/api/projects/${p.projectId}/compare?from=current&to=current`));
    expect(same.comparison.changed).toEqual([]);
    expect((await ts.api(`/api/projects/${p.projectId}/compare?from=nope`)).status).toBe(404);
  });

  it('compares documents paragraph by paragraph and code line by line', async () => {
    const p = await call(auto, 'create_project', { name: 'Brief', primaryTool: 'document' });
    const doc = await call(auto, 'add_document', { projectId: p.projectId, tool: 'document', name: 'Plan' });
    const ins = await call(auto, 'doc_insert_markdown', { projectId: p.projectId, documentId: doc.documentId, markdown: 'Revenue grew 12% this quarter.' });
    const v = await call(auto, 'save_version', { projectId: p.projectId, name: 'Draft 1' });
    await call(auto, 'doc_edit_block', { projectId: p.projectId, blockId: ins.blockIds[0], text: 'Revenue grew 14% this quarter.' });
    const r = await call(auto, 'compare_versions', { projectId: p.projectId, from: v.versionId, documentId: doc.documentId });
    const d = r.comparison.documents[0];
    expect(d.summary).toMatch(/1 paragraph edited/);
    expect(d.blocks[0]).toMatchObject({ status: 'changed', before: 'Revenue grew 12% this quarter.', after: 'Revenue grew 14% this quarter.' });
    expect(r.pixels).toBeUndefined();
  });

  it('refuses to save versions on a view-only connection', async () => {
    const viewer = await connect(['omnix:read'], 'Viewer');
    const p = await call(auto, 'create_project', { name: 'Locked', primaryTool: 'image' });
    const res = await viewer.callTool({ name: 'save_version', arguments: { projectId: p.projectId, name: 'x' } });
    expect(res.isError).toBe(true);
    await viewer.close();
  });
});

/** A landscape picture: blue sky over green hills with a sun, at any size. */
async function landscape(width: number, format: 'png' | 'jpeg', variant = 0): Promise<Buffer> {
  const h = Math.round(width * 0.625);
  const svg = variant
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 160 100"><rect width="160" height="100" fill="#f4e04d"/><circle cx="40" cy="70" r="30" fill="#c0392b"/><rect x="90" y="10" width="50" height="40" fill="#222"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 160 100"><rect width="160" height="100" fill="#3d7fe0"/><circle cx="120" cy="25" r="12" fill="#ffd34d"/><path d="M0 70 Q40 45 80 70 T160 65 V100 H0Z" fill="#2e9e4f"/></svg>`;
  const img = sharp(Buffer.from(svg));
  return format === 'png' ? img.png().toBuffer() : img.jpeg({ quality: 70 }).toBuffer();
}

async function upload(name: string, data: Buffer, type: string, projectId?: string) {
  const r = await ts.api(`/api/assets?name=${encodeURIComponent(name)}${projectId ? `&projectId=${projectId}` : ''}`, { method: 'POST', body: new Uint8Array(data), headers: { 'content-type': type } });
  return json(r);
}

describe('asset library (53)', () => {
  it('tags files automatically, spots resized copies, and merges them across projects', async () => {
    const big = await upload('hills.png', await landscape(1600, 'png'), 'image/png');
    expect(big.asset.autoTags).toEqual(expect.arrayContaining(['landscape', 'blue']));
    expect(big.similar).toEqual([]);
    // A smaller, re-encoded copy is a different file but the same picture.
    const small = await upload('hills-small.jpg', await landscape(400, 'jpeg'), 'image/jpeg');
    expect(small.deduplicated).toBe(false);
    expect(small.similar.map((x: { id: string }) => x.id)).toEqual([big.asset.id]);
    const other = await upload('poster.png', await landscape(800, 'png', 1), 'image/png');
    expect(other.similar).toEqual([]);

    // Search uses automatic tags, sizes and usage.
    const find = async (q: string) => (await json(await ts.api(`/api/assets?q=${encodeURIComponent(q)}`))).assets.map((a: { name: string }) => a.name);
    expect(await find('blue landscape')).toEqual(expect.arrayContaining(['hills.png', 'hills-small.jpg']));
    expect(await find('blue landscape')).not.toContain('poster.png');
    expect(await find('1600x1000')).toEqual(['hills.png']);

    // The small copy is used on a canvas; merging switches the canvas to the big one.
    const p = await call(auto, 'create_project', { name: 'Hills', primaryTool: 'image' });
    let s = await state(p.projectId);
    const canvas = Object.values(s.nodes).find((n) => n.type === 'canvas')!;
    await call(auto, 'image_add_layer', { projectId: p.projectId, canvasId: canvas.id, kind: 'raster', assetId: small.asset.id, name: 'Hills' });
    expect(await find('unused')).not.toContain('hills-small.jpg');
    const groups = (await json(await ts.api('/api/assets/similar'))).groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].map((a: { id: string }) => a.id)).toEqual([big.asset.id, small.asset.id]);
    expect(groups[0][1].usedIn).toEqual([expect.objectContaining({ projectId: p.projectId, count: 1 })]);

    const merged = await json(await ts.api('/api/assets/merge', { method: 'POST', json: { keep: big.asset.id, drop: [small.asset.id] } }));
    expect(merged.merged).toEqual([small.asset.id]);
    expect(merged.projects).toEqual([expect.objectContaining({ projectId: p.projectId, replaced: 1, status: 'committed' })]);
    s = await state(p.projectId);
    expect(assetRefs(s).get(big.asset.id)).toHaveLength(1);
    expect(assetRefs(s).has(small.asset.id)).toBe(false);
    // The copy is gone from the library; the kept file is now in the project.
    expect((await ts.api(`/api/assets/${small.asset.id}`)).status).toBe(404);
    const kept = await json(await ts.api(`/api/assets/${big.asset.id}`));
    expect(kept.asset.usedIn.map((u: { projectId: string }) => u.projectId)).toEqual([p.projectId]);
    expect((await json(await ts.api('/api/assets/similar'))).groups).toEqual([]);
  });

  it('tags and removes many files at once, keeping files a project still uses', async () => {
    const one = await upload('one.png', await sharp({ create: { width: 64, height: 64, channels: 4, background: '#ff0000' } }).png().toBuffer(), 'image/png');
    const two = await upload('two.png', await sharp({ create: { width: 64, height: 32, channels: 4, background: '#00ff00' } }).png().toBuffer(), 'image/png');
    const r = await json(await ts.api('/api/assets/bulk', { method: 'POST', json: { ids: [one.asset.id, two.asset.id], addTags: ['swatch'] } }));
    expect(r.changed).toBe(2);
    expect((await json(await ts.api('/api/assets?tag=swatch'))).total).toBe(2);
    await json(await ts.api('/api/assets/bulk', { method: 'POST', json: { ids: [one.asset.id], removeTags: ['swatch'] } }));
    expect((await json(await ts.api('/api/assets?tag=swatch'))).total).toBe(1);
    // A file placed in a project survives "remove from library": the project still shows it.
    const p = await call(auto, 'create_project', { name: 'Swatches', primaryTool: 'image' });
    const s = await state(p.projectId);
    const canvas = Object.values(s.nodes).find((n) => n.type === 'canvas')!;
    await call(auto, 'image_add_layer', { projectId: p.projectId, canvasId: canvas.id, kind: 'raster', assetId: two.asset.id });
    await json(await ts.api('/api/assets/bulk', { method: 'POST', json: { ids: [one.asset.id, two.asset.id], remove: true } }));
    expect((await ts.api(`/api/assets/${one.asset.id}/file`)).status).toBe(404);
    expect((await ts.api(`/api/projects/${p.projectId}/render-at?node=${canvas.id}&size=64`)).status).toBe(200);
    expect(await ts.omnix.services.blobs.get(two.asset.id)).toBeTruthy();
  });

  it('lets Claude search, find near-duplicates and propose a merge in approval mode', async () => {
    const a = await upload('mark.png', await landscape(1200, 'png'), 'image/png');
    const b = await upload('mark-copy.jpg', await landscape(600, 'jpeg'), 'image/jpeg');
    const p = await call(auto, 'create_project', { name: 'Marks', primaryTool: 'image' });
    const s = await state(p.projectId);
    const canvas = Object.values(s.nodes).find((n) => n.type === 'canvas')!;
    await call(auto, 'image_add_layer', { projectId: p.projectId, canvasId: canvas.id, kind: 'raster', assetId: b.asset.id });
    const found = await call(auto, 'list_assets', { query: 'mark landscape' });
    expect(found.assets.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(['mark.png', 'mark-copy.jpg']));
    const sim = await call(approve, 'find_similar_assets', {});
    const group = sim.groups.find((g: { id: string }[]) => g.some((x) => x.id === b.asset.id));
    expect(group.map((x: { id: string }) => x.id)).toContain(a.asset.id);
    const merged = await call(approve, 'merge_assets', { keep: a.asset.id, drop: [b.asset.id] });
    expect(merged.projects).toEqual([expect.objectContaining({ projectId: p.projectId, status: 'proposed' })]);
    // Until the proposal is accepted the copy stays where it is.
    expect(merged.merged).toEqual([]);
    expect(assetRefs(await state(p.projectId)).has(b.asset.id)).toBe(true);
  });
});
