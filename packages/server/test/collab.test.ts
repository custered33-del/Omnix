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
