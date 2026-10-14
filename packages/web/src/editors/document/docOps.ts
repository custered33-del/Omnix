import type { BlockProps, BlockType, Operation, ProjectState, SceneNode } from '@omnix/core';
import { documentBlocks, documentSuggestions, inlineToPlain, makeNode, markdownToBlocks, suggestOp } from '@omnix/core';
import type { ProjectStore } from '../../state/project.js';
import type { makeTextCommitter } from '../../state/textCommitter.js';
import { currentAuthor } from '../../components/Comments.js';

export const TEXT_BLOCKS: ReadonlySet<BlockType> = new Set(['heading', 'paragraph', 'bullet', 'numbered', 'todo', 'quote']);
export const LIST_BLOCKS: ReadonlySet<BlockType> = new Set(['bullet', 'numbered', 'todo']);

export interface DocCtx {
  store: ProjectStore;
  docId: string;
  text: ReturnType<typeof makeTextCommitter>;
  /** Focus a block after the next render ('end', 'start' or a plain-text offset). */
  focus(blockId: string, where?: 'start' | 'end' | number): void;
  suggesting: boolean;
}

const st = (c: DocCtx): ProjectState => c.store.getState().state!;
const blocks = (c: DocCtx) => documentBlocks(st(c), c.docId);

/** Block type changes from the style menu ("Heading 1", "Bullet list", …). */
export interface TurnInto {
  blockType: BlockType;
  level?: number;
}

export function turnInto(c: DocCtx, id: string, to: TurnInto): void {
  c.text.flush(id);
  const b = st(c).nodes[id] as SceneNode<'block'>;
  const set: Partial<BlockProps> = { blockType: to.blockType };
  if (to.blockType === 'heading') set.level = to.level ?? 1;
  else if (!LIST_BLOCKS.has(to.blockType)) set.level = undefined;
  if (to.blockType === 'todo' && b.props.checked === undefined) set.checked = false;
  if (to.blockType === 'code') set.text = inlineToPlain(b.props.text);
  const unset = Object.entries(set)
    .filter(([, v]) => v === undefined)
    .map(([k]) => k);
  const clean = Object.fromEntries(Object.entries(set).filter(([, v]) => v !== undefined));
  c.store.getState().commit({ kind: 'update', id, set: clean, ...(unset.length ? { unset } : {}) }, `Turn into ${to.blockType}`);
  c.focus(id, 'end');
}

/** Split a block at the caret: the current block keeps `before`, a new block gets `after`. */
export function splitBlock(c: DocCtx, id: string, before: string, after: string): void {
  const b = st(c).nodes[id] as SceneNode<'block'>;
  const p = b.props;
  // Enter on an empty list item leaves the list, like every word processor.
  if (LIST_BLOCKS.has(p.blockType) && !before.trim() && !after.trim()) {
    c.text.discard(id);
    c.store.getState().commit({ kind: 'update', id, set: { blockType: 'paragraph', text: '' }, unset: ['level'] }, 'End list');
    c.focus(id, 'start');
    return;
  }
  const nextType: BlockType = LIST_BLOCKS.has(p.blockType) ? p.blockType : p.blockType === 'quote' && after ? 'quote' : 'paragraph';
  const node = makeNode('block', { blockType: nextType, text: after, ...(LIST_BLOCKS.has(nextType) && p.level ? { level: p.level } : {}), ...(nextType === 'todo' ? { checked: false } : {}) });
  const doc = st(c).nodes[c.docId]!;
  c.text.discard(id);
  c.store.getState().commit(
    {
      kind: 'batch',
      ops: [
        { kind: 'update', id, set: { text: before } },
        { kind: 'create', parentId: c.docId, index: doc.children.indexOf(id) + 1, nodes: [node] },
      ],
    },
    'New paragraph',
  );
  c.focus(node.id, 'start');
}

/** Merge a block into the previous text block (Backspace at the start). */
export function mergeWithPrevious(c: DocCtx, id: string, currentText: string): boolean {
  const list = blocks(c);
  const i = list.findIndex((b) => b.id === id);
  const prev = list[i - 1];
  if (!prev) return false;
  if (!TEXT_BLOCKS.has(prev.props.blockType)) {
    if (!currentText.trim()) {
      c.text.discard(id);
      c.store.getState().commit({ kind: 'delete', id }, 'Delete paragraph');
      c.focus(prev.id, 'end');
      return true;
    }
    return false;
  }
  c.text.flush(prev.id);
  c.text.discard(id);
  const joinAt = inlineToPlain(prev.props.text).length;
  c.store.getState().commit({ kind: 'batch', ops: [{ kind: 'update', id: prev.id, set: { text: prev.props.text + currentText } }, { kind: 'delete', id }] }, 'Join paragraphs');
  c.focus(prev.id, joinAt);
  return true;
}

/** Merge the next text block into this one (Delete at the end). */
export function mergeNext(c: DocCtx, id: string, currentText: string): boolean {
  const list = blocks(c);
  const i = list.findIndex((b) => b.id === id);
  const next = list[i + 1];
  if (!next || !TEXT_BLOCKS.has(next.props.blockType)) return false;
  c.text.discard(id);
  c.text.flush(next.id);
  const joinAt = inlineToPlain(currentText).length;
  c.store.getState().commit({ kind: 'batch', ops: [{ kind: 'update', id, set: { text: currentText + next.props.text } }, { kind: 'delete', id: next.id }] }, 'Join paragraphs');
  c.focus(id, joinAt);
  return true;
}

export function moveBlock(c: DocCtx, id: string, delta: -1 | 1): void {
  const doc = st(c).nodes[c.docId]!;
  const i = doc.children.indexOf(id);
  const j = i + delta;
  if (j < 0 || j >= doc.children.length) return;
  c.text.flush(id);
  c.store.getState().commit({ kind: 'move', id, parentId: c.docId, index: j }, 'Move block');
  c.focus(id, 'end');
}

export function indent(c: DocCtx, id: string, delta: 1 | -1): void {
  const b = st(c).nodes[id] as SceneNode<'block'>;
  if (!LIST_BLOCKS.has(b.props.blockType)) return;
  const level = Math.min(4, Math.max(0, (b.props.level ?? 0) + delta));
  if (level === (b.props.level ?? 0)) return;
  c.text.flush(id);
  c.store.getState().commit({ kind: 'update', id, set: { level } }, delta > 0 ? 'Indent' : 'Outdent');
  c.focus(id, 'end');
}

/** Insert new blocks after `afterId` (or replace it when it is an empty paragraph). */
export function insertAfter(c: DocCtx, afterId: string | null, items: Partial<BlockProps>[], label = 'Insert', options: { replace?: boolean } = {}): string[] {
  const doc = st(c).nodes[c.docId]!;
  const after = afterId ? (st(c).nodes[afterId] as SceneNode<'block'> | undefined) : undefined;
  if (after && options.replace) c.text.discard(after.id);
  // Replace the block when asked (slash commands) or when it is an empty paragraph.
  const replaceEmpty = after && (options.replace || (after.props.blockType === 'paragraph' && !after.props.text.trim() && !c.text.isPending(after.id)));
  const nodes = items.map((p) => makeNode('block', p));
  let index = afterId ? doc.children.indexOf(afterId) + 1 : doc.children.length;
  const ops: Operation[] = [];
  if (replaceEmpty) {
    ops.push({ kind: 'delete', id: after.id });
    index -= 1;
  }
  nodes.forEach((n, k) => ops.push({ kind: 'create', parentId: c.docId, index: index + k, nodes: [n] }));
  c.store.getState().commit(ops.length === 1 ? ops[0]! : { kind: 'batch', ops }, label);
  return nodes.map((n) => n.id);
}

/** Paste multi-line text or markdown as blocks. */
export function pasteMarkdown(c: DocCtx, afterId: string, text: string): void {
  const parsed = markdownToBlocks(text);
  if (!parsed.length) return;
  const ids = insertAfter(c, afterId, parsed, 'Paste');
  c.focus(ids[ids.length - 1]!, 'end');
}

/** Markdown shortcuts typed at the start of a paragraph ("# ", "- ", "1. ", "[] ", "> "). */
export function shortcutFor(plain: string): { to: TurnInto; strip: number } | null {
  const m = /^(#{1,3}|[-*+]|1[.)]|\[\]|\[ \]|>)\s/.exec(plain);
  if (!m) return null;
  const k = m[1]!;
  const strip = m[0].length;
  if (k.startsWith('#')) return { to: { blockType: 'heading', level: k.length }, strip };
  if (k === '>') return { to: { blockType: 'quote' }, strip };
  if (k.startsWith('[')) return { to: { blockType: 'todo' }, strip };
  if (/^1/.test(k)) return { to: { blockType: 'numbered' }, strip };
  return { to: { blockType: 'bullet' }, strip };
}

/* ---------------- suggesting mode ---------------- */

/** My open replace suggestion for a block, if any. */
export function mySuggestion(state: ProjectState, docId: string, blockId: string, kind: 'replace' | 'insert-after' = 'replace'): SceneNode<'suggestion'> | undefined {
  const me = currentAuthor().id;
  return documentSuggestions(state, docId, 'open').find((s) => s.props.blockId === blockId && s.props.kind === kind && s.props.author.id === me);
}

/** Record an edit as a suggestion instead of changing the text. */
export function suggestEdit(c: DocCtx, blockId: string, text: string): void {
  const s = st(c);
  const block = s.nodes[blockId] as SceneNode<'block'>;
  const mine = mySuggestion(s, c.docId, blockId);
  if (mine) {
    if (text === block.props.text) {
      c.text.discard(mine.id);
      c.store.getState().commit({ kind: 'delete', id: mine.id }, 'Withdraw suggestion');
      return;
    }
    c.text.edit(mine.id, 'text', text, 'Edit suggestion');
    return;
  }
  if (text === block.props.text) return;
  const r = suggestOp(s, c.docId, { blockId, kind: 'replace', text }, currentAuthor());
  c.store.getState().commit(r.op, 'Suggest an edit');
}

export function suggestInsert(c: DocCtx, afterBlockId: string): void {
  const r = suggestOp(st(c), c.docId, { blockId: afterBlockId, kind: 'insert-after', text: '' }, currentAuthor());
  c.store.getState().commit(r.op, 'Suggest a new paragraph');
  c.focus(r.id, 'start');
}

export function suggestDelete(c: DocCtx, blockId: string): void {
  const r = suggestOp(st(c), c.docId, { blockId, kind: 'delete' }, currentAuthor());
  c.store.getState().commit(r.op, 'Suggest deleting a paragraph');
}
