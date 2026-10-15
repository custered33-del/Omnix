import type { Commit } from './history.js';
import type { Operation } from './ops.js';

/**
 * AI attribution: which nodes were last changed by an AI collaborator. Editors use this to put a
 * small marker on layers, clips, blocks and slides so a person can always see what the AI did.
 * A later change by a person clears the marker (they have taken the node back).
 */
export interface AiMark {
  /** Display name of the AI author (for example "Claude"). */
  by: string;
  authorId: string;
  at: string;
  commitId: string;
  label: string;
  jobId?: string;
  /** Who approved the change when it came from a proposal. */
  approvedBy?: string;
}

/** Nodes an operation itself changed (unlike `touchedIds`, a create does not mark its parent). */
export function changedNodeIds(op: Operation): string[] {
  const out = new Set<string>();
  const visit = (o: Operation) => {
    switch (o.kind) {
      case 'create':
        for (const n of o.nodes) out.add(n.id);
        break;
      case 'batch':
        o.ops.forEach(visit);
        break;
      default:
        out.add(o.id);
    }
  };
  visit(op);
  return [...out];
}

/** Fold one commit into a mark table. Returns the same object when nothing changed. */
export function applyCommitMarks(marks: Record<string, AiMark>, c: Pick<Commit, 'id' | 'op' | 'author' | 'timestamp' | 'label' | 'jobId' | 'approvedBy'>): Record<string, AiMark> {
  if (!c.author || !c.op) return marks;
  const ids = changedNodeIds(c.op);
  if (!ids.length) return marks;
  if (c.author.type === 'ai') {
    const mark: AiMark = { by: c.author.name, authorId: c.author.id, at: c.timestamp, commitId: c.id, label: c.label, ...(c.jobId ? { jobId: c.jobId } : {}), ...(c.approvedBy ? { approvedBy: c.approvedBy.name } : {}) };
    const next = { ...marks };
    for (const id of ids) next[id] = mark;
    return next;
  }
  if (c.author.type !== 'human' || !ids.some((id) => marks[id])) return marks;
  const next = { ...marks };
  for (const id of ids) delete next[id];
  return next;
}

/** Marks for a project's history (oldest commit first). */
export function aiMarks(commits: readonly Commit[]): Record<string, AiMark> {
  let marks: Record<string, AiMark> = {};
  for (const c of commits) marks = applyCommitMarks(marks, c);
  return marks;
}
