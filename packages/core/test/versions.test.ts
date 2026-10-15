import { describe, expect, it } from 'vitest';
import { applyOp, compareVersions, createProjectState, deckSlides, diffWords, documentBlocks, insertBlocksOps, makeNode, newSlideOps, nodesOfType, type Operation, type ProjectState, type SceneNode } from '../src/index.js';

const apply = (s: ProjectState, op: Operation) => applyOp(s, op).state;

describe('word diff', () => {
  it('marks inserted and removed words inside a sentence', () => {
    const runs = diffWords('Revenue grew 12% this quarter.', 'Revenue grew 14% this year.');
    expect(runs.filter((r) => r.kind === 'removed').map((r) => r.text.trim())).toEqual(['12', 'quarter']);
    expect(runs.filter((r) => r.kind === 'added').map((r) => r.text.trim())).toEqual(['14', 'year']);
    expect(runs.map((r) => (r.kind === 'removed' ? '' : r.text)).join('')).toBe('Revenue grew 14% this year.');
  });
});

describe('comparing versions', () => {
  it('shows paragraph edits, additions and removals in a document', () => {
    let s = createProjectState({ primaryTool: 'document' });
    const doc = nodesOfType(s, 'document')[0]!;
    const ins = insertBlocksOps(s, doc.id, null, [
      { blockType: 'heading', level: 1, text: 'Plan' },
      { blockType: 'paragraph', text: 'Revenue grew 12% this quarter.' },
      { blockType: 'paragraph', text: 'Old note to drop.' },
      { blockType: 'paragraph', text: 'We launch in April.' },
    ]);
    s = apply(s, { kind: 'batch', ops: ins.ops });
    const before = s;
    const [, growth, drop] = ins.ids;
    s = apply(s, { kind: 'update', id: growth!, set: { text: 'Revenue grew 14% this quarter.' } });
    s = apply(s, { kind: 'delete', id: drop! });
    s = apply(s, { kind: 'batch', ops: insertBlocksOps(s, doc.id, ins.ids[3], [{ blockType: 'paragraph', text: 'Then Europe in June.' }]).ops });
    const c = compareVersions(before, s, doc.id);
    expect(c.changed).toEqual([doc.id]);
    const d = c.documents[0]!;
    const byStatus = (k: string) => d.blocks!.filter((b) => b.status === k);
    expect(byStatus('changed')[0]!.words!.some((w) => w.kind === 'added' && w.text === '14')).toBe(true);
    expect(byStatus('removed').map((b) => b.before)).toEqual(['Old note to drop.']);
    expect(byStatus('added').map((b) => b.after)).toEqual(['Then Europe in June.']);
    // Removed blocks sit where they used to be.
    expect(d.blocks!.map((b) => b.status).slice(0, 5)).toEqual(['same', 'changed', 'removed', 'same', 'added']);
    expect(d.summary).toMatch(/1 paragraph edited, 1 added, 1 removed/);
    expect(documentBlocks(s, doc.id).length).toBeGreaterThan(0);
  });

  it('shows line diffs for code with context folded', () => {
    let s = createProjectState({ primaryTool: 'code' });
    const ws = nodesOfType(s, 'codeWorkspace')[0]!;
    const long = Array.from({ length: 30 }, (_, i) => `line_${i} = ${i}`).join('\n');
    const f = makeNode('codeFile', { path: 'calc.py', language: 'python', content: long });
    s = apply(s, { kind: 'create', parentId: ws.id, nodes: [f] });
    const before = s;
    s = apply(s, { kind: 'update', id: f.id, set: { content: long.replace('line_15 = 15', 'line_15 = 150') } });
    const extra = makeNode('codeFile', { path: 'new.py', language: 'python', content: 'print(1)\n' });
    s = apply(s, { kind: 'create', parentId: ws.id, nodes: [extra] });
    const d = compareVersions(before, s, ws.id).documents[0]!;
    const calc = d.files!.find((x) => x.path === 'calc.py')!;
    expect(calc).toMatchObject({ status: 'changed', additions: 1, deletions: 1 });
    expect(calc.runs.filter((r) => r.kind === 'skip').map((r) => (r as { count: number }).count)).toEqual([12, 11]);
    expect(d.files!.find((x) => x.path === 'new.py')!.status).toBe('added');
    expect(d.summary).toBe('2 files changed (+2 −1)');
  });

  it('matches slides across versions', () => {
    let s = createProjectState({ primaryTool: 'slides' });
    const deck = nodesOfType(s, 'deck')[0]!;
    const first = deckSlides(s, deck.id)[0]!;
    const added = newSlideOps(s, deck.id, 'title-body', { name: 'Why now' });
    s = apply(s, added.op);
    const before = s;
    const el = makeNode('slideElement', { elementType: 'text', text: 'New', x: 10, y: 10, w: 100, h: 40 } as never);
    s = apply(s, { kind: 'create', parentId: first.id, nodes: [el] });
    s = apply(s, newSlideOps(s, deck.id, 'blank', { name: 'Thanks' }).op);
    const d = compareVersions(before, s, deck.id).documents[0]!;
    expect(d.slides!.map((x) => [x.status, x.indexAfter])).toEqual([
      ['changed', 0],
      ['same', 1],
      ['added', 2],
    ]);
    expect(d.slides![0]!.slideId).toBe(first.id);
    expect(compareVersions(before, before).changed).toEqual([]);
    expect(added.slideId).toBe(d.slides![1]!.slideId);
  });
});
