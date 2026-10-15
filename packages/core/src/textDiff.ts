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
function myers(a: string[], b: string[]): number[] {
  const n = a.length;
  const m = b.length;
  if (!n) return new Array<number>(m).fill(1);
  if (!m) return new Array<number>(n).fill(-1);
  const max = Math.min(n + m, MAX_EDITS);
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
