import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectState, nodesOfType, type ProjectState, type SceneNode } from '@omnix/core';
import { createProjectStore } from '../src/state/project.js';
import { realtime } from '../src/state/realtime.js';

/** Deliver a message as if it came from the server. */
const serverSays = (msg: unknown) => (realtime as unknown as { emit(m: unknown): void }).emit(msg);
const sent = () => (realtime as unknown as { queue: string[] }).queue.map((s) => JSON.parse(s) as { type: string; clientOpId?: string });

function mockServer(state: ProjectState) {
  const meta = { id: 'p1', name: 'Test', primaryTool: 'image', ownerId: 'u1', members: [], role: 'owner', aiConsent: false, archived: false, updatedAt: '', createdAt: '', thumbnailVersion: 0 };
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    if (String(url) === '/api/projects/p1') return new Response(JSON.stringify({ project: meta, state, head: 'c0', proposals: [], snapshots: [] }), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

describe('project store: optimistic edits, confirmation and crash recovery', () => {
  let base: ProjectState;
  let canvas: SceneNode<'canvas'>;
  beforeEach(() => {
    localStorage.clear();
    (realtime as unknown as { queue: string[] }).queue.length = 0;
    base = createProjectState({ id: 'p1', primaryTool: 'image' });
    canvas = nodesOfType(base, 'canvas')[0]!;
    mockServer(base);
  });

  it('shows an edit immediately, persists it, and clears it when the server confirms', async () => {
    const store = createProjectStore('p1');
    await store.getState().load();
    expect(store.getState().status).toBe('ready');
    const op = { kind: 'update' as const, id: canvas.id, set: { name: 'Renamed' } };
    const id = store.getState().commit(op, 'Rename');
    expect(id).toBeTruthy();
    expect((store.getState().state!.nodes[canvas.id] as SceneNode<'canvas'>).props.name).toBe('Renamed');
    expect(store.getState().pending).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('omnix.pending.p1')!)).toHaveLength(1);
    expect(sent().some((m) => m.type === 'commit' && m.clientOpId === id)).toBe(true);

    serverSays({ type: 'commit', projectId: 'p1', clientOpId: id, commit: { id: 'c1', parentId: 'c0', op } });
    expect(store.getState().pending).toHaveLength(0);
    expect(store.getState().head).toBe('c1');
    expect((store.getState().confirmed!.nodes[canvas.id] as SceneNode<'canvas'>).props.name).toBe('Renamed');
    expect(localStorage.getItem('omnix.pending.p1')).toBeNull();
    store.getState().dispose();
  });

  it('rolls back an edit the server rejects', async () => {
    const store = createProjectStore('p1');
    await store.getState().load();
    const id = store.getState().commit({ kind: 'update', id: canvas.id, set: { name: 'Nope' } });
    serverSays({ type: 'nack', clientOpId: id, error: 'Not allowed' });
    expect(store.getState().pending).toHaveLength(0);
    expect((store.getState().state!.nodes[canvas.id] as SceneNode<'canvas'>).props.name).not.toBe('Nope');
    store.getState().dispose();
  });

  it('refuses edits that cannot apply locally', async () => {
    const store = createProjectStore('p1');
    await store.getState().load();
    expect(store.getState().commit({ kind: 'delete', id: 'missing' })).toBeNull();
    expect(store.getState().pending).toHaveLength(0);
    store.getState().dispose();
  });

  it('recovers unsent edits after a crash and sends them again', async () => {
    const op = { kind: 'update', id: canvas.id, set: { name: 'Recovered' } };
    localStorage.setItem('omnix.pending.p1', JSON.stringify([{ clientOpId: 'op_lost', op, sentAt: 1 }]));
    const store = createProjectStore('p1');
    await store.getState().load();
    expect((store.getState().state!.nodes[canvas.id] as SceneNode<'canvas'>).props.name).toBe('Recovered');
    expect(sent().filter((m) => m.clientOpId === 'op_lost')).toHaveLength(1);
    store.getState().dispose();
  });

  it('turns live slider changes into a single committed edit', async () => {
    const store = createProjectStore('p1');
    await store.getState().load();
    const s = store.getState();
    s.setTransient(canvas.id, { width: 100 });
    s.setTransient(canvas.id, { width: 200 });
    expect((store.getState().state!.nodes[canvas.id] as SceneNode<'canvas'>).props.width).toBe(200);
    expect(store.getState().pending).toHaveLength(0);
    store.getState().commitTransient('Resize');
    expect(store.getState().pending).toHaveLength(1);
    expect(store.getState().transient).toEqual({});
    expect(store.getState().pending[0]!.op).toEqual({ kind: 'update', id: canvas.id, set: { width: 200 } });
    store.getState().dispose();
  });

  it('resolves flushed() once pending edits are confirmed', async () => {
    const store = createProjectStore('p1');
    await store.getState().load();
    const op = { kind: 'update' as const, id: canvas.id, set: { name: 'X' } };
    const id = store.getState().commit(op);
    const done = store.getState().flushed(2000);
    serverSays({ type: 'commit', projectId: 'p1', clientOpId: id, commit: { id: 'c1', parentId: 'c0', op } });
    await expect(done).resolves.toBe(true);
    store.getState().dispose();
  });
});
