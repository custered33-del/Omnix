import type { Author } from './types.js';
import type { BlockProps, BlockType, SceneNode } from './nodes.js';
import type { Operation } from './ops.js';
import { OpError } from './ops.js';
import { childrenOf, requireNodeOfType, type ProjectState } from './state.js';
import { makeNode } from './defaults.js';
import { inlineToPlain, type BlockInput } from './markdown.js';

/**
 * Document helpers shared by the editor, exporters and MCP tools: block order, outline,
 * list numbering, style resolution, and suggested edits (propose, accept, reject).
 */

export function documentBlocks(state: ProjectState, docId: string): SceneNode<'block'>[] {
  requireNodeOfType(state, docId, 'document');
  return childrenOf(state, docId).filter((n): n is SceneNode<'block'> => n.type === 'block');
}

export function documentSuggestions(state: ProjectState, docId: string, status?: 'open' | 'accepted' | 'rejected'): SceneNode<'suggestion'>[] {
  return childrenOf(state, docId).filter((n): n is SceneNode<'suggestion'> => n.type === 'suggestion' && (!status || (n as SceneNode<'suggestion'>).props.status === status));
}

export interface OutlineEntry {
  id: string;
  level: number;
  text: string;
}

/** Headings in document order (the outline pane and table of contents). */
export function documentOutline(state: ProjectState, docId: string): OutlineEntry[] {
  return documentBlocks(state, docId)
    .filter((b) => b.props.blockType === 'heading')
    .map((b) => ({ id: b.id, level: b.props.level ?? 1, text: inlineToPlain(b.props.text) }));
}

/** The number shown before a numbered list item (restarts after any other block or a shallower level). */
export function listNumber(blocks: readonly Pick<BlockProps, 'blockType' | 'level'>[], index: number): number {
  const level = blocks[index]?.level ?? 0;
  let n = 1;
  for (let i = index - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.blockType !== 'numbered') break;
    const l = b.level ?? 0;
    if (l < level) break;
    if (l === level) n++;
  }
  return n;
}

/** The style-sheet entry a block uses when it has no explicit style. */
export function defaultStyleFor(b: Pick<BlockProps, 'blockType' | 'level' | 'style'>): string {
  if (b.style) return b.style;
  switch (b.blockType) {
    case 'heading':
      return b.level === 1 ? 'h1' : b.level === 2 ? 'h2' : 'h3';
    case 'quote':
      return 'quote';
    case 'code':
      return 'code';
    default:
      return 'body';
  }
}

/** Ops that insert blocks after `afterId` (or at the start when null, or at the end when undefined). */
export function insertBlocksOps(state: ProjectState, docId: string, afterId: string | null | undefined, blocks: readonly BlockInput[]): { ops: Operation[]; ids: string[] } {
  const doc = requireNodeOfType(state, docId, 'document');
  let index = afterId === undefined ? doc.children.length : afterId === null ? 0 : doc.children.indexOf(afterId) + 1;
  if (afterId && index === 0) throw new OpError(`Block ${afterId} is not in this document`);
  const ops: Operation[] = [];
  const ids: string[] = [];
  for (const b of blocks) {
    const node = makeNode('block', b);
    ids.push(node.id);
    ops.push({ kind: 'create', parentId: docId, index: index++, nodes: [node] });
  }
  return { ops, ids };
}

/* ------------------------------------------------------------------ */
/* Suggested edits                                                     */
/* ------------------------------------------------------------------ */

export interface SuggestInput {
  blockId: string;
  kind: 'replace' | 'insert-after' | 'delete';
  text?: string;
  blockType?: BlockType;
  reason?: string;
}

/** Create a suggestion node. Suggestions never change the text until someone accepts them. */
export function suggestOp(state: ProjectState, docId: string, input: SuggestInput, author: Author): { op: Operation; id: string } {
  const doc = requireNodeOfType(state, docId, 'document');
  const block = state.nodes[input.blockId];
  if (!block || block.type !== 'block' || block.parentId !== doc.id) throw new OpError(`Block ${input.blockId} is not in this document`);
  if (input.kind !== 'delete' && typeof input.text !== 'string') throw new OpError('A replace or insert suggestion needs text');
  const node = makeNode('suggestion', {
    blockId: input.blockId,
    kind: input.kind,
    text: input.text ?? '',
    ...(input.blockType ? { blockType: input.blockType } : {}),
    author,
    createdAt: new Date().toISOString(),
    status: 'open',
    ...(input.reason ? { reason: input.reason } : {}),
  });
  return { op: { kind: 'create', parentId: doc.id, nodes: [node] }, id: node.id };
}

/** Apply a suggestion: change the document and mark the suggestion accepted, as one atomic edit. */
export function acceptSuggestionOp(state: ProjectState, suggestionId: string, override?: { text?: string }): Operation {
  const s = requireNodeOfType(state, suggestionId, 'suggestion');
  if (s.props.status !== 'open') throw new OpError('This suggestion was already resolved');
  const block = state.nodes[s.props.blockId];
  if (!block || block.type !== 'block') throw new OpError('The text this suggestion changes has been deleted');
  const text = override?.text ?? s.props.text;
  const ops: Operation[] = [];
  switch (s.props.kind) {
    case 'replace':
      ops.push({ kind: 'update', id: block.id, set: { text, ...(s.props.blockType ? { blockType: s.props.blockType } : {}) } });
      break;
    case 'insert-after': {
      const doc = state.nodes[block.parentId!]!;
      ops.push({ kind: 'create', parentId: doc.id, index: doc.children.indexOf(block.id) + 1, nodes: [makeNode('block', { blockType: s.props.blockType ?? 'paragraph', text })] });
      break;
    }
    case 'delete':
      ops.push({ kind: 'delete', id: block.id });
      break;
  }
  ops.push({ kind: 'update', id: s.id, set: { status: 'accepted', ...(override?.text !== undefined ? { text } : {}) } });
  return { kind: 'batch', ops };
}

export function rejectSuggestionOp(state: ProjectState, suggestionId: string, reason?: string): Operation {
  const s = requireNodeOfType(state, suggestionId, 'suggestion');
  if (s.props.status !== 'open') throw new OpError('This suggestion was already resolved');
  return { kind: 'update', id: s.id, set: { status: 'rejected', ...(reason ? { reason } : {}) } };
}

/** Plain text of a whole document (search, word counts, summaries). */
export function documentPlainText(state: ProjectState, docId: string): string {
  return documentBlocks(state, docId)
    .map((b) => (b.props.blockType === 'table' ? (b.props.rows ?? []).map((r) => r.join('\t')).join('\n') : b.props.blockType === 'code' ? b.props.text : inlineToPlain(b.props.text)))
    .filter(Boolean)
    .join('\n\n');
}

export function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}
