import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyOp,
  applyOps,
  canApply,
  createProjectState,
  makeNode,
  childrenOf,
  nodesOfType,
  OpError,
  setDeterministicIds,
  touchedIds,
  describeOp,
  diffStates,
  type Operation,
  type ProjectState,
  layerProps,
} from '../src/index.js';

function imageProject(): { state: ProjectState; canvasId: string } {
  const state = createProjectState({ name: 'Poster', primaryTool: 'image' });
  const canvas = nodesOfType(state, 'canvas')[0]!;
  return { state, canvasId: canvas.id };
}

beforeEach(() => setDeterministicIds(1000));

describe('applyOp', () => {
  it('creates nodes immutably and returns a delete inverse', () => {
    const { state, canvasId } = imageProject();
    const layer = makeNode('layer', layerProps('text', { text: 'Hello' }));
    const { state: next, inverse } = applyOp(state, { kind: 'create', parentId: canvasId, nodes: [layer] });
    expect(next.nodes[layer.id]?.parentId).toBe(canvasId);
    expect(next.nodes[canvasId]!.children).toContain(layer.id);
    // original untouched
    expect(state.nodes[layer.id]).toBeUndefined();
    expect(state.nodes[canvasId]!.children).not.toContain(layer.id);
    expect(inverse).toEqual({ kind: 'delete', id: layer.id });
    // structural sharing: untouched nodes are the same object
    expect(next.nodes[state.rootId]).toBe(state.nodes[state.rootId]);
  });

  it('round-trips every op kind through its inverse', () => {
    const { state, canvasId } = imageProject();
    const a = makeNode('layer', layerProps('raster', { name: 'A' }));
    const g = makeNode('layer', layerProps('group', { name: 'G' }));
    const ops: Operation[] = [
      { kind: 'create', parentId: canvasId, nodes: [a] },
      { kind: 'create', parentId: canvasId, index: 0, nodes: [g] },
      { kind: 'update', id: a.id, set: { opacity: 0.5, blendMode: 'multiply' }, unset: ['assetId'] },
      { kind: 'move', id: a.id, parentId: g.id },
      { kind: 'listInsert', id: a.id, prop: 'filters', items: [{ id: 'f1', filter: 'gaussianBlur', params: { radius: 4 }, enabled: true, opacity: 1 }] },
      { kind: 'listUpdate', id: a.id, prop: 'filters', itemId: 'f1', set: { enabled: false } },
      { kind: 'listRemove', id: a.id, prop: 'filters', index: 0, count: 1 },
      { kind: 'delete', id: g.id },
    ];
    let s = state;
    const inverses: Operation[] = [];
    const states: ProjectState[] = [s];
    for (const op of ops) {
      const r = applyOp(s, op);
      inverses.push(r.inverse);
      s = r.state;
      states.push(s);
    }
    // After deleting the group, the moved layer is gone too
    expect(s.nodes[a.id]).toBeUndefined();
    for (let i = ops.length - 1; i >= 0; i--) {
      s = applyOp(s, inverses[i]!).state;
      expect(diffStates(s, states[i]!).empty).toBe(true);
    }
  });

  it('batch inverse restores the original state', () => {
    const { state, canvasId } = imageProject();
    const l1 = makeNode('layer', layerProps('fill', { fillColor: '#ff0000' }));
    const l2 = makeNode('layer', layerProps('fill', { fillColor: '#00ff00' }));
    const { state: next, inverse } = applyOps(state, [
      { kind: 'create', parentId: canvasId, nodes: [l1] },
      { kind: 'create', parentId: canvasId, nodes: [l2] },
      { kind: 'update', id: l1.id, set: { name: 'Red' } },
    ]);
    expect(childrenOf(next, canvasId).map((c) => c.id)).toEqual([...state.nodes[canvasId]!.children, l1.id, l2.id]);
    const back = applyOp(next, inverse).state;
    expect(diffStates(back, state).empty).toBe(true);
  });

  it('batches are atomic: a failing op leaves the state untouched', () => {
    const { state, canvasId } = imageProject();
    const l1 = makeNode('layer', layerProps('fill'));
    expect(() =>
      applyOps(state, [
        { kind: 'create', parentId: canvasId, nodes: [l1] },
        { kind: 'update', id: 'missing', set: { name: 'x' } },
      ]),
    ).toThrow(OpError);
    expect(state.nodes[l1.id]).toBeUndefined();
  });

  it('enforces the node hierarchy', () => {
    const { state } = imageProject();
    const clip = makeNode('clip');
    const res = canApply(state, { kind: 'create', parentId: nodesOfType(state, 'canvas')[0]!.id, nodes: [clip] });
    expect(res.ok).toBe(false);
  });

  it('prevents cycles, root deletion and duplicate ids', () => {
    const { state, canvasId } = imageProject();
    const g = makeNode('layer', layerProps('group'));
    const inner = makeNode('layer', layerProps('group'));
    let s = applyOp(state, { kind: 'create', parentId: canvasId, nodes: [g] }).state;
    s = applyOp(s, { kind: 'create', parentId: g.id, nodes: [inner] }).state;
    expect(canApply(s, { kind: 'move', id: g.id, parentId: inner.id }).ok).toBe(false);
    expect(canApply(s, { kind: 'delete', id: s.rootId }).ok).toBe(false);
    expect(canApply(s, { kind: 'create', parentId: canvasId, nodes: [g] }).ok).toBe(false);
  });

  it('creates whole subtrees and deletes them with a restorable inverse', () => {
    const { state, canvasId } = imageProject();
    const g = makeNode('layer', layerProps('group', { name: 'Group' }));
    const c1 = makeNode('layer', layerProps('text', { text: 'one' }));
    const c2 = makeNode('layer', layerProps('text', { text: 'two' }));
    c1.parentId = g.id;
    c2.parentId = g.id;
    g.children = [c1.id, c2.id];
    const s1 = applyOp(state, { kind: 'create', parentId: canvasId, nodes: [g, c1, c2] }).state;
    expect(childrenOf(s1, g.id)).toHaveLength(2);
    const del = applyOp(s1, { kind: 'delete', id: g.id });
    expect(del.state.nodes[c1.id]).toBeUndefined();
    const restored = applyOp(del.state, del.inverse).state;
    expect(diffStates(restored, s1).empty).toBe(true);
  });

  it('rejects malformed subtrees', () => {
    const { state, canvasId } = imageProject();
    const g = makeNode('layer', layerProps('group'));
    const orphan = makeNode('layer', layerProps('text'));
    orphan.parentId = 'nowhere';
    expect(canApply(state, { kind: 'create', parentId: canvasId, nodes: [g, orphan] }).ok).toBe(false);
  });

  it('rejects prototype pollution in updates', () => {
    const { state, canvasId } = imageProject();
    const set = JSON.parse('{"__proto__": {"polluted": true}}');
    expect(canApply(state, { kind: 'update', id: canvasId, set }).ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('reports touched ids and readable descriptions', () => {
    const { state, canvasId } = imageProject();
    const l = makeNode('layer', layerProps('text', { name: 'Title' }));
    const op: Operation = { kind: 'batch', ops: [{ kind: 'create', parentId: canvasId, nodes: [l] }, { kind: 'update', id: l.id, set: { opacity: 0.2 } }] };
    expect(touchedIds(op).sort()).toEqual([canvasId, l.id].sort());
    expect(describeOp({ kind: 'create', parentId: canvasId, nodes: [l] })).toBe('Add layer "Title"');
    const s = applyOp(state, op).state;
    expect(describeOp({ kind: 'update', id: l.id, set: { opacity: 1 } }, s)).toBe('Change opacity on "Title"');
  });

  it('update inverse restores missing keys by unsetting them', () => {
    const { state, canvasId } = imageProject();
    const r = applyOp(state, { kind: 'update', id: canvasId, set: { extra: 1 } });
    expect(r.inverse).toEqual({ kind: 'update', id: canvasId, set: {}, unset: ['extra'] });
    const back = applyOp(r.state, r.inverse).state;
    expect('extra' in (back.nodes[canvasId]!.props as object)).toBe(false);
  });
});
