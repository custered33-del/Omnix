import { deepEqual, diffStates, type NodeChange, type NodeRef, type StateDiff } from './diff.js';
import { documentBlocks, wordCount } from './documents.js';
import { inlineToPlain } from './markdown.js';
import type { SceneNode } from './nodes.js';
import type { ProjectState } from './state.js';
import { diffLines, diffWords, type DiffRun, type WordRun } from './textDiff.js';

/**
 * Comparing two versions of a project, one document at a time: what changed structurally,
 * and in the form people read it (paragraph text, code lines, slides). Pictures of each
 * version come from the renderer; this is everything else.
 */

export type DocumentKind = 'canvas' | 'sequence' | 'codeWorkspace' | 'document' | 'deck';
const DOCUMENT_KINDS = new Set<string>(['canvas', 'sequence', 'codeWorkspace', 'document', 'deck']);

export interface BlockChange {
  status: 'same' | 'added' | 'removed' | 'changed' | 'moved';
  blockId: string;
  blockType: string;
  before?: string;
  after?: string;
  /** Inline word changes for edited text. */
  words?: WordRun[];
}

export interface FileChange {
  status: 'added' | 'removed' | 'changed' | 'renamed';
  fileId: string;
  path: string;
  previousPath?: string;
  /** Line runs; long unchanged stretches are shortened to a few lines of context. */
  runs: (DiffRun | { kind: 'skip'; count: number; aStart: number; bStart: number })[];
  additions: number;
  deletions: number;
}

export interface SlideChange {
  status: 'same' | 'added' | 'removed' | 'changed' | 'moved';
  slideId: string;
  name: string;
  indexBefore: number | null;
  indexAfter: number | null;
  /** Elements added, removed or edited on this slide. */
  elements: number;
}

export interface DocumentComparison {
  documentId: string;
  kind: DocumentKind;
  name: string;
  existsBefore: boolean;
  existsAfter: boolean;
  /** Node-level changes inside this document. */
  structural: StateDiff;
  blocks?: BlockChange[];
  files?: FileChange[];
  slides?: SlideChange[];
  /** Plain-language one-liner, e.g. "3 paragraphs edited, 1 added, 120 → 164 words". */
  summary: string;
}

export interface VersionComparison {
  documents: DocumentComparison[];
  /** Documents with any change. */
  changed: string[];
  summary: string;
}

function docsOf(state: ProjectState): SceneNode[] {
  const root = state.nodes[state.rootId];
  return root ? root.children.map((id) => state.nodes[id]).filter((n): n is SceneNode => !!n && DOCUMENT_KINDS.has(n.type)) : [];
}

function subtreeIds(state: ProjectState, id: string, out = new Set<string>()): Set<string> {
  const n = state.nodes[id];
  if (!n || out.has(id)) return out;
  out.add(id);
  for (const c of n.children) subtreeIds(state, c, out);
  return out;
}

function nameOf(n: SceneNode | undefined): string {
  return String((n?.props as { name?: string } | undefined)?.name ?? n?.type ?? '');
}

/** Restrict a project diff to one document's nodes (in either version). */
function scoped(diff: StateDiff, ids: Set<string>): StateDiff {
  const keep = <T extends NodeRef>(xs: T[]) => xs.filter((x) => ids.has(x.id));
  const added = keep(diff.added);
  const removed = keep(diff.removed);
  const changed = keep(diff.changed as NodeChange[]);
  return { added, removed, changed, empty: !added.length && !removed.length && !changed.length };
}

function compareBlocks(before: ProjectState, after: ProjectState, docId: string): BlockChange[] {
  const A = before.nodes[docId] ? documentBlocks(before, docId) : [];
  const B = after.nodes[docId] ? documentBlocks(after, docId) : [];
  const aIndex = new Map(A.map((b, i) => [b.id, i]));
  const bIds = new Set(B.map((b) => b.id));
  const out: BlockChange[] = [];
  const text = (b: SceneNode<'block'>) => (b.props.blockType === 'table' ? (b.props.rows ?? []).map((r) => r.join(' | ')).join('\n') : inlineToPlain(b.props.text));
  // Walk the new order, slotting removed blocks in where they used to be.
  let ai = 0;
  const flushRemoved = (upTo: number) => {
    for (; ai < upTo; ai++) {
      const a = A[ai]!;
      if (!bIds.has(a.id)) out.push({ status: 'removed', blockId: a.id, blockType: a.props.blockType, before: text(a) });
    }
  };
  let lastIndex = -1;
  for (const b of B) {
    const i = aIndex.get(b.id);
    if (i === undefined) {
      out.push({ status: 'added', blockId: b.id, blockType: b.props.blockType, after: text(b) });
      continue;
    }
    flushRemoved(i);
    ai = Math.max(ai, i + 1);
    const a = A[i]!;
    const ta = text(a);
    const tb = text(b);
    const moved = i < lastIndex;
    lastIndex = Math.max(lastIndex, i);
    if (ta !== tb) out.push({ status: 'changed', blockId: b.id, blockType: b.props.blockType, before: ta, after: tb, words: diffWords(ta, tb) });
    else if (!deepEqual(a.props, b.props)) out.push({ status: 'changed', blockId: b.id, blockType: b.props.blockType, before: ta, after: tb });
    else out.push({ status: moved ? 'moved' : 'same', blockId: b.id, blockType: b.props.blockType, after: tb });
  }
  flushRemoved(A.length);
  return out;
}

const CONTEXT = 3;

function compactRuns(runs: DiffRun[]): FileChange['runs'] {
  const out: FileChange['runs'] = [];
  runs.forEach((r, i) => {
    if (r.kind !== 'same' || r.lines.length <= CONTEXT * 2 + 1) return void out.push(r);
    const head = i === 0 ? 0 : CONTEXT;
    const tail = i === runs.length - 1 ? 0 : CONTEXT;
    if (head) out.push({ ...r, lines: r.lines.slice(0, head) });
    const skipped = r.lines.length - head - tail;
    if (skipped > 0) out.push({ kind: 'skip', count: skipped, aStart: r.aStart + head, bStart: r.bStart + head });
    if (tail) out.push({ kind: 'same', lines: r.lines.slice(-tail), aStart: r.aStart + r.lines.length - tail, bStart: r.bStart + r.lines.length - tail });
  });
  return out;
}

function fileText(n: SceneNode): { path: string; text: string } | null {
  if (n.type === 'codeFile') {
    const p = (n as SceneNode<'codeFile'>).props;
    return { path: p.path, text: p.content };
  }
  return null;
}

function compareFiles(before: ProjectState, after: ProjectState, wsId: string): FileChange[] {
  const files = (s: ProjectState) => {
    const out = new Map<string, { path: string; text: string }>();
    const visit = (id: string) => {
      const n = s.nodes[id];
      if (!n) return;
      const f = fileText(n);
      if (f) out.set(n.id, f);
      else if (n.type === 'notebook') {
        // A notebook reads as one file: its cells in order.
        const nb = n as SceneNode<'notebook'>;
        const cells = n.children.map((c) => s.nodes[c] as SceneNode<'cell'> | undefined).filter((c): c is SceneNode<'cell'> => !!c);
        out.set(n.id, { path: `${nb.props.name}.ipynb`, text: cells.map((c, i) => `# [${i + 1}]${c.props.cellType === 'markdown' ? ' markdown' : ''}\n${c.props.source}`).join('\n\n') });
      }
      for (const c of n.children) if (s.nodes[c]?.type !== 'cell') visit(c);
    };
    if (s.nodes[wsId]) for (const c of s.nodes[wsId]!.children) visit(c);
    return out;
  };
  const A = files(before);
  const B = files(after);
  const out: FileChange[] = [];
  const count = (runs: DiffRun[], kind: 'added' | 'removed') => runs.filter((r) => r.kind === kind).reduce((n, r) => n + r.lines.length, 0);
  for (const [id, b] of B) {
    const a = A.get(id);
    if (!a) {
      const runs = diffLines('', b.text).filter((r) => r.kind === 'added');
      out.push({ status: 'added', fileId: id, path: b.path, runs, additions: count(runs, 'added'), deletions: 0 });
      continue;
    }
    if (a.text === b.text && a.path === b.path) continue;
    const runs = diffLines(a.text, b.text);
    out.push({ status: a.text === b.text ? 'renamed' : 'changed', fileId: id, path: b.path, ...(a.path !== b.path ? { previousPath: a.path } : {}), runs: compactRuns(runs), additions: count(runs, 'added'), deletions: count(runs, 'removed') });
  }
  for (const [id, a] of A) {
    if (B.has(id)) continue;
    const runs = diffLines(a.text, '').filter((r) => r.kind === 'removed');
    out.push({ status: 'removed', fileId: id, path: a.path, runs, additions: 0, deletions: count(runs, 'removed') });
  }
  return out;
}

function compareSlides(before: ProjectState, after: ProjectState, deckId: string, structural: StateDiff): SlideChange[] {
  const list = (s: ProjectState) => (s.nodes[deckId] ? s.nodes[deckId]!.children.map((id) => s.nodes[id]).filter((n): n is SceneNode<'slide'> => !!n && n.type === 'slide') : []);
  const A = list(before);
  const B = list(after);
  const aIdx = new Map(A.map((sl, i) => [sl.id, i]));
  // Which slide each changed node belongs to (in either version).
  const slideOf = (s: ProjectState, id: string): string | null => {
    let cur: SceneNode | undefined = s.nodes[id];
    while (cur && cur.type !== 'slide') cur = cur.parentId ? s.nodes[cur.parentId] : undefined;
    return cur?.id ?? null;
  };
  const touched = new Map<string, number>();
  const bump = (sid: string | null) => sid && touched.set(sid, (touched.get(sid) ?? 0) + 1);
  for (const r of structural.added) if (r.type !== 'slide') bump(slideOf(after, r.id));
  for (const r of structural.removed) if (r.type !== 'slide') bump(slideOf(before, r.id));
  for (const c of structural.changed) if (c.type !== 'slide' || c.props.length) bump(slideOf(after, c.id) ?? slideOf(before, c.id));
  const out: SlideChange[] = [];
  let lastIndex = -1;
  B.forEach((sl, j) => {
    const i = aIdx.get(sl.id);
    const name = sl.props.name || `Slide ${j + 1}`;
    if (i === undefined) return void out.push({ status: 'added', slideId: sl.id, name, indexBefore: null, indexAfter: j, elements: touched.get(sl.id) ?? 0 });
    const moved = i < lastIndex;
    lastIndex = Math.max(lastIndex, i);
    const elements = touched.get(sl.id) ?? 0;
    out.push({ status: elements ? 'changed' : moved ? 'moved' : 'same', slideId: sl.id, name, indexBefore: i, indexAfter: j, elements });
  });
  A.forEach((sl, i) => {
    if (!B.some((b) => b.id === sl.id)) out.push({ status: 'removed', slideId: sl.id, name: sl.props.name || `Slide ${i + 1}`, indexBefore: i, indexAfter: null, elements: 0 });
  });
  return out;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function summarize(d: Omit<DocumentComparison, 'summary'>): string {
  if (!d.existsBefore) return 'New in this version';
  if (!d.existsAfter) return 'Removed in this version';
  if (d.structural.empty) return 'No changes';
  const parts: string[] = [];
  if (d.blocks) {
    const n = (s: BlockChange['status']) => d.blocks!.filter((b) => b.status === s).length;
    if (n('changed')) parts.push(`${plural(n('changed'), 'paragraph')} edited`);
    if (n('added')) parts.push(`${n('added')} added`);
    if (n('removed')) parts.push(`${n('removed')} removed`);
    if (n('moved')) parts.push(`${n('moved')} moved`);
    const wb = d.blocks.filter((b) => b.status !== 'added').reduce((s, b) => s + wordCount(b.before ?? b.after ?? ''), 0);
    const wa = d.blocks.filter((b) => b.status !== 'removed').reduce((s, b) => s + wordCount(b.after ?? ''), 0);
    if (wb !== wa) parts.push(`${wb} → ${wa} words`);
  } else if (d.files) {
    const add = d.files.reduce((s, f) => s + f.additions, 0);
    const del = d.files.reduce((s, f) => s + f.deletions, 0);
    parts.push(`${plural(d.files.length, 'file')} changed (+${add} −${del})`);
  } else if (d.slides) {
    const n = (s: SlideChange['status']) => d.slides!.filter((x) => x.status === s).length;
    if (n('changed')) parts.push(`${plural(n('changed'), 'slide')} edited`);
    if (n('added')) parts.push(`${n('added')} added`);
    if (n('removed')) parts.push(`${n('removed')} removed`);
    if (n('moved')) parts.push(`${n('moved')} moved`);
    if (!parts.length) parts.push('Deck settings changed');
  } else {
    // "1 layer edited, 2 clips added"
    const s = d.structural;
    const noun = (type: string) => ({ animLayer: 'animation layer', keyframe: 'keyframe' } as Record<string, string>)[type] ?? type;
    const count = (refs: { type: string }[], verb: string) => {
      const by = new Map<string, number>();
      for (const r of refs) by.set(r.type, (by.get(r.type) ?? 0) + 1);
      for (const [type, n] of by) parts.push(`${plural(n, noun(type))} ${verb}`);
    };
    count(s.changed.filter((c) => c.type !== d.kind || c.props.length), 'edited');
    count(s.added, 'added');
    count(s.removed, 'removed');
  }
  return parts.join(', ') || 'Formatting changed';
}

/** Compare one document (or every document) between two project states. */
export function compareVersions(before: ProjectState, after: ProjectState, documentId?: string): VersionComparison {
  const all = new Map<string, SceneNode>();
  for (const d of [...docsOf(before), ...docsOf(after)]) if (!all.has(d.id) || after.nodes[d.id]) all.set(d.id, after.nodes[d.id] ?? d);
  const wanted = documentId ? [...all.values()].filter((d) => d.id === documentId) : [...all.values()];
  if (documentId && !wanted.length) {
    const n = after.nodes[documentId] ?? before.nodes[documentId];
    if (n) wanted.push(n);
  }
  const project = diffStates(before, after);
  const documents = wanted.map((doc): DocumentComparison => {
    const ids = new Set([...subtreeIds(before, doc.id), ...subtreeIds(after, doc.id)]);
    const structural = scoped(project, ids);
    const base = { documentId: doc.id, kind: doc.type as DocumentKind, name: nameOf(after.nodes[doc.id] ?? before.nodes[doc.id]), existsBefore: !!before.nodes[doc.id], existsAfter: !!after.nodes[doc.id], structural };
    const extra = doc.type === 'document' ? { blocks: compareBlocks(before, after, doc.id) } : doc.type === 'codeWorkspace' ? { files: compareFiles(before, after, doc.id) } : doc.type === 'deck' ? { slides: compareSlides(before, after, doc.id, structural) } : {};
    const d = { ...base, ...extra };
    return { ...d, summary: summarize(d) };
  });
  const changed = documents.filter((d) => !d.structural.empty || d.existsBefore !== d.existsAfter).map((d) => d.documentId);
  const summary = changed.length ? documents.filter((d) => changed.includes(d.documentId)).map((d) => `${d.name}: ${d.summary}`).join('; ') : 'No changes between these versions';
  return { documents, changed, summary };
}
