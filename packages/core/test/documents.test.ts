import { describe, expect, it } from 'vitest';
import {
  acceptSuggestionOp,
  applyLayoutOps,
  applyOp,
  createProjectState,
  deckSlides,
  documentBlocks,
  documentOutline,
  documentPlainText,
  duplicateSlideOps,
  insertBlocksOps,
  listNumber,
  markdownToBlocks,
  newSlideOps,
  nodesOfType,
  rehearsalTotal,
  rejectSuggestionOp,
  slideElements,
  suggestOp,
  wordCount,
  deckDependencies,
  makeNode,
  parseInline,
  spansToInline,
  type Operation,
  type ProjectState,
  type SceneNode,
} from '../src/index.js';

const claude = { type: 'ai' as const, id: 'claude', name: 'Claude' };
const apply = (s: ProjectState, op: Operation) => applyOp(s, op).state;

function docState() {
  let state = createProjectState({ primaryTool: 'document', name: 'Report' });
  const doc = nodesOfType(state, 'document')[0]!;
  const { ops } = insertBlocksOps(state, doc.id, undefined, markdownToBlocks('## Results\n\nSales grew **12%**.\n\n1. One\n2. Two\n\n- aside\n\n1. Again'));
  for (const op of ops) state = apply(state, op);
  return { state, docId: doc.id };
}

describe('documents', () => {
  it('builds an outline and plain text from blocks', () => {
    const { state, docId } = docState();
    expect(documentOutline(state, docId).map((o) => [o.level, o.text])).toEqual([
      [1, 'Report'],
      [2, 'Results'],
    ]);
    expect(documentPlainText(state, docId)).toContain('Sales grew 12%.');
    expect(wordCount('Sales grew 12% in Q3, it’s great')).toBe(7);
  });

  it('numbers lists and restarts after other blocks', () => {
    const { state, docId } = docState();
    const blocks = documentBlocks(state, docId).map((b) => b.props);
    const numbered = blocks.map((b, i) => (b.blockType === 'numbered' ? listNumber(blocks, i) : null)).filter((n) => n !== null);
    expect(numbered).toEqual([1, 2, 1]);
  });

  it('inserts blocks at the start, after a block, or at the end', () => {
    const { state, docId } = docState();
    const first = documentBlocks(state, docId)[0]!;
    const r = insertBlocksOps(state, docId, first.id, [{ blockType: 'paragraph', text: 'Inserted' }]);
    const s2 = apply(state, { kind: 'batch', ops: r.ops });
    expect(documentBlocks(s2, docId)[1]!.props.text).toBe('Inserted');
    const r2 = insertBlocksOps(s2, docId, null, [{ blockType: 'paragraph', text: 'Top' }]);
    expect(documentBlocks(apply(s2, { kind: 'batch', ops: r2.ops }), docId)[0]!.props.text).toBe('Top');
  });

  it('proposes, accepts and rejects suggested edits atomically', () => {
    let { state, docId } = docState();
    const target = documentBlocks(state, docId).find((b) => b.props.text.startsWith('Sales'))!;
    const s1 = suggestOp(state, docId, { blockId: target.id, kind: 'replace', text: 'Sales grew **14%** after the correction.' }, claude);
    state = apply(state, s1.op);
    // A suggestion changes nothing until accepted.
    expect((state.nodes[target.id] as SceneNode<'block'>).props.text).toBe('Sales grew **12%**.');
    const accept = acceptSuggestionOp(state, s1.id);
    const accepted = applyOp(state, accept);
    state = accepted.state;
    expect((state.nodes[target.id] as SceneNode<'block'>).props.text).toContain('14%');
    expect((state.nodes[s1.id] as SceneNode<'suggestion'>).props.status).toBe('accepted');
    // The inverse undoes both the text change and the status, in one step.
    const undone = applyOp(state, accepted.inverse).state;
    expect((undone.nodes[target.id] as SceneNode<'block'>).props.text).toBe('Sales grew **12%**.');
    expect((undone.nodes[s1.id] as SceneNode<'suggestion'>).props.status).toBe('open');

    const s2 = suggestOp(state, docId, { blockId: target.id, kind: 'insert-after', text: 'A new paragraph.' }, claude);
    state = apply(state, s2.op);
    state = apply(state, acceptSuggestionOp(state, s2.id));
    const order = documentBlocks(state, docId).map((b) => b.props.text);
    expect(order[order.indexOf('Sales grew **14%** after the correction.') + 1]).toBe('A new paragraph.');

    const s3 = suggestOp(state, docId, { blockId: target.id, kind: 'delete' }, claude);
    state = apply(state, s3.op);
    state = apply(state, rejectSuggestionOp(state, s3.id, 'Keep it'));
    expect(state.nodes[target.id]).toBeDefined();
    expect((state.nodes[s3.id] as SceneNode<'suggestion'>).props.reason).toBe('Keep it');
    expect(() => acceptSuggestionOp(state, s3.id)).toThrow(/already resolved/);
  });

  it('accepts a suggestion with a modified text, and refuses one whose block is gone', () => {
    let { state, docId } = docState();
    const target = documentBlocks(state, docId)[1]!;
    const s = suggestOp(state, docId, { blockId: target.id, kind: 'replace', text: 'Draft' }, claude);
    state = apply(state, s.op);
    const withEdit = apply(state, acceptSuggestionOp(state, s.id, { text: 'Edited by a human' }));
    expect((withEdit.nodes[target.id] as SceneNode<'block'>).props.text).toBe('Edited by a human');
    const gone = apply(state, { kind: 'delete', id: target.id });
    expect(() => acceptSuggestionOp(gone, s.id)).toThrow(/deleted/);
  });
});

describe('slideshows', () => {
  it('creates slides from layouts with placeholders at master positions', () => {
    let state = createProjectState({ primaryTool: 'slides', name: 'Pitch' });
    const deck = nodesOfType(state, 'deck')[0]!;
    const r = newSlideOps(state, deck.id, 'two-column', { text: { title: 'Market' } });
    state = apply(state, r.op);
    const els = slideElements(state, r.slideId).map((e) => e.props);
    expect(els.map((e) => e.role)).toEqual(['title', 'body', 'image']);
    expect(els[0]!.text).toBe('Market');
    expect(els[1]!.x).toBe(Math.round(0.06 * 1920));
    expect(deckSlides(state, deck.id)).toHaveLength(2);
  });

  it('re-lays out a slide and duplicates slides with their elements', () => {
    let state = createProjectState({ primaryTool: 'slides', name: 'Pitch' });
    const deck = nodesOfType(state, 'deck')[0]!;
    const r = newSlideOps(state, deck.id, 'title-body');
    state = apply(state, r.op);
    state = apply(state, applyLayoutOps(state, r.slideId, 'two-column'));
    const els = slideElements(state, r.slideId);
    expect(els.map((e) => e.props.role)).toEqual(['title', 'body', 'image']);
    expect(els[1]!.props.w).toBe(Math.round(0.42 * 1920));
    const d = duplicateSlideOps(state, r.slideId);
    state = apply(state, d.op);
    expect(deckSlides(state, deck.id).map((s) => s.id).indexOf(d.slideId)).toBe(2);
    expect(slideElements(state, d.slideId)).toHaveLength(3);
    expect(slideElements(state, d.slideId)[0]!.id).not.toBe(els[0]!.id);
  });

  it('totals rehearsal time over visible slides', () => {
    let state = createProjectState({ primaryTool: 'slides', name: 'Pitch' });
    const deck = nodesOfType(state, 'deck')[0]!;
    expect(rehearsalTotal(state, deck.id)).toBeNull();
    const [first] = deckSlides(state, deck.id);
    const r = newSlideOps(state, deck.id, 'blank');
    state = apply(state, r.op);
    state = apply(state, { kind: 'batch', ops: [{ kind: 'update', id: first!.id, set: { rehearsalSeconds: 30 } }, { kind: 'update', id: r.slideId, set: { rehearsalSeconds: 45, hidden: true } }] });
    expect(rehearsalTotal(state, deck.id)).toBe(30);
  });

  it('follows live links to find everything a shared deck needs', () => {
    let state = createProjectState({ primaryTool: 'slides', name: 'Pitch' });
    const deck = nodesOfType(state, 'deck')[0]!;
    const canvas = makeNode('canvas', { name: 'Poster' });
    const pic = makeNode('layer', { name: 'Pic', layerType: 'raster', assetId: 'asset-poster' });
    pic.parentId = canvas.id;
    canvas.children = [pic.id];
    const unrelated = makeNode('canvas', { name: 'Private' });
    const secret = makeNode('layer', { name: 'Secret', layerType: 'raster', assetId: 'asset-secret' });
    secret.parentId = unrelated.id;
    unrelated.children = [secret.id];
    state = apply(state, { kind: 'create', parentId: state.rootId, nodes: [canvas, pic] });
    state = apply(state, { kind: 'create', parentId: state.rootId, nodes: [unrelated, secret] });
    const slide = deckSlides(state, deck.id)[0]!;
    state = apply(state, { kind: 'create', parentId: slide.id, nodes: [makeNode('slideElement', { elementType: 'embed', embed: { kind: 'canvas', ref: canvas.id } })] });
    state = apply(state, { kind: 'create', parentId: slide.id, nodes: [makeNode('slideElement', { elementType: 'image', assetId: 'asset-photo' })] });
    const deps = deckDependencies(state, deck.id);
    expect(deps.nodeIds.has(canvas.id)).toBe(true);
    expect(deps.nodeIds.has(pic.id)).toBe(true);
    expect(deps.nodeIds.has(unrelated.id)).toBe(false);
    expect([...deps.assetIds].sort()).toEqual(['asset-photo', 'asset-poster']);
    expect(deps.embedRoots).toEqual([{ id: canvas.id }]);
  });
});

describe('inline markdown', () => {
  it('turns styled spans back into markdown that parses to the same spans', () => {
    for (const src of ['Hello **Seb**', '**a *b***', '***b* a**', '[**x** y](https://e.com/a)', '`co*de`', '~~gone~~ 2\\*3', 'x\\_y \\[z\\]']) {
      const spans = parseInline(src);
      expect(parseInline(spansToInline(spans)), src).toEqual(spans);
    }
  });

  it('keeps spaces outside markers and escapes literal characters', () => {
    expect(spansToInline([{ text: 'a ' }, { text: 'bold ', bold: true }, { text: 'end' }])).toBe('a **bold** end');
    expect(spansToInline([{ text: '2*3 [x]' }])).toBe('2\\*3 \\[x\\]');
    expect(spansToInline([{ text: 'see', link: 'https://e.com/a b(c)' }])).toBe('[see](https://e.com/a%20b%28c%29)');
  });
});
