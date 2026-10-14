import { EventEmitter } from 'node:events';
import { newId, type Author } from '@omnix/core';
import type { DocStore } from '../storage/store.js';
import { ACTIVITY_LOG } from '../storage/store.js';

export type ActivityKind =
  | 'commit'
  | 'undo'
  | 'redo'
  | 'proposal.created'
  | 'proposal.accepted'
  | 'proposal.rejected'
  | 'checkout'
  | 'snapshot'
  | 'tool'
  | 'job'
  | 'export'
  | 'connection'
  | 'consent'
  | 'project';

export interface ActivityEntry {
  id: string;
  ts: string;
  projectId: string | null;
  projectName: string | null;
  actor: Author;
  kind: ActivityKind;
  summary: string;
  /** How the action arrived. */
  via: 'ui' | 'mcp' | 'api' | 'agent' | 'system';
  commitId?: string;
  proposalId?: string;
  jobId?: string;
  tool?: string;
  nodeIds?: string[];
  /** Short machine-readable outcome for tool calls. */
  ok?: boolean;
}

/**
 * The activity feed: an append-only, attributable log of everything humans and Claude do.
 * Every AI action shows up here with the tool it used and a link to the resulting change.
 */
export class ActivityService extends EventEmitter {
  private recent: ActivityEntry[] = [];
  private loaded: Promise<void>;

  constructor(private readonly store: DocStore) {
    super();
    this.loaded = this.store.readLog<ActivityEntry>(ACTIVITY_LOG, { tail: 2000 }).then((r) => {
      this.recent = r;
    });
  }

  async record(entry: Omit<ActivityEntry, 'id' | 'ts'> & { ts?: string }): Promise<ActivityEntry> {
    await this.loaded;
    const e: ActivityEntry = { id: newId('act'), ts: entry.ts ?? new Date().toISOString(), ...entry };
    this.recent.push(e);
    if (this.recent.length > 4000) this.recent.splice(0, this.recent.length - 2000);
    await this.store.append(ACTIVITY_LOG, e);
    this.emit('entry', e);
    return e;
  }

  async list(filter: { projectIds?: Set<string>; projectId?: string; actorType?: Author['type']; limit?: number; before?: string } = {}): Promise<ActivityEntry[]> {
    await this.loaded;
    const out: ActivityEntry[] = [];
    for (let i = this.recent.length - 1; i >= 0 && out.length < (filter.limit ?? 50); i--) {
      const e = this.recent[i]!;
      if (filter.before && e.ts >= filter.before) continue;
      if (filter.projectId && e.projectId !== filter.projectId) continue;
      if (filter.projectIds && e.projectId && !filter.projectIds.has(e.projectId)) continue;
      if (filter.actorType && e.actor.type !== filter.actorType) continue;
      out.push(e);
    }
    return out;
  }
}
