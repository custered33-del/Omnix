import { newId } from './ids.js';
import { applyOp, describeOp, OpError, type Operation } from './ops.js';
import type { ProjectState } from './state.js';
import type { Author } from './types.js';
import { diffStates, type StateDiff } from './diff.js';

/** One entry in a project's history. Commits form a tree (branches) rooted at the project's base state. */
export interface Commit {
  id: string;
  /** Monotonic sequence number within the project. */
  seq: number;
  parentId: string | null;
  op: Operation;
  inverse: Operation;
  author: Author;
  timestamp: string;
  label: string;
  /** This commit reverses `undoOf` (selective, per-author undo). */
  undoOf?: string;
  /** This commit re-applies the change reversed by undo commit `redoOf`. */
  redoOf?: string;
  /** The proposal this commit came from, and who approved it. */
  proposalId?: string;
  approvedBy?: Author;
  /** Autonomous job that produced this commit. */
  jobId?: string;
}

export type ProposalStatus = 'open' | 'accepted' | 'rejected' | 'conflict';

/** An AI- (or human-) suggested change that has not been committed yet. */
export interface Proposal {
  id: string;
  author: Author;
  label: string;
  description: string;
  ops: Operation[];
  baseCommitId: string | null;
  status: ProposalStatus;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: Author;
  commitId?: string;
  jobId?: string;
  error?: string;
  /** Free-form reason given on rejection; also recorded in session memory by the server. */
  reason?: string;
  /** One label per change when an AI stacks several changes into one reviewable proposal. */
  steps?: string[];
  /** A sealed proposal takes no more stacked changes; the next change starts a new proposal. */
  sealed?: boolean;
  updatedAt?: string;
}

export interface Snapshot {
  id: string;
  name: string;
  commitId: string | null;
  createdAt: string;
  author: Author;
}

export interface CommitMeta {
  author: Author;
  label?: string;
  proposalId?: string;
  approvedBy?: Author;
  jobId?: string;
  timestamp?: string;
}

export type SessionEvent =
  | { type: 'commit'; commit: Commit; state: ProjectState }
  | { type: 'checkout'; head: string | null; state: ProjectState }
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'snapshot'; snapshot: Snapshot };

export interface SerializedSession {
  version: 1;
  baseState: ProjectState;
  commits: Commit[];
  head: string | null;
  proposals: Proposal[];
  snapshots: Snapshot[];
  /** Optional cached state at head (avoids a full replay on load). */
  headState?: ProjectState;
}

const RECENT_STATES = 8;

/**
 * Apply a run of recorded operations in one go. A batch shares one working copy of the project,
 * so replaying a thousand commits copies the node map once instead of a thousand times.
 */
function replay(state: ProjectState, ops: Operation[]): ProjectState {
  return ops.length ? applyOp(state, { kind: 'batch', ops }).state : state;
}

/**
 * The live editing session for one project: current state, the commit tree,
 * proposals and snapshots. Every change goes through `commit`.
 */
export class ProjectSession {
  private _state: ProjectState;
  private _head: string | null = null;
  private readonly commits = new Map<string, Commit>();
  private readonly order: string[] = [];
  private readonly proposals = new Map<string, Proposal>();
  private readonly snapshots: Snapshot[] = [];
  private seq = 0;
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  /** States of recently viewed versions (history thumbnails, comparisons). States are immutable, so these never go stale. */
  private readonly recent = new Map<string, ProjectState>();

  constructor(private readonly baseState: ProjectState) {
    this._state = baseState;
  }

  get state(): ProjectState {
    return this._state;
  }

  get head(): string | null {
    return this._head;
  }

  get projectId(): string {
    return this.baseState.id;
  }

  subscribe(listener: (e: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: SessionEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // Listener errors never break editing.
      }
    }
  }

  /* -------------------------------------------------------------- */
  /* Committing                                                      */
  /* -------------------------------------------------------------- */

  /** Apply and record an operation. Throws OpError (leaving the session untouched) if it does not apply. */
  commit(op: Operation, meta: CommitMeta, extra: { undoOf?: string; redoOf?: string } = {}): Commit {
    const { state, inverse } = applyOp(this._state, op);
    const commit: Commit = {
      id: newId('c'),
      seq: ++this.seq,
      parentId: this._head,
      op,
      inverse,
      author: meta.author,
      timestamp: meta.timestamp ?? new Date().toISOString(),
      label: meta.label ?? describeOp(op, this._state),
    };
    if (extra.undoOf) commit.undoOf = extra.undoOf;
    if (extra.redoOf) commit.redoOf = extra.redoOf;
    if (meta.proposalId) commit.proposalId = meta.proposalId;
    if (meta.approvedBy) commit.approvedBy = meta.approvedBy;
    if (meta.jobId) commit.jobId = meta.jobId;
    this.commits.set(commit.id, commit);
    this.order.push(commit.id);
    this._head = commit.id;
    this._state = state;
    this.emit({ type: 'commit', commit, state });
    return commit;
  }

  getCommit(id: string): Commit | undefined {
    return this.commits.get(id);
  }

  /** Commits from the root to `head` (oldest first). */
  log(head: string | null = this._head): Commit[] {
    const path: Commit[] = [];
    let cur = head ? this.commits.get(head) : undefined;
    while (cur) {
      path.push(cur);
      cur = cur.parentId ? this.commits.get(cur.parentId) : undefined;
    }
    return path.reverse();
  }

  /** Every commit in creation order, across all branches. */
  allCommits(): Commit[] {
    return this.order.map((id) => this.commits.get(id)!);
  }

  /** Leaf commits: the tips of every branch. */
  branchTips(): Commit[] {
    const hasChild = new Set<string>();
    for (const c of this.commits.values()) if (c.parentId) hasChild.add(c.parentId);
    return this.allCommits().filter((c) => !hasChild.has(c.id));
  }

  /* -------------------------------------------------------------- */
  /* Undo / redo (selective, per author)                             */
  /* -------------------------------------------------------------- */

  /** The commit `undo(author)` would reverse, if any. */
  undoTarget(authorId: string): Commit | undefined {
    const undone = new Set<string>();
    for (const c of this.log().reverse()) {
      if (c.undoOf) {
        undone.add(c.undoOf);
        continue;
      }
      if (c.author.id !== authorId) continue;
      if (undone.has(c.id)) continue;
      return c;
    }
    return undefined;
  }

  /** The undo commit `redo(author)` would re-apply, if any. */
  redoTarget(authorId: string): Commit | undefined {
    const consumed = new Set<string>();
    for (const c of this.log().reverse()) {
      if (c.author.id !== authorId) continue;
      if (c.redoOf) {
        consumed.add(c.redoOf);
        continue;
      }
      if (c.undoOf) {
        if (!consumed.has(c.id)) return c;
        continue;
      }
      // A fresh change by this author clears their redo stack.
      return undefined;
    }
    return undefined;
  }

  /**
   * Reverse this author's most recent change that has not been undone. Undo is recorded as a new commit,
   * so collaborators' later changes are preserved and the history stays append-only and auditable.
   */
  undo(author: Author): Commit | null {
    const target = this.undoTarget(author.id);
    if (!target) return null;
    return this.commit(target.inverse, { author, label: `Undo: ${target.label}` }, { undoOf: target.id });
  }

  redo(author: Author): Commit | null {
    const undoCommit = this.redoTarget(author.id);
    if (!undoCommit) return null;
    const original = this.commits.get(undoCommit.undoOf!);
    if (!original) return null;
    return this.commit(original.op, { author, label: `Redo: ${original.label}` }, { redoOf: undoCommit.id });
  }

  /* -------------------------------------------------------------- */
  /* Branching                                                       */
  /* -------------------------------------------------------------- */

  /** Path between two commits through their lowest common ancestor. */
  private pathBetween(from: string | null, to: string | null): { up: Commit[]; down: Commit[] } {
    const ancestorsOf = (id: string | null): (string | null)[] => {
      const out: (string | null)[] = [];
      let cur = id;
      while (cur) {
        out.push(cur);
        cur = this.commits.get(cur)?.parentId ?? null;
      }
      out.push(null);
      return out;
    };
    const fromChain = ancestorsOf(from);
    const toChain = ancestorsOf(to);
    const toSet = new Set(toChain);
    const lca = fromChain.find((c) => toSet.has(c)) ?? null;
    const up: Commit[] = [];
    for (const id of fromChain) {
      if (id === lca) break;
      up.push(this.commits.get(id!)!);
    }
    const down: Commit[] = [];
    for (const id of toChain) {
      if (id === lca) break;
      down.push(this.commits.get(id!)!);
    }
    down.reverse();
    return { up, down };
  }

  /** Compute the project state at any commit (null = base state) without moving head. */
  stateAt(commitId: string | null): ProjectState {
    if (commitId !== null && !this.commits.has(commitId)) throw new OpError(`Unknown commit: ${commitId}`);
    if (commitId === this._head) return this._state;
    if (commitId === null) return this.baseState;
    const cached = this.recent.get(commitId);
    if (cached) {
      // Most recently used goes last.
      this.recent.delete(commitId);
      this.recent.set(commitId, cached);
      return cached;
    }
    const { up, down } = this.pathBetween(this._head, commitId);
    const state = replay(this._state, [...up.map((c) => c.inverse), ...down.map((c) => c.op)]);
    this.recent.set(commitId, state);
    if (this.recent.size > RECENT_STATES) this.recent.delete(this.recent.keys().next().value!);
    return state;
  }

  /**
   * Move head to another commit. New commits made afterwards start a new branch;
   * the old branch is kept and can be checked out again.
   */
  checkout(commitId: string | null): ProjectState {
    const s = this.stateAt(commitId);
    this._head = commitId;
    this._state = s;
    this.emit({ type: 'checkout', head: commitId, state: s });
    return s;
  }

  /* -------------------------------------------------------------- */
  /* Proposals                                                       */
  /* -------------------------------------------------------------- */

  /** Record a proposed change. It must apply cleanly to the current state. */
  propose(ops: Operation[], meta: { author: Author; label: string; description?: string; jobId?: string; steps?: string[] }): Proposal {
    applyOp(this._state, { kind: 'batch', ops }); // validates; throws on failure
    const p: Proposal = {
      id: newId('prop'),
      author: meta.author,
      label: meta.label,
      description: meta.description ?? '',
      ops,
      baseCommitId: this._head,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    if (meta.jobId) p.jobId = meta.jobId;
    // Named steps pair one-to-one with operations (each step usually a batch), so reviewers can keep or drop each.
    if (meta.steps && meta.steps.length === ops.length && ops.length > 1) p.steps = [...meta.steps];
    this.proposals.set(p.id, p);
    this.emit({ type: 'proposal', proposal: p });
    return p;
  }

  /**
   * Add more changes to an open proposal, so a run of related AI edits (create a slide, then
   * fill it) is reviewed as one diff. The combined operations must still apply cleanly.
   */
  extendProposal(id: string, ops: Operation[], label: string): Proposal {
    const p = this.requireOpenProposal(id);
    if (p.sealed) throw new OpError(`Proposal ${id} is sealed`);
    // Keep one operation per step so each step can be kept or dropped on review.
    const asOne = (list: Operation[]): Operation => (list.length === 1 ? list[0]! : { kind: 'batch', ops: list });
    const base = p.steps && p.steps.length === p.ops.length ? p.ops : [asOne(p.ops)];
    const combined = [...base, asOne(ops)];
    applyOp(this._state, { kind: 'batch', ops: combined }); // validates; throws on failure
    const steps = [...(p.steps && p.steps.length === p.ops.length ? p.steps : [p.label]), label];
    Object.assign(p, { ops: combined, steps, label: `${steps[0]} and ${steps.length - 1} more ${steps.length === 2 ? 'change' : 'changes'}`, updatedAt: new Date().toISOString() });
    this.emit({ type: 'proposal', proposal: p });
    return p;
  }

  /** Stop stacking into a proposal (the next change starts a new one). */
  sealProposal(id: string): Proposal {
    const p = this.requireOpenProposal(id);
    p.sealed = true;
    this.emit({ type: 'proposal', proposal: p });
    return p;
  }

  getProposal(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }

  listProposals(status?: ProposalStatus): Proposal[] {
    const all = [...this.proposals.values()];
    return status ? all.filter((p) => p.status === status) : all;
  }

  /** What the project would look like if the proposal were accepted now, plus a structural diff. */
  previewProposal(id: string, ops?: Operation[]): { state: ProjectState; diff: StateDiff } {
    const p = this.requireOpenProposal(id);
    const { state } = applyOp(this._state, { kind: 'batch', ops: ops ?? p.ops });
    return { state, diff: diffStates(this._state, state) };
  }

  /** Commit a proposal (optionally with modified operations). The commit is attributed to the proposer and approver. */
  acceptProposal(id: string, approver: Author, modifiedOps?: Operation[]): Commit {
    const p = this.requireOpenProposal(id);
    const ops = modifiedOps ?? p.ops;
    try {
      const commit = this.commit(
        { kind: 'batch', ops },
        { author: p.author, label: p.label, proposalId: p.id, approvedBy: approver, ...(p.jobId ? { jobId: p.jobId } : {}) },
      );
      Object.assign(p, {
        status: 'accepted' as const,
        resolvedAt: commit.timestamp,
        resolvedBy: approver,
        commitId: commit.id,
        ops,
      });
      this.emit({ type: 'proposal', proposal: p });
      return commit;
    } catch (e) {
      p.status = 'conflict';
      p.error = e instanceof Error ? e.message : String(e);
      this.emit({ type: 'proposal', proposal: p });
      throw e;
    }
  }

  rejectProposal(id: string, by: Author, reason?: string): Proposal {
    const p = this.requireOpenProposal(id);
    p.status = 'rejected';
    p.resolvedAt = new Date().toISOString();
    p.resolvedBy = by;
    if (reason) p.reason = reason;
    this.emit({ type: 'proposal', proposal: p });
    return p;
  }

  private requireOpenProposal(id: string): Proposal {
    const p = this.proposals.get(id);
    if (!p) throw new OpError(`Unknown proposal: ${id}`);
    if (p.status !== 'open') throw new OpError(`Proposal ${id} is already ${p.status}`);
    return p;
  }

  /* -------------------------------------------------------------- */
  /* Snapshots (named versions)                                      */
  /* -------------------------------------------------------------- */

  snapshot(name: string, author: Author): Snapshot {
    const s: Snapshot = { id: newId('snap'), name, commitId: this._head, createdAt: new Date().toISOString(), author };
    this.snapshots.push(s);
    this.emit({ type: 'snapshot', snapshot: s });
    return s;
  }

  listSnapshots(): Snapshot[] {
    return [...this.snapshots];
  }

  /** Structural diff between two versions (commit ids or null for the base state). */
  diffCommits(a: string | null, b: string | null): StateDiff {
    return diffStates(this.stateAt(a), this.stateAt(b));
  }

  /* -------------------------------------------------------------- */
  /* Persistence                                                     */
  /* -------------------------------------------------------------- */

  toJSON(includeHeadState = true): SerializedSession {
    const out: SerializedSession = {
      version: 1,
      baseState: this.baseState,
      commits: this.allCommits(),
      head: this._head,
      proposals: [...this.proposals.values()],
      snapshots: [...this.snapshots],
    };
    if (includeHeadState) out.headState = this._state;
    return out;
  }

  static fromJSON(data: SerializedSession): ProjectSession {
    const s = new ProjectSession(data.baseState);
    for (const c of data.commits) {
      s.commits.set(c.id, c);
      s.order.push(c.id);
      s.seq = Math.max(s.seq, c.seq);
    }
    for (const p of data.proposals) s.proposals.set(p.id, p);
    s.snapshots.push(...data.snapshots);
    s._head = data.head;
    if (data.headState) {
      s._state = data.headState;
    } else {
      s._state = replay(data.baseState, s.log().map((c) => c.op));
    }
    return s;
  }

  /** Append a commit received from elsewhere (collaboration / storage replay). It must extend the current head. */
  ingest(commit: Commit): void {
    if (this.commits.has(commit.id)) return;
    if (commit.parentId !== this._head) throw new OpError('Commit does not extend the current head');
    const { state } = applyOp(this._state, commit.op);
    this.commits.set(commit.id, commit);
    this.order.push(commit.id);
    this.seq = Math.max(this.seq, commit.seq);
    this._head = commit.id;
    this._state = state;
    this.emit({ type: 'commit', commit, state });
  }
}
