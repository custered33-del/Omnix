import { childrenOf, makeNode, notesContainer, type Author, type NoteKind, type NoteProps, type SceneNode } from '@omnix/core';
import type { Services } from '../services.js';
import { useModule } from '../app.js';

/** Commits that record session memory are attributed to this author, so they never land on anyone's undo stack. */
export const MEMORY_AUTHOR: Author = { type: 'system', id: 'session-memory', name: 'Session memory' };

/**
 * Session memory (feature 49): each project keeps a notes log of decisions, prompts and rejected
 * options. People and AI add notes directly; Omnix also records the important moments itself
 * (a rejected proposal and its reason, a natural-language command, an agent goal, an approval gate),
 * so whoever picks the project up next, human or AI, has the context.
 */
export class NotesService {
  constructor(private readonly services: Services) {}

  async list(projectId: string): Promise<SceneNode<'note'>[]> {
    const state = await this.services.projects.state(projectId);
    return childrenOf(state, notesContainer(state).id).filter((n): n is SceneNode<'note'> => n.type === 'note');
  }

  /** Add an automatic note. Returns its id, or null when the same note was just recorded. */
  async record(projectId: string, note: { kind: NoteKind; text: string; author: Author; ref?: NoteProps['ref'] }): Promise<string | null> {
    const text = note.text.trim().slice(0, 4000);
    if (!text) return null;
    const recent = (await this.list(projectId)).slice(-10);
    if (recent.some((n) => n.props.kind === note.kind && n.props.text === text)) return null;
    const state = await this.services.projects.state(projectId);
    const node = makeNode('note', { kind: note.kind, text, author: note.author, createdAt: new Date().toISOString(), auto: true, ...(note.ref ? { ref: note.ref } : {}) });
    await this.services.projects.commit(projectId, { kind: 'create', parentId: notesContainer(state).id, nodes: [node] }, MEMORY_AUTHOR, { label: text.length > 60 ? `${text.slice(0, 59)}…` : text, trusted: true, quiet: true });
    return node.id;
  }

  recordRejection(projectId: string, label: string, reason: string | undefined, by: Author, proposalId?: string): Promise<string | null> {
    const text = reason?.trim() ? `Rejected "${label}": ${reason.trim()}` : `Rejected "${label}"`;
    return this.record(projectId, { kind: 'rejected', text, author: by, ...(proposalId ? { ref: { proposalId } } : {}) });
  }

  recordPrompt(projectId: string, prompt: string, by: Author, ref?: NoteProps['ref']): Promise<string | null> {
    return this.record(projectId, { kind: 'prompt', text: prompt, author: by, ...(ref ? { ref } : {}) });
  }

  recordDecision(projectId: string, text: string, by: Author, ref?: NoteProps['ref']): Promise<string | null> {
    return this.record(projectId, { kind: 'decision', text, author: by, ...(ref ? { ref } : {}) });
  }
}

export function notesOf(services: Services): NotesService {
  return services.ext.notes as NotesService;
}

useModule(({ services }) => {
  services.ext.notes = new NotesService(services);
});
