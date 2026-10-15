import { describe, expect, it, beforeEach } from 'vitest';
import {
  ProjectSession,
  createProjectState,
  makeNode,
  nodesOfType,
  layerProps,
  setDeterministicIds,
  diffStates,
  OpError,
  aiMarks,
  applyCommitMarks,
  changedNodeIds,
  type Author,
  type SessionEvent,
} from '../src/index.js';

const seb: Author = { type: 'human', id: 'u_seb', name: 'Seb' };
const claude: Author = { type: 'ai', id: 'ai_claude', name: 'Claude' };

function session() {
  const state = createProjectState({ name: 'P', primaryTool: 'image' });
  const canvasId = nodesOfType(state, 'canvas')[0]!.id;
  return { s: new ProjectSession(state), canvasId };
}

function addLayer(s: ProjectSession, canvasId: string, name: string, author: Author) {
  const l = makeNode('layer', layerProps('fill', { name }));
  s.commit({ kind: 'create', parentId: canvasId, nodes: [l] }, { author });
  return l.id;
}

beforeEach(() => setDeterministicIds(5000));

describe('ProjectSession commits', () => {
  it('records attributed commits with readable labels', () => {
    const { s, canvasId } = session();
    const id = addLayer(s, canvasId, 'Sky', seb);
    const c = s.log()[0]!;
    expect(c.author).toEqual(seb);
    expect(c.label).toBe('Add layer "Sky"');
    expect(s.state.nodes[id]).toBeDefined();
    expect(s.head).toBe(c.id);
  });

  it('leaves the session untouched when an op fails', () => {
    const { s } = session();
    const before = s.state;
    expect(() => s.commit({ kind: 'delete', id: 'nope' }, { author: seb })).toThrow(OpError);
    expect(s.state).toBe(before);
    expect(s.log()).toHaveLength(0);
  });

  it('emits events to subscribers', () => {
    const { s, canvasId } = session();
    const events: SessionEvent[] = [];
    const off = s.subscribe((e) => events.push(e));
    addLayer(s, canvasId, 'A', seb);
    off();
    addLayer(s, canvasId, 'B', seb);
    expect(events.map((e) => e.type)).toEqual(['commit']);
  });
});

describe('selective undo/redo', () => {
  it('undoes and redoes a single author\'s changes', () => {
    const { s, canvasId } = session();
    const a = addLayer(s, canvasId, 'A', seb);
    const b = addLayer(s, canvasId, 'B', seb);
    s.undo(seb);
    expect(s.state.nodes[b]).toBeUndefined();
    expect(s.state.nodes[a]).toBeDefined();
    s.undo(seb);
    expect(s.state.nodes[a]).toBeUndefined();
    s.redo(seb);
    expect(s.state.nodes[a]).toBeDefined();
    s.redo(seb);
    expect(s.state.nodes[b]).toBeDefined();
    expect(s.redo(seb)).toBeNull();
  });

  it('only undoes the requesting author\'s changes in a shared project', () => {
    const { s, canvasId } = session();
    const mine = addLayer(s, canvasId, 'Mine', seb);
    const ai = addLayer(s, canvasId, 'Claude', claude);
    s.undo(seb);
    expect(s.state.nodes[mine]).toBeUndefined();
    expect(s.state.nodes[ai]).toBeDefined();
    s.undo(claude);
    expect(s.state.nodes[ai]).toBeUndefined();
  });

  it('a new change clears the redo stack', () => {
    const { s, canvasId } = session();
    addLayer(s, canvasId, 'A', seb);
    s.undo(seb);
    addLayer(s, canvasId, 'B', seb);
    expect(s.redo(seb)).toBeNull();
  });

  it('redo commits are themselves undoable', () => {
    const { s, canvasId } = session();
    const a = addLayer(s, canvasId, 'A', seb);
    s.undo(seb);
    s.redo(seb);
    s.undo(seb);
    expect(s.state.nodes[a]).toBeUndefined();
    s.redo(seb);
    expect(s.state.nodes[a]).toBeDefined();
  });

  it('history is append-only: undo is a commit', () => {
    const { s, canvasId } = session();
    addLayer(s, canvasId, 'A', seb);
    s.undo(seb);
    const log = s.log();
    expect(log).toHaveLength(2);
    expect(log[1]!.undoOf).toBe(log[0]!.id);
    expect(log[1]!.label).toBe('Undo: Add layer "A"');
  });
});

describe('branching', () => {
  it('checks out an older commit and branches from there', () => {
    const { s, canvasId } = session();
    addLayer(s, canvasId, 'A', seb);
    const first = s.head!;
    const b = addLayer(s, canvasId, 'B', seb);
    const tipB = s.head!;
    s.checkout(first);
    expect(s.state.nodes[b]).toBeUndefined();
    const c = addLayer(s, canvasId, 'C', seb);
    expect(s.branchTips().map((t) => t.id).sort()).toEqual([tipB, s.head!].sort());
    // Switch back to the first branch
    s.checkout(tipB);
    expect(s.state.nodes[b]).toBeDefined();
    expect(s.state.nodes[c]).toBeUndefined();
  });

  it('computes state at any commit without moving head', () => {
    const { s, canvasId } = session();
    const base = s.state;
    addLayer(s, canvasId, 'A', seb);
    const head = s.head;
    expect(diffStates(s.stateAt(null), base).empty).toBe(true);
    expect(s.head).toBe(head);
  });

  it('rebuilds any version across branches exactly as it was committed', () => {
    const { s, canvasId } = session();
    const seen = new Map<string | null, ReturnType<typeof s.stateAt>>([[null, s.state]]);
    s.subscribe((e) => {
      if (e.type === 'commit') seen.set(e.commit.id, e.state);
    });
    const a = addLayer(s, canvasId, 'A', seb);
    for (let i = 0; i < 40; i++) s.commit({ kind: 'update', id: a, set: { opacity: i / 40, name: `A${i}` } }, { author: seb });
    const fork = s.log()[20]!.id;
    const b = addLayer(s, canvasId, 'B', claude);
    s.commit({ kind: 'delete', id: a }, { author: seb });
    s.checkout(fork);
    for (let i = 0; i < 10; i++) s.commit({ kind: 'update', id: a, set: { x: i } }, { author: claude });
    expect(s.state.nodes[b]).toBeUndefined();
    for (const [id, state] of seen) expect(diffStates(s.stateAt(id), state).empty, `version ${id}`).toBe(true);
    // Recently viewed versions come back without being rebuilt.
    expect(s.stateAt(fork)).toBe(s.stateAt(fork));
  });
});

describe('proposals', () => {
  it('previews, then accepts a proposal attributed to the AI and approved by a human', () => {
    const { s, canvasId } = session();
    const l = makeNode('layer', layerProps('text', { name: 'Headline', text: 'Hi' }));
    const p = s.propose([{ kind: 'create', parentId: canvasId, nodes: [l] }], { author: claude, label: 'Add headline' });
    expect(s.state.nodes[l.id]).toBeUndefined();
    const preview = s.previewProposal(p.id);
    expect(preview.diff.added.map((a) => a.id)).toContain(l.id);
    const commit = s.acceptProposal(p.id, seb);
    expect(commit.author).toEqual(claude);
    expect(commit.approvedBy).toEqual(seb);
    expect(commit.proposalId).toBe(p.id);
    expect(s.getProposal(p.id)!.status).toBe('accepted');
    expect(s.state.nodes[l.id]).toBeDefined();
  });

  it('accepts a modified proposal', () => {
    const { s, canvasId } = session();
    const l = makeNode('layer', layerProps('text', { name: 'Headline', text: 'Hi' }));
    const p = s.propose([{ kind: 'create', parentId: canvasId, nodes: [l] }], { author: claude, label: 'Add headline' });
    const modified = structuredClone(p.ops);
    (modified[0] as { nodes: { props: { text: string } }[] }).nodes[0]!.props.text = 'Hello there';
    s.acceptProposal(p.id, seb, modified);
    expect((s.state.nodes[l.id]!.props as { text: string }).text).toBe('Hello there');
  });

  it('rejects proposals and refuses to resolve twice', () => {
    const { s, canvasId } = session();
    const l = makeNode('layer', layerProps('fill'));
    const p = s.propose([{ kind: 'create', parentId: canvasId, nodes: [l] }], { author: claude, label: 'x' });
    s.rejectProposal(p.id, seb, 'Too busy');
    expect(s.getProposal(p.id)!.status).toBe('rejected');
    expect(s.getProposal(p.id)!.reason).toBe('Too busy');
    expect(() => s.acceptProposal(p.id, seb)).toThrow();
  });

  it('marks a proposal as conflicted when the project moved underneath it', () => {
    const { s, canvasId } = session();
    const target = addLayer(s, canvasId, 'T', seb);
    const p = s.propose([{ kind: 'update', id: target, set: { opacity: 0.3 } }], { author: claude, label: 'Fade' });
    s.commit({ kind: 'delete', id: target }, { author: seb });
    expect(() => s.acceptProposal(p.id, seb)).toThrow();
    expect(s.getProposal(p.id)!.status).toBe('conflict');
  });

  it('refuses proposals that do not apply', () => {
    const { s } = session();
    expect(() => s.propose([{ kind: 'delete', id: 'ghost' }], { author: claude, label: 'x' })).toThrow();
  });
});

describe('snapshots and persistence', () => {
  it('diffs snapshots', () => {
    const { s, canvasId } = session();
    const snap1 = s.snapshot('v1', seb);
    const l = addLayer(s, canvasId, 'New', seb);
    const snap2 = s.snapshot('v2', seb);
    const d = s.diffCommits(snap1.commitId, snap2.commitId);
    expect(d.added.map((a) => a.id)).toEqual([l]);
  });

  it('serializes and restores, with and without a cached head state', () => {
    const { s, canvasId } = session();
    addLayer(s, canvasId, 'A', seb);
    addLayer(s, canvasId, 'B', claude);
    s.undo(seb);
    s.snapshot('v', seb);
    const json = JSON.parse(JSON.stringify(s.toJSON()));
    const restored = ProjectSession.fromJSON(json);
    expect(diffStates(restored.state, s.state).empty).toBe(true);
    const noCache = JSON.parse(JSON.stringify(s.toJSON(false)));
    const replayed = ProjectSession.fromJSON(noCache);
    expect(diffStates(replayed.state, s.state).empty).toBe(true);
    expect(replayed.listSnapshots()).toHaveLength(1);
    // Undo still works after restore
    const c = replayed.undo(claude);
    expect(c).not.toBeNull();
  });

  it('ingests commits from another replica', () => {
    const { s, canvasId } = session();
    const replica = ProjectSession.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
    addLayer(s, canvasId, 'A', seb);
    replica.ingest(s.log()[0]!);
    expect(diffStates(replica.state, s.state).empty).toBe(true);
  });
});

describe('AI attribution', () => {
  it('marks what the AI changed last and clears it when a person edits the node', () => {
    const { s, canvasId } = session();
    const a = addLayer(s, canvasId, 'A', claude);
    const b = addLayer(s, canvasId, 'B', seb);
    let marks = aiMarks(s.log());
    expect(Object.keys(marks)).toEqual([a]);
    expect(marks[a]).toMatchObject({ by: 'Claude', authorId: 'ai_claude' });
    // Creating a layer does not mark the canvas it went into.
    expect(marks[canvasId]).toBeUndefined();
    s.commit({ kind: 'update', id: b, set: { opacity: 0.5 } }, { author: claude, label: 'Fade B' });
    marks = aiMarks(s.log());
    expect(marks[b]!.label).toBe('Fade B');
    s.commit({ kind: 'update', id: a, set: { name: 'Mine now' } }, { author: seb });
    marks = aiMarks(s.log());
    expect(marks[a]).toBeUndefined();
    expect(marks[b]).toBeDefined();
    // Incremental folding gives the same answer as a full replay.
    let inc = {};
    for (const c of s.log()) inc = applyCommitMarks(inc, c);
    expect(inc).toEqual(marks);
  });

  it('credits approved proposals to the AI and names the approver', () => {
    const { s, canvasId } = session();
    const l = makeNode('layer', layerProps('fill', { name: 'Glow' }));
    const p = s.propose([{ kind: 'create', parentId: canvasId, nodes: [l] }], { author: claude, label: 'Add glow' });
    s.acceptProposal(p.id, seb);
    expect(aiMarks(s.log())[l.id]).toMatchObject({ by: 'Claude', approvedBy: 'Seb' });
    expect(changedNodeIds({ kind: 'move', id: l.id, parentId: canvasId, index: 0 })).toEqual([l.id]);
  });
});

describe('undo and redo with collaborators', () => {
  const filter = (id: string) => ({ id, filter: 'grayscale' as const, params: {}, enabled: true, opacity: 1 });
  const filters = (s: ProjectSession, layer: string) => ((s.state.nodes[layer]!.props as { filters: { id: string }[] }).filters ?? []).map((f) => f.id);

  it('undo removes the item it added, even after others changed the list', () => {
    const { s, canvasId } = session();
    const layer = addLayer(s, canvasId, 'L', seb);
    s.commit({ kind: 'listInsert', id: layer, prop: 'filters', items: [filter('f0'), filter('f1')] }, { author: claude });
    s.commit({ kind: 'listInsert', id: layer, prop: 'filters', items: [filter('fa')] }, { author: seb });
    s.commit({ kind: 'listRemove', id: layer, prop: 'filters', index: 0, count: 1 }, { author: claude });
    s.commit({ kind: 'listInsert', id: layer, prop: 'filters', items: [filter('fb')] }, { author: claude });
    expect(filters(s, layer)).toEqual(['f1', 'fa', 'fb']);
    s.undo(seb);
    expect(filters(s, layer)).toEqual(['f1', 'fb']);
  });

  it('redo brings back what collaborators added to the change', () => {
    const { s, canvasId } = session();
    const group = makeNode('layer', layerProps('group', { name: 'Group' }));
    s.commit({ kind: 'create', parentId: canvasId, nodes: [group] }, { author: seb });
    const child = makeNode('layer', layerProps('fill', { name: 'Child' }));
    s.commit({ kind: 'create', parentId: group.id, nodes: [child] }, { author: claude });
    s.commit({ kind: 'update', id: group.id, set: { name: 'Renamed' } }, { author: claude });
    s.undo(seb);
    expect(s.state.nodes[group.id]).toBeUndefined();
    s.redo(seb);
    expect(s.state.nodes[child.id]).toBeDefined();
    expect((s.state.nodes[group.id]!.props as { name: string }).name).toBe('Renamed');
  });

  it('undo passes over a change whose target a collaborator deleted', () => {
    const { s, canvasId } = session();
    const a = addLayer(s, canvasId, 'A', seb);
    const b = addLayer(s, canvasId, 'B', seb);
    s.commit({ kind: 'update', id: b, set: { opacity: 0.5 } }, { author: seb });
    s.commit({ kind: 'delete', id: b }, { author: claude });
    // Seb's latest change touched B, which is gone; undo moves on to the one before (creating B... also gone), then A.
    const c = s.undo(seb);
    expect(c).not.toBeNull();
    expect(s.state.nodes[a]).toBeUndefined();
  });

  it('a list update that added a field is undone after a save and reload too', () => {
    const { s, canvasId } = session();
    const layer = addLayer(s, canvasId, 'L', seb);
    s.commit({ kind: 'listInsert', id: layer, prop: 'filters', items: [filter('f')] }, { author: seb });
    s.commit({ kind: 'listUpdate', id: layer, prop: 'filters', itemId: 'f', set: { note: 'added' } }, { author: seb });
    const reloaded = ProjectSession.fromJSON(JSON.parse(JSON.stringify(s.toJSON(false))));
    reloaded.undo(seb);
    const f = (reloaded.state.nodes[layer]!.props as unknown as { filters: Record<string, unknown>[] }).filters[0]!;
    expect('note' in f).toBe(false);
  });
});

describe('malformed changes', () => {
  it('refuses a create whose nodes form a loop instead of a tree', () => {
    const { s, canvasId } = session();
    const r = makeNode('layer', layerProps('group', { name: 'R' }));
    const a = makeNode('layer', layerProps('group', { name: 'A' }));
    const b = makeNode('layer', layerProps('group', { name: 'B' }));
    r.children = [a.id];
    a.parentId = r.id;
    a.children = [b.id];
    b.parentId = a.id;
    b.children = [a.id];
    expect(() => s.commit({ kind: 'create', parentId: canvasId, nodes: [r, a, b] }, { author: seb })).toThrow(OpError);
    expect(s.state.nodes[r.id]).toBeUndefined();
  });
});
