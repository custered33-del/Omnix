import { describe, expect, it } from 'vitest';
import { commentLineOps, commentsContainer, createProjectState, diffLines, makeNode, mapTextOffset, mergeText, primaryDocumentNodes, remapLine, applyOp, textHunks, type ProjectState, type SceneNode } from '../src/index.js';

describe('line diff', () => {
  it('reports kept, removed and added runs in order', () => {
    const runs = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne');
    expect(runs.map((r) => [r.kind, r.lines.join('|')])).toEqual([
      ['same', 'a'],
      ['removed', 'b'],
      ['added', 'B'],
      ['same', 'c|d'],
      ['added', 'e'],
    ]);
  });

  it('handles identical, empty and fully different texts', () => {
    expect(diffLines('x\ny', 'x\ny')).toEqual([{ kind: 'same', lines: ['x', 'y'], aStart: 0, bStart: 0 }]);
    expect(diffLines('', 'one').map((r) => r.kind)).toEqual(['removed', 'added']);
    const big = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const changed = big.replace('line 150', 'LINE 150');
    const runs = diffLines(big, changed);
    expect(runs.filter((r) => r.kind !== 'same').map((r) => r.lines)).toEqual([['line 150'], ['LINE 150']]);
  });

  it('maps lines through insertions and deletions', () => {
    const before = 'import os\n\ndef main():\n    print("hi")\n';
    const after = '# header\nimport os\nimport sys\n\ndef main():\n    print("hi")\n';
    expect(remapLine(before, after, 4)).toBe(6);
    expect(remapLine(before, after, 1)).toBe(2);
    // A deleted line maps to whatever stands in its place now.
    expect(remapLine('a\nb\nc', 'a\nc', 2)).toBe(2);
    expect(remapLine('a\nb\nc', 'a', 3)).toBe(1);
  });
});

describe('line comments follow their code', () => {
  it('produces anchor updates only for comments that move', () => {
    let state: ProjectState = createProjectState({ name: 'p', primaryTool: 'code', withPrimaryDocument: false });
    const nodes = primaryDocumentNodes('code', 'Work');
    nodes[0]!.parentId = state.rootId;
    state = applyOp(state, { kind: 'create', parentId: state.rootId, nodes }).state;
    const ws = nodes[0]!;
    const file = makeNode('codeFile', { path: 'a.py', language: 'python', content: 'x = 1\ny = 2\nz = 3\n' });
    state = applyOp(state, { kind: 'create', parentId: ws.id, nodes: [file] }).state;
    const mk = (line: number) => makeNode('comment', { anchor: { tool: 'code', nodeId: file.id, line }, text: `on ${line}`, author: { type: 'human', id: 'u', name: 'Seb' }, createdAt: new Date().toISOString(), resolved: false, replies: [] });
    const c1 = mk(1);
    const c3 = mk(3);
    for (const c of [c1, c3]) state = applyOp(state, { kind: 'create', parentId: commentsContainer(state).id, nodes: [c] }).state;
    const ops = commentLineOps(state, file.id, 'x = 1\ny = 2\nz = 3\n', 'x = 1\n# note\ny = 2\nz = 3\n');
    expect(ops).toHaveLength(1);
    state = applyOp(state, ops[0]!).state;
    expect((state.nodes[c3.id] as SceneNode<'comment'>).props.anchor.line).toBe(4);
    expect((state.nodes[c1.id] as SceneNode<'comment'>).props.anchor.line).toBe(1);
    expect(commentLineOps(state, file.id, 'same', 'same')).toEqual([]);
  });
});

describe('merging two edits of one text', () => {
  it('keeps both people\'s typing when they change different parts', () => {
    const base = 'The lamp is bright.';
    expect(mergeText(base, 'The new lamp is bright.', 'The lamp is very bright.')).toBe('The new lamp is very bright.');
    expect(mergeText(base, 'The lamp is bright. Buy it.', 'Aurora: The lamp is bright.')).toBe('Aurora: The lamp is bright. Buy it.');
    // One deletes a word, the other adds one elsewhere.
    expect(mergeText('one two three four', 'one three four', 'one two three four five')).toBe('one three four five');
  });

  it('keeps both insertions at the same place, and prefers mine where both changed the same words', () => {
    expect(mergeText('Hello.', 'Hello. Mine.', 'Hello. Theirs.')).toBe('Hello. Theirs. Mine.');
    expect(mergeText('the red lamp', 'the blue lamp', 'the green lamp')).toBe('the blue lamp');
    // The same change made twice is applied once.
    expect(mergeText('hello', 'hello world', 'hello world')).toBe('hello world');
    expect(mergeText('x', 'x', 'y')).toBe('y');
    expect(mergeText('x', 'y', 'x')).toBe('y');
  });

  it('never splits characters made of two code units', () => {
    const merged = mergeText('a😀b', 'a😀😀b', 'a😁b');
    expect([...merged].every((ch) => ch.length === 1 || /\p{Extended_Pictographic}/u.test(ch))).toBe(true);
    expect(textHunks('😀', '😁')).toEqual([{ start: 0, end: 2, text: '😁' }]);
  });

  it('maps a caret across an outside change', () => {
    expect(mapTextOffset('hello world', 'oh hello world', 6)).toBe(9);
    expect(mapTextOffset('hello world', 'hello world!', 6)).toBe(6);
    expect(mapTextOffset('hello big world', 'hello world', 8)).toBe(6);
  });

  it('merges concurrent updates that carry the text they were written over, and undoes only their own part', () => {
    let state: ProjectState = createProjectState({ name: 'p', primaryTool: 'code', withPrimaryDocument: false });
    const nodes = primaryDocumentNodes('code', 'Work');
    nodes[0]!.parentId = state.rootId;
    state = applyOp(state, { kind: 'create', parentId: state.rootId, nodes }).state;
    const file = makeNode('codeFile', { path: 'a.py', language: 'python', content: 'x = 1\ny = 2\n' });
    state = applyOp(state, { kind: 'create', parentId: nodes[0]!.id, nodes: [file] }).state;
    const base = 'x = 1\ny = 2\n';
    // Two people type from the same starting text; the second update lands on the first.
    const a = applyOp(state, { kind: 'update', id: file.id, set: { content: 'x = 10\ny = 2\n' }, base: { content: base } });
    const b = applyOp(a.state, { kind: 'update', id: file.id, set: { content: 'x = 1\ny = 2\nz = 3\n' }, base: { content: base } });
    const content = (s: ProjectState) => (s.nodes[file.id] as SceneNode<'codeFile'>).props.content;
    expect(content(b.state)).toBe('x = 10\ny = 2\nz = 3\n');
    // Undoing the first person's edit after the second keeps the second person's line.
    const undoA = applyOp(b.state, a.inverse);
    expect(content(undoA.state)).toBe('x = 1\ny = 2\nz = 3\n');
    // Without a base an update still replaces the value outright.
    expect(content(applyOp(b.state, { kind: 'update', id: file.id, set: { content: 'new' } }).state)).toBe('new');
  });
});
