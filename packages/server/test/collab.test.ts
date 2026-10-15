import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { deckSlides, type ProjectState, type SceneNode } from '@omnix/core';
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
