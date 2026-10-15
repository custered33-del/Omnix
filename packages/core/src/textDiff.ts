import type { Operation } from './ops.js';
import type { SceneNode } from './nodes.js';
import { commentsContainer, type ProjectState } from './state.js';

/** One run of a line diff: lines kept, removed from `a`, or added in `b`. */
export interface DiffRun {
  kind: 'same' | 'removed' | 'added';
  lines: string[];
  /** 0-based first line of the run in `a` (same, removed) or `b` (added). */
  aStart: number;
  bStart: number;
}

/** Past this many edits the middle of the text is reported as replaced wholesale. */
const MAX_EDITS = 4000;

/**
 * Line diff (Myers' O(ND) algorithm after trimming the common prefix and suffix). Runs come
 * out in order; consecutive removals precede additions at the same place.
 */
export function diffLines(a: string, b: string): DiffRun[] {
  const A = a.split('\n');
  const B = b.split('\n');
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const midA = A.slice(pre, A.length - suf);
  const midB = B.slice(pre, B.length - suf);
  const edits = myers(midA, midB);
  // edits: per-line ops over the middle; expand into runs with absolute positions.
  const runs: DiffRun[] = [];
  const push = (kind: DiffRun['kind'], line: string, ai: number, bi: number) => {
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.lines.push(line);
    else runs.push({ kind, lines: [line], aStart: ai, bStart: bi });
  };
  for (let i = 0; i < pre; i++) push('same', A[i]!, i, i);
  let ai = pre;
  let bi = pre;
  for (const e of edits) {
    if (e === 0) push('same', A[ai]!, ai++, bi++);
    else if (e < 0) push('removed', A[ai]!, ai++, bi);
    else push('added', B[bi]!, ai, bi++);
  }
  for (let i = 0; i < suf; i++) push('same', A[ai]!, ai++, bi++);
  return runs;
}

/** A run of a word-level diff (whitespace and punctuation are their own tokens). */
export interface WordRun {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/** Word-level diff of two strings, for showing an edited sentence inline. */
export function diffWords(a: string, b: string): WordRun[] {
  if (a === b) return a ? [{ kind: 'same', text: a }] : [];
  const tok = (s: string) => s.match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_]/gu) ?? [];
  const A = tok(a);
  const B = tok(b);
  const out: WordRun[] = [];
  const push = (kind: WordRun['kind'], text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  for (const e of myers(A, B)) {
    if (e === 0) {
      push('same', A[i++]!);
      j++;
    } else if (e < 0) push('removed', A[i++]!);
    else push('added', B[j++]!);
  }
  return out;
}

/** Edit script over two token arrays: 0 keep, -1 delete from a, 1 insert from b. */
function myers(a: string[], b: string[], limit = MAX_EDITS): number[] {
  const n = a.length;
  const m = b.length;
  if (!n) return new Array<number>(m).fill(1);
  if (!m) return new Array<number>(n).fill(-1);
  const max = Math.min(n + m, limit);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break outer;
      }
    }
  }
  if (!found) return [...new Array<number>(n).fill(-1), ...new Array<number>(m).fill(1)];
  // Walk the trace back from (n, m).
  const out: number[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[off + k - 1]! < vd[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = vd[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push(0);
      x--;
      y--;
    }
    out.push(prevK === k + 1 ? 1 : -1);
    if (prevK === k + 1) y--;
    else x--;
  }
  while (x > 0 && y > 0) {
    out.push(0);
    x--;
    y--;
  }
  return out.reverse();
}

/** One change to a text: `base.slice(start, end)` is replaced by `text`. */
export interface TextHunk {
  start: number;
  end: number;
  text: string;
}

/** Past this many word edits a change is treated as one replacement of its middle. */
const MERGE_MAX_EDITS = 1000;

/** Words, runs of spaces and single other characters (a whole character, never half of one). */
const mergeTokens = (s: string) => s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];

/** The changes that turn `base` into `other`, word by word, in order and never touching one another. */
export function textHunks(base: string, other: string): TextHunk[] {
  if (base === other) return [];
  const A = mergeTokens(base);
  const B = mergeTokens(other);
  let pre = 0;
  let pos = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pos += A[pre++]!.length;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const midA = A.slice(pre, A.length - suf);
  const midB = B.slice(pre, B.length - suf);
  const out: TextHunk[] = [];
  let cur: TextHunk | null = null;
  let ai = 0;
  let bi = 0;
  for (const e of myers(midA, midB, MERGE_MAX_EDITS)) {
    if (e === 0) {
      if (cur) out.push(cur);
      cur = null;
      pos += midA[ai++]!.length;
      bi++;
      continue;
    }
    cur ??= { start: pos, end: pos, text: '' };
    if (e < 0) {
      pos += midA[ai++]!.length;
      cur.end = pos;
    } else cur.text += midB[bi++]!;
  }
  if (cur) out.push(cur);
  return out;
}

function applyHunks(base: string, start: number, end: number, hunks: TextHunk[]): string {
  let out = '';
  let pos = start;
  for (const h of hunks) {
    out += base.slice(pos, h.start) + h.text;
    pos = h.end;
  }
  return out + base.slice(pos, end);
}

/**
 * Three-way merge of two edits of the same text. Changes to different parts of `base` are
 * both kept; two insertions at the same place are both kept (theirs first); where the two
 * changed the same characters differently, `mine` wins for that stretch only.
 */
export function mergeText(base: string, mine: string, theirs: string): string {
  if (mine === theirs || theirs === base) return mine;
  if (mine === base) return theirs;
  const all = [...textHunks(base, theirs).map((h) => ({ ...h, mine: false })), ...textHunks(base, mine).map((h) => ({ ...h, mine: true }))];
  // By position; at one position insertions come first, then theirs before mine.
  all.sort((x, y) => x.start - y.start || x.end - x.start - (y.end - y.start) || Number(x.mine) - Number(y.mine));
  let out = '';
  let pos = 0;
  for (let i = 0; i < all.length; ) {
    const start = all[i]!.start;
    let end = all[i]!.end;
    let j = i + 1;
    // A cluster: hunks that overlap, or insertions at one point.
    while (j < all.length) {
      const g = all[j]!;
      const overlaps = g.start < end || (g.start === end && g.start === g.end && start === end);
      if (!overlaps) break;
      end = Math.max(end, g.end);
      j++;
    }
    const cluster = all.slice(i, j);
    const theirsPart = cluster.filter((h) => !h.mine);
    const minePart = cluster.filter((h) => h.mine);
    let text: string;
    if (!minePart.length) text = applyHunks(base, start, end, theirsPart);
    else if (!theirsPart.length) text = applyHunks(base, start, end, minePart);
    else {
      const t = applyHunks(base, start, end, theirsPart);
      const m = applyHunks(base, start, end, minePart);
      text = t === m ? m : start === end ? t + m : m;
    }
    out += base.slice(pos, start) + text;
    pos = end;
    i = j;
  }
  return out + base.slice(pos);
}

/** Where a position in `before` ends up in `after` (for keeping a caret in place across an outside change). */
export function mapTextOffset(before: string, after: string, offset: number): number {
  let delta = 0;
  for (const h of textHunks(before, after)) {
    if (h.end <= offset) delta += h.text.length - (h.end - h.start);
    else if (h.start < offset) return h.start + delta + h.text.length;
    else break;
  }
  return Math.max(0, Math.min(after.length, offset + delta));
}

/**
 * Where a 1-based line of `before` ends up in `after`: the same line if it survived, otherwise
 * the line now standing where it was.
 */
export function remapLine(before: string, after: string, line: number): number {
  return remapLines(before, after, [line])[0]!;
}

export function remapLines(before: string, after: string, lines: number[]): number[] {
  if (before === after) return lines;
  const runs = diffLines(before, after);
  const total = after.split('\n').length;
  return lines.map((line) => {
    const i = line - 1;
    for (const r of runs) {
      if (r.kind === 'added') continue;
      if (i >= r.aStart && i < r.aStart + r.lines.length) {
        return Math.min(total, (r.kind === 'same' ? r.bStart + (i - r.aStart) : r.bStart) + 1);
      }
    }
    return Math.min(total, Math.max(1, line));
  });
}

/**
 * Operations that keep comments pinned to code lines on the same code when a file changes
 * from `before` to `after`. Empty when no line comment moves.
 */
export function commentLineOps(state: ProjectState, fileId: string, before: string, after: string): Operation[] {
  if (before === after) return [];
  let container: SceneNode<'comments'>;
  try {
    container = commentsContainer(state);
  } catch {
    return [];
  }
  const pinned = container.children
    .map((id) => state.nodes[id])
    .filter((n): n is SceneNode<'comment'> => !!n && n.type === 'comment' && (n as SceneNode<'comment'>).props.anchor.nodeId === fileId && (n as SceneNode<'comment'>).props.anchor.line !== undefined);
  if (!pinned.length) return [];
  const moved = remapLines(
    before,
    after,
    pinned.map((c) => c.props.anchor.line!),
  );
  const ops: Operation[] = [];
  pinned.forEach((c, i) => {
    if (moved[i] !== c.props.anchor.line) ops.push({ kind: 'update', id: c.id, set: { anchor: { ...c.props.anchor, line: moved[i]! } } });
  });
  return ops;
}
