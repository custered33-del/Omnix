import { EventEmitter } from 'node:events';
import type { Author } from '@omnix/core';

/** Where a collaborator is looking/pointing, so others see live cursors in every tool. */
export interface PresenceLocation {
  tool: 'image' | 'video' | 'animation' | 'code' | 'document' | 'slides' | 'dashboard';
  /** The document/node being viewed (canvas, sequence, file, document, slide). */
  nodeId?: string;
  x?: number;
  y?: number;
  time?: number;
  line?: number;
  blockId?: string;
}

export interface PresenceState {
  clientId: string;
  author: Author;
  color: string;
  projectId: string;
  location: PresenceLocation | null;
  /** Selected node ids in the client's editor (exposed to Claude as the "current selection"). */
  selection: string[];
  updatedAt: number;
}

const COLORS = ['#3b5bdb', '#e8590c', '#2f9e44', '#c2255c', '#7048e8', '#1098ad', '#f08c00', '#5c940d'];

/** In-memory presence; entries expire when a client goes quiet. */
export class PresenceService extends EventEmitter {
  private states = new Map<string, PresenceState>();

  colorFor(id: string): string {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length]!;
  }

  update(clientId: string, projectId: string, author: Author, patch: Partial<Pick<PresenceState, 'location' | 'selection'>>): PresenceState {
    const prev = this.states.get(clientId);
    const next: PresenceState = {
      clientId,
      author,
      color: prev?.color ?? this.colorFor(author.id),
      projectId,
      location: patch.location !== undefined ? patch.location : prev?.location ?? null,
      selection: patch.selection ?? prev?.selection ?? [],
      updatedAt: Date.now(),
    };
    this.states.set(clientId, next);
    this.emit('update', next);
    return next;
  }

  leave(clientId: string): void {
    const s = this.states.get(clientId);
    if (s) {
      this.states.delete(clientId);
      this.emit('leave', s);
    }
  }

  inProject(projectId: string, maxAgeMs = 120_000): PresenceState[] {
    const now = Date.now();
    return [...this.states.values()].filter((s) => s.projectId === projectId && now - s.updatedAt < maxAgeMs);
  }

  /** The most recent selection a given user made in a project (what "this" means to Claude). */
  selectionFor(projectId: string, userId: string): { nodeIds: string[]; location: PresenceLocation | null } | null {
    const mine = this.inProject(projectId, 24 * 3600_000)
      .filter((s) => s.author.id === userId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return mine ? { nodeIds: mine.selection, location: mine.location } : null;
  }
}
