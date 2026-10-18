import { EventEmitter } from 'node:events';
import { changedNodeIds, type Author, type Operation, type ProjectState, type SceneNode } from '@omnix/core';

/** Where a collaborator is looking/pointing, so others see live cursors in every tool. */
export interface PresenceLocation {
  tool: 'image' | 'video' | 'recense' | 'animation' | 'code' | 'document' | 'slides' | 'dashboard';
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
  private expiry = new Map<string, NodeJS.Timeout>();

  colorFor(id: string): string {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length]!;
  }

  update(clientId: string, projectId: string, author: Author, patch: Partial<Pick<PresenceState, 'location' | 'selection'>>, options: { ttlMs?: number } = {}): PresenceState {
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
    // Connections without a socket (Claude over MCP) fade out after a quiet spell.
    clearTimeout(this.expiry.get(clientId));
    if (options.ttlMs) {
      const timer = setTimeout(() => this.leave(clientId), options.ttlMs);
      timer.unref?.();
      this.expiry.set(clientId, timer);
    } else this.expiry.delete(clientId);
    return next;
  }

  leave(clientId: string): void {
    clearTimeout(this.expiry.get(clientId));
    this.expiry.delete(clientId);
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

const DOC_TOOLS: Record<string, PresenceLocation['tool']> = { canvas: 'image', codeWorkspace: 'code', document: 'document', deck: 'slides' };

/**
 * Where a change happens, as a presence location: the editor, the document and (when the
 * nodes say so) the spot: a layer's position, a clip's start, a slide, a code file, a block.
 */
export function locationOfChange(state: ProjectState, op: Operation): PresenceLocation | null {
  const ids = changedNodeIds(op);
  for (const id of ids) {
    const chain: SceneNode[] = [];
    let cur: SceneNode | undefined = state.nodes[id];
    while (cur) {
      chain.push(cur);
      cur = cur.parentId ? state.nodes[cur.parentId] : undefined;
    }
    const docIndex = chain.findIndex((n) => n.type in DOC_TOOLS || n.type === 'sequence');
    if (docIndex < 0) continue;
    const doc = chain[docIndex]!;
    const node = chain[0]!;
    const p = node.props as { x?: unknown; y?: unknown; start?: unknown };
    if (doc.type === 'sequence') {
      const tool = (doc as SceneNode<'sequence'>).props.purpose;
      return { tool, nodeId: doc.id, ...(typeof p.start === 'number' ? { time: p.start } : {}) };
    }
    const tool = DOC_TOOLS[doc.type]!;
    if (tool === 'slides') {
      const slide = chain.find((n) => n.type === 'slide');
      return { tool, ...(slide ? { nodeId: slide.id } : { nodeId: doc.id }), ...(typeof p.x === 'number' && typeof p.y === 'number' && slide && node !== slide ? { x: p.x, y: p.y } : {}) };
    }
    if (tool === 'code') {
      const file = chain.find((n) => n.type === 'codeFile' || n.type === 'notebook');
      return { tool, nodeId: file?.id ?? doc.id };
    }
    if (tool === 'document') return { tool, nodeId: doc.id, ...(node.type === 'block' ? { blockId: node.id } : {}) };
    return { tool, nodeId: doc.id, ...(typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : {}) };
  }
  return null;
}
