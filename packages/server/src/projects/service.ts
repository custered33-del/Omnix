import { EventEmitter } from 'node:events';
import {
  ProjectSession,
  createProjectState,
  validateOperation,
  touchedIds,
  outlineProject,
  OpError,
  rootNode,
  newId,
  applyOp,
  type Author,
  type Commit,
  type Operation,
  type Proposal,
  type ProjectState,
  type SerializedSession,
  type Snapshot,
  type ToolKind,
  type SessionEvent,
} from '@omnix/core';
import type { DocStore } from '../storage/store.js';
import { C, commitLog } from '../storage/store.js';
import type { ActivityService, ActivityEntry } from './activity.js';

export type ProjectRole = 'owner' | 'editor' | 'viewer';

export interface ProjectMeta {
  id: string;
  name: string;
  primaryTool: ToolKind;
  ownerId: string;
  members: { userId: string; role: ProjectRole }[];
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** Mirror of the root node's consent flag, for fast listing. */
  aiConsent: boolean;
  thumbnailVersion: number;
  templateId?: string | null;
  description?: string;
}

interface Checkpoint {
  version: 1;
  baseState: ProjectState;
  head: string | null;
  headState: ProjectState;
  proposals: Proposal[];
  snapshots: Snapshot[];
  seq: number;
  savedAt: string;
}

export class ProjectError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProjectError';
  }
}

export type Via = ActivityEntry['via'];

export interface CommitOptions {
  label?: string;
  via?: Via;
  jobId?: string;
  /** Skip schema validation (only for trusted, internally generated ops). */
  trusted?: boolean;
  /** Reject when the project head moved since the client last saw it. */
  baseHead?: string | null;
}

export type ProjectEvent =
  | { type: 'commit'; projectId: string; commit: Commit; head: string | null }
  | { type: 'checkout'; projectId: string; head: string | null }
  | { type: 'proposal'; projectId: string; proposal: Proposal }
  | { type: 'snapshot'; projectId: string; snapshot: Snapshot }
  | { type: 'meta'; projectId: string; meta: ProjectMeta }
  | { type: 'deleted'; projectId: string }
  /** Live output from a code run (not persisted; the final outputs are committed). */
  | { type: 'code'; projectId: string; runId: string; stream: 'stdout' | 'stderr'; text: string; cellId: string | null };

/**
 * Owns every open project session. All writes go through here so validation, consent,
 * permissions, persistence, realtime fan-out and the activity feed are applied uniformly
 * no matter whether a change came from the UI, the REST API, MCP or the agent runner.
 */
export class ProjectService extends EventEmitter {
  private sessions = new Map<string, Promise<ProjectSession>>();
  private dirty = new Map<string, NodeJS.Timeout>();
  private lastAccess = new Map<string, number>();

  constructor(
    private readonly store: DocStore,
    private readonly activity: ActivityService,
  ) {
    super();
  }

  /* Metadata ------------------------------------------------------- */

  async listMeta(): Promise<ProjectMeta[]> {
    return this.store.list<ProjectMeta>(C.projects);
  }

  async getMeta(id: string): Promise<ProjectMeta> {
    const m = await this.store.get<ProjectMeta>(C.projects, id);
    if (!m) throw new ProjectError(`Project not found: ${id}`, 404);
    return m;
  }

  roleOf(meta: ProjectMeta, userId: string): ProjectRole | null {
    if (meta.ownerId === userId) return 'owner';
    return meta.members.find((m) => m.userId === userId)?.role ?? null;
  }

  async listForUser(userId: string, options: { includeArchived?: boolean } = {}): Promise<ProjectMeta[]> {
    return (await this.listMeta())
      .filter((m) => this.roleOf(m, userId) && (options.includeArchived || !m.archived))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async requireAccess(projectId: string, userId: string, need: 'read' | 'write' | 'admin'): Promise<ProjectMeta> {
    const meta = await this.getMeta(projectId);
    const role = this.roleOf(meta, userId);
    if (!role) throw new ProjectError('You do not have access to this project', 403);
    if (need === 'write' && role === 'viewer') throw new ProjectError('You have view-only access to this project', 403);
    if (need === 'admin' && role !== 'owner') throw new ProjectError('Only the project owner can do this', 403);
    return meta;
  }

  async create(input: { name: string; primaryTool: ToolKind; ownerId: string; author: Author; state?: ProjectState; templateId?: string; description?: string; aiConsent?: boolean }): Promise<ProjectMeta> {
    const name = input.name.trim().slice(0, 200) || 'Untitled project';
    let state = input.state ?? createProjectState({ name, primaryTool: input.primaryTool, aiConsent: input.aiConsent ?? false });
    if (input.state) {
      // Templates arrive as full states; give the copy a fresh identity and the requested name.
      state = reidentify(input.state, name, input.primaryTool);
    }
    const root = rootNode(state);
    const now = new Date().toISOString();
    const meta: ProjectMeta = {
      id: state.id,
      name,
      primaryTool: root.props.primaryTool,
      ownerId: input.ownerId,
      members: [],
      createdAt: now,
      updatedAt: now,
      archived: false,
      aiConsent: root.props.aiConsent,
      thumbnailVersion: 0,
      templateId: input.templateId ?? null,
      description: input.description ?? '',
    };
    const session = new ProjectSession(state);
    await this.store.put(C.projects, meta.id, meta);
    await this.writeCheckpoint(meta.id, session);
    this.attach(meta.id, session);
    this.sessions.set(meta.id, Promise.resolve(session));
    await this.activity.record({ projectId: meta.id, projectName: name, actor: input.author, kind: 'project', summary: `Created ${input.primaryTool} project "${name}"`, via: 'ui' });
    this.emit('event', { type: 'meta', projectId: meta.id, meta } satisfies ProjectEvent);
    return meta;
  }

  async updateMeta(projectId: string, patch: Partial<Pick<ProjectMeta, 'name' | 'archived' | 'members' | 'description'>>, author: Author): Promise<ProjectMeta> {
    const meta = await this.getMeta(projectId);
    const next: ProjectMeta = { ...meta, ...patch, updatedAt: new Date().toISOString() };
    if (patch.name !== undefined) {
      next.name = patch.name.trim().slice(0, 200) || meta.name;
      const session = await this.session(projectId);
      if (rootNode(session.state).props.name !== next.name) {
        await this.commit(projectId, { kind: 'update', id: session.state.rootId, set: { name: next.name } }, author, { label: `Rename project to "${next.name}"`, trusted: true });
      }
    }
    await this.store.put(C.projects, projectId, next);
    this.emit('event', { type: 'meta', projectId, meta: next } satisfies ProjectEvent);
    return next;
  }

  /** Grant or revoke per-project AI consent. Recorded in history and the activity feed. */
  async setAiConsent(projectId: string, consent: boolean, author: Author): Promise<ProjectMeta> {
    if (author.type !== 'human') throw new ProjectError('Only a person can change AI consent', 403);
    const session = await this.session(projectId);
    await this.commit(projectId, { kind: 'update', id: session.state.rootId, set: { aiConsent: consent } }, author, { label: consent ? 'Allow AI on this project' : 'Turn off AI for this project', trusted: true });
    const meta = await this.getMeta(projectId);
    const next = { ...meta, aiConsent: consent, updatedAt: new Date().toISOString() };
    await this.store.put(C.projects, projectId, next);
    await this.activity.record({ projectId, projectName: meta.name, actor: author, kind: 'consent', summary: consent ? 'Allowed AI to work on this project' : 'Turned off AI for this project', via: 'ui' });
    this.emit('event', { type: 'meta', projectId, meta: next } satisfies ProjectEvent);
    return next;
  }

  async delete(projectId: string, author: Author): Promise<void> {
    const meta = await this.getMeta(projectId);
    await this.flush(projectId);
    this.sessions.delete(projectId);
    await this.store.delete(C.projects, projectId);
    await this.store.delete(C.checkpoints, projectId);
    await this.store.deleteLog(commitLog(projectId));
    await this.activity.record({ projectId, projectName: meta.name, actor: author, kind: 'project', summary: `Deleted project "${meta.name}"`, via: 'ui' });
    this.emit('event', { type: 'deleted', projectId } satisfies ProjectEvent);
  }

  /* Sessions ------------------------------------------------------- */

  session(projectId: string): Promise<ProjectSession> {
    this.lastAccess.set(projectId, Date.now());
    let p = this.sessions.get(projectId);
    if (!p) {
      p = this.load(projectId);
      this.sessions.set(projectId, p);
      p.catch(() => this.sessions.delete(projectId));
    }
    return p;
  }

  async state(projectId: string): Promise<ProjectState> {
    return (await this.session(projectId)).state;
  }

  private async load(projectId: string): Promise<ProjectSession> {
    const cp = await this.store.get<Checkpoint>(C.checkpoints, projectId);
    if (!cp) throw new ProjectError(`Project not found: ${projectId}`, 404);
    const commits = await this.store.readLog<Commit>(commitLog(projectId));
    const maxSeq = commits.reduce((m, c) => Math.max(m, c.seq), 0);
    const data: SerializedSession = { version: 1, baseState: cp.baseState, commits, head: cp.head, proposals: cp.proposals, snapshots: cp.snapshots };
    let session: ProjectSession;
    if (maxSeq > cp.seq) {
      // The process stopped after commits were logged but before the checkpoint was saved:
      // recover by replaying from the base state up to the newest commit.
      const newest = commits.reduce((a, b) => (b.seq > a.seq ? b : a));
      session = ProjectSession.fromJSON({ ...data, head: newest.id });
    } else {
      session = ProjectSession.fromJSON({ ...data, headState: cp.headState });
    }
    this.attach(projectId, session);
    return session;
  }

  private attach(projectId: string, session: ProjectSession): void {
    session.subscribe((e: SessionEvent) => {
      this.markDirty(projectId);
      switch (e.type) {
        case 'commit':
          this.emit('event', { type: 'commit', projectId, commit: e.commit, head: session.head } satisfies ProjectEvent);
          break;
        case 'checkout':
          this.emit('event', { type: 'checkout', projectId, head: e.head } satisfies ProjectEvent);
          break;
        case 'proposal':
          this.emit('event', { type: 'proposal', projectId, proposal: e.proposal } satisfies ProjectEvent);
          break;
        case 'snapshot':
          this.emit('event', { type: 'snapshot', projectId, snapshot: e.snapshot } satisfies ProjectEvent);
          break;
      }
    });
  }

  private markDirty(projectId: string): void {
    const t = this.dirty.get(projectId);
    if (t) clearTimeout(t);
    this.dirty.set(
      projectId,
      setTimeout(() => {
        void this.flush(projectId);
      }, 800),
    );
  }

  private async writeCheckpoint(projectId: string, session: ProjectSession): Promise<void> {
    const json = session.toJSON(true);
    const cp: Checkpoint = {
      version: 1,
      baseState: json.baseState,
      head: json.head,
      headState: json.headState!,
      proposals: json.proposals,
      snapshots: json.snapshots,
      seq: json.commits.reduce((m, c) => Math.max(m, c.seq), 0),
      savedAt: new Date().toISOString(),
    };
    await this.store.put(C.checkpoints, projectId, cp);
  }

  /** Persist the checkpoint for one project now. */
  async flush(projectId: string): Promise<void> {
    const t = this.dirty.get(projectId);
    if (t) clearTimeout(t);
    this.dirty.delete(projectId);
    const p = this.sessions.get(projectId);
    if (!p) return;
    const session = await p;
    await this.writeCheckpoint(projectId, session);
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.dirty.keys()].map((id) => this.flush(id)));
  }

  /** Drop idle sessions from memory (they reload from storage on next access). */
  async evictIdle(maxIdleMs = 30 * 60_000): Promise<number> {
    let n = 0;
    for (const [id, at] of this.lastAccess) {
      if (Date.now() - at > maxIdleMs && !this.dirty.has(id)) {
        this.sessions.delete(id);
        this.lastAccess.delete(id);
        n++;
      }
    }
    return n;
  }

  /* Writes --------------------------------------------------------- */

  private async guard(projectId: string, author: Author): Promise<{ session: ProjectSession; meta: ProjectMeta }> {
    const meta = await this.getMeta(projectId);
    const session = await this.session(projectId);
    if (author.type === 'ai' && !rootNode(session.state).props.aiConsent) {
      throw new ProjectError('AI is not allowed on this project yet. A collaborator needs to turn on "Allow AI" in the project settings.', 403);
    }
    return { session, meta };
  }

  validate(state: ProjectState, op: Operation): void {
    const issues = validateOperation(op, (id) => state.nodes[id]?.type);
    if (issues.length) {
      throw new ProjectError(`Invalid operation: ${issues.slice(0, 5).map((i) => `${i.path}: ${i.message}`).join('; ')}`, 400, issues);
    }
  }

  async commit(projectId: string, op: Operation, author: Author, options: CommitOptions = {}): Promise<Commit> {
    const { session, meta } = await this.guard(projectId, author);
    if (options.baseHead !== undefined && options.baseHead !== session.head) {
      // Optimistic concurrency: the caller decides whether to rebase (most UI ops simply retry).
      try {
        applyOp(session.state, op);
      } catch (e) {
        throw new ProjectError(`The project changed while you were editing and this change no longer applies: ${(e as Error).message}`, 409);
      }
    }
    if (!options.trusted) this.validate(session.state, op);
    let commit: Commit;
    try {
      commit = session.commit(op, { author, ...(options.label ? { label: options.label } : {}), ...(options.jobId ? { jobId: options.jobId } : {}) });
    } catch (e) {
      if (e instanceof OpError) throw new ProjectError(e.message, 400);
      throw e;
    }
    await this.store.append(commitLog(projectId), commit);
    await this.touch(meta);
    await this.activity.record({
      projectId,
      projectName: meta.name,
      actor: author,
      kind: 'commit',
      summary: commit.label,
      via: options.via ?? 'ui',
      commitId: commit.id,
      nodeIds: touchedIds(op).slice(0, 20),
      ...(options.jobId ? { jobId: options.jobId } : {}),
    });
    return commit;
  }

  private async touch(meta: ProjectMeta): Promise<void> {
    const next = { ...meta, updatedAt: new Date().toISOString(), thumbnailVersion: meta.thumbnailVersion + 1 };
    await this.store.put(C.projects, meta.id, next);
  }

  async undo(projectId: string, author: Author, via: Via = 'ui'): Promise<Commit | null> {
    const { session, meta } = await this.guard(projectId, author);
    const c = session.undo(author);
    if (!c) return null;
    await this.store.append(commitLog(projectId), c);
    await this.touch(meta);
    await this.activity.record({ projectId, projectName: meta.name, actor: author, kind: 'undo', summary: c.label, via, commitId: c.id });
    return c;
  }

  async redo(projectId: string, author: Author, via: Via = 'ui'): Promise<Commit | null> {
    const { session, meta } = await this.guard(projectId, author);
    const c = session.redo(author);
    if (!c) return null;
    await this.store.append(commitLog(projectId), c);
    await this.touch(meta);
    await this.activity.record({ projectId, projectName: meta.name, actor: author, kind: 'redo', summary: c.label, via, commitId: c.id });
    return c;
  }

  /** Revert one specific commit (any author) by committing its inverse. */
  async revert(projectId: string, commitId: string, author: Author, via: Via = 'ui'): Promise<Commit> {
    const { session } = await this.guard(projectId, author);
    const target = session.getCommit(commitId);
    if (!target) throw new ProjectError(`Unknown commit ${commitId}`, 404);
    return this.commit(projectId, target.inverse, author, { label: `Revert: ${target.label}`, via, trusted: true });
  }

  async checkout(projectId: string, commitId: string | null, author: Author): Promise<ProjectState> {
    const { session, meta } = await this.guard(projectId, author);
    let s: ProjectState;
    try {
      s = session.checkout(commitId);
    } catch (e) {
      throw new ProjectError((e as Error).message, 400);
    }
    await this.flush(projectId);
    await this.activity.record({ projectId, projectName: meta.name, actor: author, kind: 'checkout', summary: commitId ? `Switched to version ${commitId}` : 'Switched to the original version', via: 'ui' });
    return s;
  }

  async snapshot(projectId: string, name: string, author: Author): Promise<Snapshot> {
    const { session, meta } = await this.guard(projectId, author);
    const snap = session.snapshot(name.trim().slice(0, 120) || 'Snapshot', author);
    await this.flush(projectId);
    await this.activity.record({ projectId, projectName: meta.name, actor: author, kind: 'snapshot', summary: `Saved version "${snap.name}"`, via: 'ui' });
    return snap;
  }

  /* Proposals ------------------------------------------------------ */

  async propose(projectId: string, ops: Operation[], meta: { author: Author; label: string; description?: string; jobId?: string; via?: Via }): Promise<Proposal> {
    const { session, meta: pm } = await this.guard(projectId, meta.author);
    for (const op of ops) this.validate(session.state, op);
    let p: Proposal;
    try {
      p = session.propose(ops, { author: meta.author, label: meta.label, ...(meta.description ? { description: meta.description } : {}), ...(meta.jobId ? { jobId: meta.jobId } : {}) });
    } catch (e) {
      throw new ProjectError(`Proposal does not apply: ${(e as Error).message}`, 400);
    }
    await this.flush(projectId);
    await this.activity.record({ projectId, projectName: pm.name, actor: meta.author, kind: 'proposal.created', summary: `Proposed: ${meta.label}`, via: meta.via ?? 'mcp', proposalId: p.id, ...(meta.jobId ? { jobId: meta.jobId } : {}) });
    return p;
  }

  async acceptProposal(projectId: string, proposalId: string, approver: Author, modifiedOps?: Operation[]): Promise<Commit> {
    if (approver.type !== 'human') throw new ProjectError('Only a person can approve proposed changes', 403);
    const session = await this.session(projectId);
    const meta = await this.getMeta(projectId);
    if (modifiedOps) for (const op of modifiedOps) this.validate(session.state, op);
    let commit: Commit;
    try {
      commit = session.acceptProposal(proposalId, approver, modifiedOps);
    } catch (e) {
      await this.flush(projectId);
      throw new ProjectError((e as Error).message, 409);
    }
    await this.store.append(commitLog(projectId), commit);
    await this.touch(meta);
    await this.flush(projectId);
    await this.activity.record({ projectId, projectName: meta.name, actor: approver, kind: 'proposal.accepted', summary: `Approved: ${commit.label}${modifiedOps ? ' (modified)' : ''}`, via: 'ui', proposalId, commitId: commit.id });
    return commit;
  }

  async rejectProposal(projectId: string, proposalId: string, by: Author, reason?: string): Promise<Proposal> {
    const session = await this.session(projectId);
    const meta = await this.getMeta(projectId);
    let p: Proposal;
    try {
      p = session.rejectProposal(proposalId, by, reason);
    } catch (e) {
      throw new ProjectError((e as Error).message, 409);
    }
    await this.flush(projectId);
    await this.activity.record({ projectId, projectName: meta.name, actor: by, kind: 'proposal.rejected', summary: `Rejected: ${p.label}${reason ? ` (${reason})` : ''}`, via: 'ui', proposalId });
    return p;
  }

  /* Reads ---------------------------------------------------------- */

  async outline(projectId: string) {
    return outlineProject(await this.state(projectId));
  }
}

/** Copy a template state with fresh node ids so many projects can start from one template. */
export function reidentify(state: ProjectState, name: string, primaryTool: ToolKind): ProjectState {
  const map = new Map<string, string>();
  for (const id of Object.keys(state.nodes)) {
    const n = state.nodes[id]!;
    const prefix = id.includes('_') ? id.split('_')[0]! : n.type.slice(0, 3);
    map.set(id, newId(prefix));
  }
  const remapValue = (v: unknown): unknown => {
    if (typeof v === 'string') return map.get(v) ?? v;
    if (Array.isArray(v)) return v.map(remapValue);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = k === 'assetId' ? x : remapValue(x);
      return o;
    }
    return v;
  };
  const nodes: Record<string, ProjectState['nodes'][string]> = {};
  for (const n of Object.values(state.nodes)) {
    const id = map.get(n.id)!;
    nodes[id] = {
      id,
      type: n.type,
      parentId: n.parentId ? map.get(n.parentId)! : null,
      children: n.children.map((c) => map.get(c)!),
      props: remapValue(structuredClone(n.props)) as never,
    } as never;
  }
  const rootId = map.get(state.rootId)!;
  const root = nodes[rootId]!;
  (root.props as unknown as Record<string, unknown>).name = name;
  (root.props as unknown as Record<string, unknown>).primaryTool = primaryTool;
  return { id: rootId, rootId, nodes };
}
