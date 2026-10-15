import { EventEmitter } from 'node:events';
import { newId } from '@omnix/core';
import type { DocStore } from '../storage/store.js';
import { C } from '../storage/store.js';

export type JobStatus = 'queued' | 'running' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled';

export interface JobRecord<I = unknown, R = unknown> {
  id: string;
  kind: string;
  title: string;
  status: JobStatus;
  progress: number;
  message: string;
  ownerId: string;
  projectId: string | null;
  input: I;
  result: R | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Extra fields kinds may use (e.g. agent checkpoints). */
  data: Record<string, unknown>;
}

export interface JobContext<I> {
  job: JobRecord<I>;
  progress(fraction: number, message?: string): void;
  signal: AbortSignal;
}

export type JobHandler<I = unknown, R = unknown> = (ctx: JobContext<I>) => Promise<R>;

/**
 * In-process job queue for long work: proxies, exports, captions, batch operations and
 * autonomous agent runs. Records persist so the dashboard shows history and status after restarts
 * (jobs running at shutdown are marked failed with a clear message on the next start).
 */
export class JobQueue extends EventEmitter {
  private handlers = new Map<string, JobHandler<any, any>>();
  private queue: string[] = [];
  private running = new Map<string, AbortController>();
  private records = new Map<string, JobRecord>();
  private loaded: Promise<void>;

  constructor(
    private readonly store: DocStore,
    private readonly concurrency = 2,
  ) {
    super();
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    for (const j of await this.store.list<JobRecord>(C.jobs)) {
      // Externally driven work (Claude running an agent over MCP) is not tied to this process.
      if (j.data?.external === true && j.status === 'running') {
        this.records.set(j.id, j);
        continue;
      }
      if (j.status === 'running' || j.status === 'queued') {
        j.status = 'failed';
        j.error = 'Omnix restarted while this job was running. Start it again.';
        j.finishedAt = new Date().toISOString();
        await this.store.put(C.jobs, j.id, j);
      }
      this.records.set(j.id, j);
    }
  }

  register<I, R>(kind: string, handler: JobHandler<I, R>): void {
    this.handlers.set(kind, handler as JobHandler<any, any>);
  }

  async enqueue<I>(kind: string, input: I, meta: { title: string; ownerId: string; projectId?: string | null; data?: Record<string, unknown> }): Promise<JobRecord<I>> {
    await this.loaded;
    if (!this.handlers.has(kind)) throw new Error(`No handler for job kind ${kind}`);
    const job: JobRecord<I> = {
      id: newId('job'),
      kind,
      title: meta.title,
      status: 'queued',
      progress: 0,
      message: 'Queued',
      ownerId: meta.ownerId,
      projectId: meta.projectId ?? null,
      input,
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      data: meta.data ?? {},
    };
    this.records.set(job.id, job as JobRecord);
    await this.persist(job as JobRecord);
    this.queue.push(job.id);
    this.pump();
    return job;
  }

  /**
   * Record a job that something outside the queue drives (for example Claude running an agent
   * through MCP). It shows up in job lists and updates like any other job but has no handler.
   */
  async track<I>(kind: string, input: I, meta: { title: string; ownerId: string; projectId?: string | null; data?: Record<string, unknown> }): Promise<JobRecord<I>> {
    await this.loaded;
    const now = new Date().toISOString();
    const job: JobRecord<I> = {
      id: newId('job'),
      kind,
      title: meta.title,
      status: 'running',
      progress: 0,
      message: 'Running',
      ownerId: meta.ownerId,
      projectId: meta.projectId ?? null,
      input,
      result: null,
      error: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      data: { ...(meta.data ?? {}), external: true },
    };
    this.records.set(job.id, job as JobRecord);
    await this.persist(job as JobRecord);
    return job;
  }

  /** Run and wait (convenience for tests and synchronous API paths). */
  async run<I, R>(kind: string, input: I, meta: { title: string; ownerId: string; projectId?: string | null }): Promise<JobRecord<I, R>> {
    const job = await this.enqueue(kind, input, meta);
    return this.wait<I, R>(job.id);
  }

  wait<I, R>(id: string): Promise<JobRecord<I, R>> {
    return new Promise((resolve) => {
      const check = () => {
        const j = this.records.get(id);
        if (j && ['done', 'failed', 'cancelled'].includes(j.status)) {
          this.off('update', onUpdate);
          resolve(j as JobRecord<I, R>);
          return true;
        }
        return false;
      };
      const onUpdate = (j: JobRecord) => {
        if (j.id === id) check();
      };
      this.on('update', onUpdate);
      check();
    });
  }

  get(id: string): JobRecord | undefined {
    return this.records.get(id);
  }

  /** Jobs already loaded in memory, newest first (synchronous; for hot paths like tool gating). */
  snapshot(filter: { kind?: string; status?: JobStatus[] } = {}): JobRecord[] {
    return [...this.records.values()].filter((j) => (!filter.kind || j.kind === filter.kind) && (!filter.status || filter.status.includes(j.status))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async list(filter: { ownerId?: string; projectId?: string; status?: JobStatus[] } = {}): Promise<JobRecord[]> {
    await this.loaded;
    return [...this.records.values()]
      .filter((j) => (!filter.ownerId || j.ownerId === filter.ownerId) && (!filter.projectId || j.projectId === filter.projectId) && (!filter.status || filter.status.includes(j.status)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async update(id: string, patch: Partial<JobRecord>): Promise<JobRecord | undefined> {
    const j = this.records.get(id);
    if (!j) return undefined;
    Object.assign(j, patch);
    await this.persist(j);
    return j;
  }

  cancel(id: string): boolean {
    const ctrl = this.running.get(id);
    const j = this.records.get(id);
    if (!j) return false;
    if (ctrl) ctrl.abort();
    if (j.status === 'queued' || j.status === 'awaiting_approval') {
      this.queue = this.queue.filter((q) => q !== id);
      j.status = 'cancelled';
      j.finishedAt = new Date().toISOString();
      void this.persist(j);
    }
    return true;
  }

  private async persist(j: JobRecord): Promise<void> {
    await this.store.put(C.jobs, j.id, j);
    this.emit('update', j);
  }

  private pump(): void {
    while (this.running.size < this.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      const job = this.records.get(id);
      if (!job || job.status !== 'queued') continue;
      void this.execute(job);
    }
  }

  private async execute(job: JobRecord): Promise<void> {
    const handler = this.handlers.get(job.kind)!;
    const ctrl = new AbortController();
    this.running.set(job.id, ctrl);
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.message = 'Running';
    await this.persist(job);
    let lastPersist = 0;
    try {
      const result = await handler({
        job,
        signal: ctrl.signal,
        progress: (fraction, message) => {
          job.progress = Math.max(0, Math.min(1, fraction));
          if (message) job.message = message;
          const now = Date.now();
          this.emit('update', job);
          if (now - lastPersist > 1000) {
            lastPersist = now;
            void this.store.put(C.jobs, job.id, job);
          }
        },
      });
      if (job.status === 'running') {
        job.status = ctrl.signal.aborted ? 'cancelled' : 'done';
        job.result = result ?? null;
        job.progress = 1;
        job.message = ctrl.signal.aborted ? 'Cancelled' : 'Done';
      }
    } catch (e) {
      job.status = ctrl.signal.aborted ? 'cancelled' : 'failed';
      job.error = e instanceof Error ? e.message : String(e);
      job.message = job.status === 'cancelled' ? 'Cancelled' : 'Failed';
    } finally {
      job.finishedAt = (job.status as JobStatus) === 'awaiting_approval' ? null : new Date().toISOString();
      this.running.delete(job.id);
      await this.persist(job);
      this.pump();
    }
  }

  /** Re-queue a job (used to resume an autonomous job after an approval gate). */
  async resume(id: string): Promise<void> {
    const j = this.records.get(id);
    if (!j) throw new Error(`Unknown job ${id}`);
    j.status = 'queued';
    j.message = 'Resuming';
    await this.persist(j);
    this.queue.push(id);
    this.pump();
  }
}
