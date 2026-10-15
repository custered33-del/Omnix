import { childrenOf, type Author, type Operation, type ProjectState } from '@omnix/core';
import type { Services } from '../services.js';
import type { User } from '../auth/users.js';
import { ProjectError } from '../projects/service.js';
import type { NotesService } from '../notes/module.js';
import { anthropicOf } from './anthropic.js';
import { COMMAND_EXAMPLES, planCommand, type CommandPlan } from './nl/parser.js';

/** Proposals from typed commands are authored by this (they are the person's intent, translated by Omnix). */
export const COMMAND_AUTHOR: Author = { type: 'system', id: 'omnix-commands', name: 'Omnix commands' };

export interface CommandRequest {
  projectId: string;
  text: string;
  documentId?: string | null;
  selection?: string[];
  slideId?: string | null;
  time?: number | null;
  /** Let Claude take commands the built-in parser does not understand (when configured). */
  allowClaude?: boolean;
}

export type CommandResult =
  | { status: 'proposed'; proposalId: string; steps: string[]; unmatched: CommandPlan['unmatched'] }
  | { status: 'delegated'; runId: string; unmatched: CommandPlan['unmatched'] }
  | { status: 'not-understood'; unmatched: CommandPlan['unmatched']; examples: string[] };

const DOC_TYPES = ['canvas', 'sequence', 'deck', 'document'];

function toolOf(state: ProjectState, documentId: string): string {
  const n = state.nodes[documentId];
  if (!n) return 'image';
  if (n.type === 'canvas') return 'image';
  if (n.type === 'sequence') return (n.props as { purpose?: string }).purpose === 'animation' ? 'animation' : 'video';
  if (n.type === 'deck') return 'slides';
  return 'document';
}

/**
 * Natural-language commands (feature 48): parse the command into steps and record them as one
 * proposal the person previews, modifies or rejects. Phrases the parser does not understand go to
 * Claude when it is configured and AI is allowed on the project; otherwise they come back with examples.
 */
export async function runCommand(services: Services, user: User, req: CommandRequest): Promise<CommandResult> {
  const meta = await services.projects.requireAccess(req.projectId, user.id, 'write');
  const text = req.text.trim().slice(0, 2000);
  if (!text) throw new ProjectError('Type what you would like to change.');
  const state = await services.projects.state(req.projectId);
  const documentId = req.documentId && state.nodes[req.documentId] ? req.documentId : childrenOf(state, state.rootId).find((n) => DOC_TYPES.includes(n.type))?.id;
  if (!documentId || !DOC_TYPES.includes(state.nodes[documentId]!.type)) throw new ProjectError('Open an image, video, animation, slideshow or document to use commands.');
  const human: Author = { type: 'human', id: user.id, name: user.name };
  const plan = await planCommand(text, state, { services, projectId: req.projectId, documentId, selection: req.selection ?? [], slideId: req.slideId ?? null, time: req.time ?? null, ownerId: user.id });
  const notes = services.ext.notes as NotesService | undefined;

  if (plan.unmatched.length && req.allowClaude !== false && anthropicOf(services) && meta.aiConsent) {
    const agent = services.ext.agent as { startCommand(u: User, i: { projectId: string; text: string; documentId: string | null; selection: string[]; slideId: string | null; time: number | null }): Promise<{ id: string }> };
    const job = await agent.startCommand(user, { projectId: req.projectId, text, documentId, selection: req.selection ?? [], slideId: req.slideId ?? null, time: req.time ?? null });
    await notes?.recordPrompt(req.projectId, `“${text}” (handed to Claude)`, human, { jobId: job.id });
    return { status: 'delegated', runId: job.id, unmatched: plan.unmatched };
  }
  if (!plan.steps.length) return { status: 'not-understood', unmatched: plan.unmatched, examples: COMMAND_EXAMPLES[toolOf(state, documentId)] ?? [] };

  const ops: Operation[] = plan.steps.map((s) => (s.ops.length === 1 ? s.ops[0]! : { kind: 'batch', ops: s.ops }));
  const steps = plan.steps.map((s) => s.label);
  const label = steps.length === 1 ? steps[0]! : `“${text.length > 60 ? `${text.slice(0, 57)}…` : text}”`;
  const proposal = await services.projects.propose(req.projectId, ops, { author: COMMAND_AUTHOR, label, description: `Command from ${user.name}: “${text}”`, via: 'ui', steps });
  await notes?.recordPrompt(req.projectId, `“${text}”`, human, { proposalId: proposal.id });
  return { status: 'proposed', proposalId: proposal.id, steps, unmatched: plan.unmatched };
}
