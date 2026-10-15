import { z } from 'zod';
import { notesContainer, childrenOf, outlineProject, projectTreeText, type Author, type SceneNode } from '@omnix/core';
import type { Services } from '../services.js';
import type { User } from '../auth/users.js';
import type { JobContext, JobRecord } from '../jobs/queue.js';
import { C } from '../storage/store.js';
import { anthropicOf, AnthropicError, replyText, type ContentBlock, type Message, type ToolSpec } from '../ai/anthropic.js';
import { makeToolContext, ToolError, type Principal, type ToolDef } from '../mcp/registry.js';
import { runTool } from '../mcp/server.js';
import { allTools } from '../mcp/tools/index.js';
import type { NotesService } from '../notes/module.js';

/**
 * The autonomous agent runner (feature 44). Claude takes a goal ("make a 30-second teaser from
 * these clips") and carries it across editors in stages: it plans, works through the same MCP tools
 * a connected Claude uses, saves a checkpoint (a named version) after each stage, and pauses at the
 * approval gates the person chose. While paused nothing runs; the person approves, asks for
 * changes, or stops the run (optionally rolling the project back to a checkpoint).
 *
 * Two drivers share this bookkeeping:
 *  - internal: Omnix calls the Claude API itself (needs ANTHROPIC_API_KEY);
 *  - external: Claude, connected through MCP, drives the run with the agent_* tools.
 */

export type GateKind = 'plan' | 'stage' | 'export' | 'delete' | 'custom' | 'budget';

export interface GateSpec {
  kind: 'plan' | 'stage' | 'export' | 'delete' | 'custom';
  /** For custom gates: when to pause, in the person's words ("before rendering the final video"). */
  label?: string;
}

export const DEFAULT_GATES: GateSpec[] = [{ kind: 'plan' }, { kind: 'stage' }, { kind: 'export' }, { kind: 'delete' }];

export const zGateSpec = z.object({ kind: z.enum(['plan', 'stage', 'export', 'delete', 'custom']), label: z.string().max(200).optional() });

export interface PlanStage {
  title: string;
  status: 'pending' | 'active' | 'done';
}

export interface Checkpoint {
  id: string;
  stage: string;
  summary: string;
  snapshotId: string | null;
  head: string | null;
  at: string;
}

export interface PendingGate {
  id: string;
  kind: GateKind;
  title: string;
  summary: string;
  at: string;
  /** A gated tool call waiting to run (export, delete). */
  tool?: { name: string; input: unknown };
}

export interface GateDecision {
  gateId: string;
  title: string;
  decision: 'approve' | 'changes' | 'stop';
  feedback?: string;
  by: string;
  at: string;
}

export interface RunLogEntry {
  at: string;
  kind: 'plan' | 'tool' | 'checkpoint' | 'gate' | 'decision' | 'message' | 'error' | 'finish';
  text: string;
  tool?: string;
  ok?: boolean;
}

export interface AgentRunData extends Record<string, unknown> {
  goal: string;
  /** goal: a multi-stage autonomous run. command: one natural-language command, applied as a proposal. */
  purpose?: 'goal' | 'command';
  /** command: where the person typed it (document, selection, slide, playhead). */
  context?: { documentId: string | null; selection: string[]; slideId: string | null; time: number | null } | null;
  driver: 'internal' | 'external';
  gates: GateSpec[];
  plan: PlanStage[];
  checkpoints: Checkpoint[];
  pendingGate: PendingGate | null;
  decisions: GateDecision[];
  log: RunLogEntry[];
  steps: number;
  maxSteps: number;
  model: string | null;
  usage: { input: number; output: number };
  /** External runs: the MCP connection driving it. */
  connectionId: string | null;
  summary: string | null;
  startHead: string | null;
  /** Internal runs: the decision to apply when the job resumes. External runs: the answer to the last gate, until the next gate opens. */
  resume?: { decision: 'approve' | 'changes'; feedback?: string } | null;
  /** External runs: the gated tool call waiting for approval, and the one approved to go ahead. */
  gatedCall?: string | null;
  approvedCall?: string | null;
}

export interface AgentInput {
  goal: string;
  projectId: string;
}

interface Transcript {
  messages: Message[];
  /** Tool results gathered before a gate paused the turn, and tool calls skipped because of it. */
  pending: { before: ContentBlock[]; toolUseId: string | null; skipped: string[] } | null;
}

export const AGENT_AUTHOR: Author = { type: 'ai', id: 'claude:agent', name: 'Claude' };
const LOG_LIMIT = 400;

export class AgentError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

/** Tool calls that need the "before exporting" gate: one export, or the same export over many documents. */
export function isExportCall(name: string, input?: unknown): boolean {
  if (name === 'export_file') return true;
  return name === 'run_batch' && (input as { operation?: unknown } | undefined)?.operation === 'document.export';
}

/** Words in a plain-language command that ask to take something away. */
const REMOVING = /\b(delete|remove|erase|clear|drop|discard|get rid of|cut out|trash)\b/i;

/** Tool calls that remove content, for the "before deleting" gate. */
export function isDeleteCall(name: string, input: unknown, tool?: Pick<ToolDef, 'category' | 'destructive'>): boolean {
  const a = (input ?? {}) as Record<string, unknown>;
  if (name === 'delete_node') return true;
  // Merging switches every use to one file and removes the other copies from the library.
  if (name === 'merge_assets') return true;
  if (name === 'video_edit_clip' && a.action === 'delete') return true;
  if (name === 'slides_edit_slide' && a.delete === true) return true;
  if (name === 'apply_operations' && Array.isArray(a.operations)) {
    const has = (ops: unknown[]): boolean => ops.some((o) => (o as { kind?: string }).kind === 'delete' || ((o as { kind?: string }).kind === 'batch' && has(((o as { ops?: unknown[] }).ops ?? []) as unknown[])));
    return has(a.operations);
  }
  if (name === 'run_command') return typeof a.text === 'string' && REMOVING.test(a.text);
  if (name === 'run_batch' && a.operation === 'document.command') return typeof (a.params as { text?: unknown } | undefined)?.text === 'string' && REMOVING.test((a.params as { text: string }).text);
  // Plugin tools say whether they may remove content; MCP's default for a tool that writes is that it may.
  if (tool?.category === 'plugin') return tool.destructive !== false;
  return false;
}

function gateFor(gates: GateSpec[], name: string, input: unknown, tool?: Pick<ToolDef, 'category' | 'destructive'>): GateKind | null {
  if (gates.some((g) => g.kind === 'export') && isExportCall(name, input)) return 'export';
  if (gates.some((g) => g.kind === 'delete') && isDeleteCall(name, input, tool)) return 'delete';
  return null;
}

function gateTitle(kind: GateKind, name?: string): string {
  switch (kind) {
    case 'plan':
      return 'Approve the plan';
    case 'stage':
      return 'Stage finished';
    case 'export':
      return `Before exporting (${name})`;
    case 'delete':
      return `Before deleting (${name})`;
    case 'budget':
      return 'Step budget used up';
    default:
      return 'Approval requested';
  }
}

export class AgentService {
  /** Resolvers waiting for a decision on an external run (agent_wait). */
  private waiters = new Map<string, Set<() => void>>();

  constructor(private readonly services: Services) {}

  private get notes(): NotesService | undefined {
    return this.services.ext.notes as NotesService | undefined;
  }

  get(jobId: string): JobRecord<AgentInput> & { data: AgentRunData } {
    const j = this.services.jobs.get(jobId);
    if (!j || j.kind !== 'agent') throw new AgentError(`No agent run ${jobId}`, 404);
    return j as JobRecord<AgentInput> & { data: AgentRunData };
  }

  private async save(job: JobRecord, patch: Partial<JobRecord> = {}): Promise<void> {
    const data = job.data as AgentRunData;
    if (data.log.length > LOG_LIMIT) data.log.splice(0, data.log.length - LOG_LIMIT);
    await this.services.jobs.update(job.id, { ...patch, data });
  }

  private log(job: JobRecord, entry: Omit<RunLogEntry, 'at'>): void {
    (job.data as AgentRunData).log.push({ at: new Date().toISOString(), ...entry });
  }

  /** Check the person may run Claude on this project, and that AI is allowed there. */
  private async checkProject(user: User, projectId: string): Promise<void> {
    const meta = await this.services.projects.requireAccess(projectId, user.id, 'write');
    if (!meta.aiConsent) throw new AgentError(`AI is not allowed on "${meta.name}" yet. Turn on "Allow AI" in the project settings first.`, 403);
  }

  private newData(goal: string, driver: 'internal' | 'external', gates: GateSpec[], maxSteps: number, head: string | null, connectionId: string | null): AgentRunData {
    return { goal, driver, gates, plan: [], checkpoints: [], pendingGate: null, decisions: [], log: [], steps: 0, maxSteps, model: null, usage: { input: 0, output: 0 }, connectionId, summary: null, startHead: head };
  }

  /** Start a run that Omnix drives with the Claude API. */
  async start(user: User, input: { projectId: string; goal: string; gates?: GateSpec[]; maxSteps?: number }): Promise<JobRecord> {
    if (!anthropicOf(this.services)) throw new AgentError('The built-in agent needs a Claude API key. Set ANTHROPIC_API_KEY on the Omnix server, or ask Claude (connected in autonomous mode) to run the goal with agent_start_run.', 409);
    await this.checkProject(user, input.projectId);
    const goal = input.goal.trim().slice(0, 4000);
    if (!goal) throw new AgentError('Describe the goal first.');
    const session = await this.services.projects.session(input.projectId);
    const data = this.newData(goal, 'internal', input.gates ?? DEFAULT_GATES, Math.max(5, Math.min(400, input.maxSteps ?? 80)), session.head, null);
    const job = await this.services.jobs.enqueue<AgentInput>('agent', { goal, projectId: input.projectId }, { title: goal.split('\n')[0]!.slice(0, 90), ownerId: user.id, projectId: input.projectId, data });
    await this.notes?.recordPrompt(input.projectId, `Agent goal: ${goal}`, { type: 'human', id: user.id, name: user.name }, { jobId: job.id });
    return job;
  }

  /**
   * Hand one natural-language command to Claude. Its changes stack into a single proposal the person
   * reviews (nothing commits on its own), so this works like the rule-based commands, only broader.
   */
  async startCommand(user: User, input: { projectId: string; text: string; documentId: string | null; selection: string[]; slideId: string | null; time: number | null }): Promise<JobRecord> {
    if (!anthropicOf(this.services)) throw new AgentError('Claude is not configured on this server (ANTHROPIC_API_KEY).', 409);
    await this.checkProject(user, input.projectId);
    const session = await this.services.projects.session(input.projectId);
    const data = this.newData(input.text.trim().slice(0, 2000), 'internal', [], 30, session.head, null);
    data.purpose = 'command';
    data.context = { documentId: input.documentId, selection: input.selection.slice(0, 50), slideId: input.slideId, time: input.time };
    return this.services.jobs.enqueue<AgentInput>('agent', { goal: data.goal, projectId: input.projectId }, { title: `Command: ${data.goal.slice(0, 80)}`, ownerId: user.id, projectId: input.projectId, data });
  }

  /** Start a run that a connected Claude drives over MCP. */
  async startExternal(principal: Principal, input: { projectId: string; goal: string; plan?: string[]; gates?: GateSpec[] }): Promise<JobRecord> {
    await this.checkProject(principal.user, input.projectId);
    if (principal.mode !== 'autonomous') throw new AgentError('Autonomous runs need an autonomous connection. Ask the user to switch Claude to "Autonomous" for this project in Omnix (Dashboard, Claude card). In edit-with-approval mode, keep making changes normally: each one is reviewed as a proposal.', 403);
    if (principal.projectIds !== 'all' && !principal.projectIds.includes(input.projectId)) throw new AgentError('This connection is not allowed to work on that project.', 403);
    const session = await this.services.projects.session(input.projectId);
    const data = this.newData(input.goal.trim().slice(0, 4000), 'external', input.gates ?? DEFAULT_GATES, 10_000, session.head, principal.connectionId);
    if (input.plan?.length) data.plan = input.plan.slice(0, 20).map((title, i) => ({ title: title.slice(0, 200), status: i === 0 ? 'active' : 'pending' }));
    const job = await this.services.jobs.track<AgentInput>('agent', { goal: data.goal, projectId: input.projectId }, { title: data.goal.split('\n')[0]!.slice(0, 90), ownerId: principal.user.id, projectId: input.projectId, data });
    this.log(job, { kind: 'plan', text: data.plan.length ? `Plan: ${data.plan.map((s) => s.title).join(' → ')}` : 'Run started' });
    if (data.plan.length && data.gates.some((g) => g.kind === 'plan')) await this.pause(job, 'plan', gateTitle('plan'), data.plan.map((s, i) => `${i + 1}. ${s.title}`).join('\n'));
    else await this.save(job);
    await this.notes?.recordPrompt(input.projectId, `Agent goal: ${data.goal}`, principal.author, { jobId: job.id });
    return job;
  }

  /** The run (if any) that an external connection is driving on a project. */
  /** The run this connection is driving in one of these projects, or in any project when the call names none (library tools). */
  activeExternalRun(connectionId: string, projectIds: string[] | null): (JobRecord<AgentInput> & { data: AgentRunData }) | null {
    for (const j of this.services.jobs.snapshot({ kind: 'agent', status: ['running', 'awaiting_approval'] })) {
      const d = j.data as AgentRunData;
      if (d.driver === 'external' && d.connectionId === connectionId && (!projectIds || (j.projectId && projectIds.includes(j.projectId)))) return j as JobRecord<AgentInput> & { data: AgentRunData };
    }
    return null;
  }

  private async pause(job: JobRecord, kind: GateKind, title: string, summary: string, tool?: PendingGate['tool']): Promise<PendingGate> {
    const data = job.data as AgentRunData;
    const gate: PendingGate = { id: `gate_${data.decisions.length + 1}_${Date.now().toString(36)}`, kind, title, summary: summary.slice(0, 4000), at: new Date().toISOString(), ...(tool ? { tool } : {}) };
    data.pendingGate = gate;
    // An external driver's last answer stays readable until the next question replaces it.
    if (data.driver === 'external') data.resume = null;
    this.log(job, { kind: 'gate', text: `${title}${summary ? `: ${summary.split('\n')[0]!.slice(0, 200)}` : ''}` });
    await this.save(job, { status: 'awaiting_approval', message: `Waiting for approval: ${title}` });
    await this.services.activity.record({ projectId: job.projectId, projectName: (await this.services.projects.getMeta(job.projectId!).catch(() => null))?.name ?? null, actor: AGENT_AUTHOR, kind: 'job', summary: `Paused for approval: ${title}`, via: 'agent', jobId: job.id });
    return gate;
  }

  /** A person's answer at a gate. */
  async decide(user: User, jobId: string, decision: 'approve' | 'changes' | 'stop', feedback?: string, options: { rollbackTo?: string | 'start' } = {}): Promise<JobRecord> {
    const job = this.get(jobId);
    if (job.ownerId !== user.id) await this.services.projects.requireAccess(job.projectId!, user.id, 'write');
    const data = job.data;
    const gate = data.pendingGate;
    if (job.status !== 'awaiting_approval' || !gate) {
      if (decision === 'stop' && (job.status === 'running' || job.status === 'queued')) return this.stop(user, job, options.rollbackTo);
      throw new AgentError('This run is not waiting for approval.', 409);
    }
    const by: Author = { type: 'human', id: user.id, name: user.name };
    const fb = feedback?.trim() ? feedback.trim().slice(0, 4000) : undefined;
    data.decisions.push({ gateId: gate.id, title: gate.title, decision, ...(fb ? { feedback: fb } : {}), by: user.name, at: new Date().toISOString() });
    this.log(job, { kind: 'decision', text: `${user.name}: ${decision === 'approve' ? 'approved' : decision === 'changes' ? 'asked for changes' : 'stopped the run'}${fb ? ` ("${fb.slice(0, 160)}")` : ''}` });
    if (job.projectId) {
      if (decision === 'approve' && fb) await this.notes?.recordDecision(job.projectId, `${gate.title}: ${fb}`, by, { jobId });
      if (decision === 'changes') await this.notes?.record(job.projectId, { kind: 'rejected', text: `At "${gate.title}" ${user.name} asked for changes${fb ? `: ${fb}` : ''}`, author: by, ref: { jobId } });
    }
    if (decision === 'stop') return this.stop(user, job, options.rollbackTo);
    // An approved stage is finished and the next one starts; with changes asked for, it carries on.
    if (gate.kind === 'stage' && decision === 'approve') advanceStage(data);
    if (data.driver === 'internal') {
      data.resume = { decision, ...(fb ? { feedback: fb } : {}) };
      await this.save(job);
      await this.services.jobs.resume(job.id);
    } else {
      data.pendingGate = null;
      data.resume = { decision, ...(fb ? { feedback: fb } : {}) };
      data.approvedCall = decision === 'approve' ? (data.gatedCall ?? null) : null;
      data.gatedCall = null;
      await this.save(job, { status: 'running', message: decision === 'approve' ? 'Approved' : 'Changes requested' });
      this.wake(job.id);
    }
    return this.get(jobId);
  }

  private async stop(user: User, job: JobRecord<AgentInput> & { data: AgentRunData }, rollbackTo?: string | 'start'): Promise<JobRecord> {
    const data = job.data;
    data.pendingGate = null;
    data.resume = null;
    if (rollbackTo) await this.rollback(user, job, rollbackTo);
    this.services.jobs.cancel(job.id);
    this.log(job, { kind: 'finish', text: `Stopped by ${user.name}${rollbackTo ? (rollbackTo === 'start' ? ', changes rolled back' : ', rolled back to a checkpoint') : ''}` });
    await this.save(job, { status: 'cancelled', message: 'Stopped', finishedAt: new Date().toISOString() });
    this.wake(job.id);
    return this.get(job.id);
  }

  /** Revert this run's changes made after a checkpoint (or all of them), newest first. */
  async rollback(user: User, job: JobRecord<AgentInput> & { data: AgentRunData }, to: string | 'start'): Promise<number> {
    const projectId = job.projectId!;
    const session = await this.services.projects.session(projectId);
    const cp = to === 'start' ? null : job.data.checkpoints.find((c) => c.id === to);
    if (to !== 'start' && !cp) throw new AgentError('Unknown checkpoint');
    const log = session.log();
    const from = cp?.head ? log.findIndex((c) => c.id === cp.head) + 1 : 0;
    const reverted = new Set(log.filter((c) => c.undoOf).map((c) => c.undoOf));
    const mine = log.slice(from).filter((c) => c.jobId === job.id && !reverted.has(c.id) && !c.label.startsWith('Revert:'));
    const author: Author = { type: 'human', id: user.id, name: user.name };
    let n = 0;
    for (const c of mine.reverse()) {
      try {
        await this.services.projects.revert(projectId, c.id, author);
        n++;
      } catch {
        // A later change by someone else may depend on it; leave that one in place.
      }
    }
    this.log(job, { kind: 'decision', text: `Rolled back ${n} change${n === 1 ? '' : 's'}${cp ? ` to "${cp.stage}"` : ''}` });
    await this.save(job);
    return n;
  }

  /* External driver ---------------------------------------------------------- */

  private wake(jobId: string): void {
    for (const w of this.waiters.get(jobId) ?? []) w();
    this.waiters.delete(jobId);
  }

  /** Wait (up to timeoutMs) for a person to answer the run's current gate. */
  async waitForDecision(jobId: string, timeoutMs: number): Promise<JobRecord<AgentInput> & { data: AgentRunData }> {
    const job = this.get(jobId);
    if (job.status !== 'awaiting_approval') return job;
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(jobId) ?? new Set();
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      set.add(done);
      this.waiters.set(jobId, set);
    });
    return this.get(jobId);
  }

  /** Consume the latest decision for an external run (returned once to the driver). */
  /** The user's answer to the run's last approval gate (null while waiting, or before any). Reading it does not use it up. */
  lastDecision(job: JobRecord<AgentInput> & { data: AgentRunData }): AgentRunData['resume'] {
    return job.status === 'awaiting_approval' ? null : (job.data.resume ?? null);
  }

  /** A run this person may look at: their own. */
  requireOwn(principal: Principal, runId: string): JobRecord<AgentInput> & { data: AgentRunData } {
    const job = this.get(runId);
    if (job.ownerId !== principal.user.id) throw new AgentError(`No agent run ${runId}`, 404);
    return job;
  }

  requireExternal(principal: Principal, runId: string): JobRecord<AgentInput> & { data: AgentRunData } {
    const job = this.get(runId);
    if (job.data.driver !== 'external' || job.data.connectionId !== principal.connectionId) throw new ToolError('That run belongs to another connection.');
    if (['done', 'failed', 'cancelled'].includes(job.status)) throw new ToolError(`The run is ${job.status === 'cancelled' ? 'stopped' : job.status}. Start a new run if there is more to do.`);
    return job;
  }

  async setPlan(job: JobRecord, stages: string[]): Promise<{ paused: PendingGate | null }> {
    const data = job.data as AgentRunData;
    data.plan = stages.slice(0, 20).map((title, i) => ({ title: title.slice(0, 200), status: i === 0 ? 'active' : 'pending' }));
    this.log(job, { kind: 'plan', text: `Plan: ${data.plan.map((s) => s.title).join(' → ')}` });
    await this.save(job, { progress: 0, message: data.plan[0] ? `Stage 1: ${data.plan[0].title}` : 'Planning' });
    if (data.gates.some((g) => g.kind === 'plan')) return { paused: await this.pause(job, 'plan', gateTitle('plan'), data.plan.map((s, i) => `${i + 1}. ${s.title}`).join('\n')) };
    return { paused: null };
  }

  async checkpoint(job: JobRecord, summary: string): Promise<{ checkpoint: Checkpoint; next: PlanStage | null; paused: PendingGate | null }> {
    const data = job.data as AgentRunData;
    const projectId = job.projectId!;
    const activeIdx = data.plan.findIndex((s) => s.status === 'active');
    const stage = data.plan[activeIdx]?.title ?? `Stage ${data.checkpoints.length + 1}`;
    const snap = await this.services.projects.snapshot(projectId, `Claude: ${stage}`.slice(0, 120), AGENT_AUTHOR).catch(() => null);
    const session = await this.services.projects.session(projectId);
    const cp: Checkpoint = { id: `cp_${data.checkpoints.length + 1}`, stage, summary: summary.slice(0, 2000), snapshotId: snap?.id ?? null, head: session.head, at: new Date().toISOString() };
    data.checkpoints.push(cp);
    // With a review, the stage stays current until the person approves it (asking for changes keeps it going).
    const reviewed = data.gates.some((g) => g.kind === 'stage');
    const next = reviewed ? null : advanceStage(data);
    const done = data.plan.filter((s) => s.status === 'done').length + (reviewed && activeIdx >= 0 ? 1 : 0);
    this.log(job, { kind: 'checkpoint', text: `Checkpoint "${stage}": ${summary.slice(0, 200)}` });
    await this.save(job, { progress: data.plan.length ? done / data.plan.length : 0, message: reviewed ? `Waiting for review: ${stage}` : next ? `Stage ${data.plan.indexOf(next) + 1}: ${next.title}` : 'Wrapping up' });
    if (reviewed) return { checkpoint: cp, next, paused: await this.pause(job, 'stage', `${gateTitle('stage')}: ${stage}`, summary) };
    return { checkpoint: cp, next, paused: null };
  }

  async requestApproval(job: JobRecord, title: string, summary: string): Promise<PendingGate> {
    return this.pause(job, 'custom', title.slice(0, 200) || gateTitle('custom'), summary);
  }

  async finish(job: JobRecord, summary: string): Promise<void> {
    const data = job.data as AgentRunData;
    data.summary = summary.slice(0, 4000);
    for (const s of data.plan) if (s.status !== 'done') s.status = 'done';
    this.log(job, { kind: 'finish', text: summary.slice(0, 300) });
    // Remember the outcome before reporting the run as done, so anyone reading the project then sees it.
    if (job.projectId && data.purpose !== 'command') await this.notes?.recordDecision(job.projectId, `Agent finished "${data.goal.slice(0, 120)}": ${data.summary.slice(0, 600)}`, AGENT_AUTHOR, { jobId: job.id });
    await this.save(job, { status: 'done', progress: 1, message: 'Done', result: { summary: data.summary }, finishedAt: new Date().toISOString() });
    this.wake(job.id);
  }

  /** What a paused call will do, in words the person approving it recognises: document and file names, not ids. */
  private async describeCall(name: string, input: unknown): Promise<string> {
    const a = (input ?? {}) as Record<string, unknown>;
    const docName = async (projectId: unknown, id: unknown): Promise<string> => {
      try {
        const node = (await this.services.projects.state(String(projectId))).nodes[String(id)];
        return String((node?.props as { name?: string } | undefined)?.name ?? id);
      } catch {
        return String(id);
      }
    };
    if (name === 'export_file') return `Export ${await docName(a.projectId, a.nodeId)} as ${String(a.format ?? 'a file').toUpperCase()}.`;
    if (name === 'run_batch' && Array.isArray(a.targets)) {
      const targets = a.targets as { projectId?: string; documentId?: string; assetId?: string }[];
      const names = await Promise.all(
        targets.slice(0, 10).map(async (t) => (t.documentId ? docName(t.projectId, t.documentId) : t.assetId ? ((await this.services.assets.get(t.assetId).catch(() => null))?.name ?? t.assetId) : '?')),
      );
      const list = `${names.join(', ')}${targets.length > names.length ? ` and ${targets.length - names.length} more` : ''}`;
      const params = (a.params ?? {}) as Record<string, unknown>;
      if (a.operation === 'document.export') return `Export ${targets.length} ${targets.length === 1 ? 'document' : 'documents'} as ${String(params.format ?? 'files').toUpperCase()}: ${list}.`;
      return `${String(a.operation)} on ${targets.length} item(s): ${list}. Settings: ${JSON.stringify(params).slice(0, 300)}`;
    }
    return describeCall(name, input);
  }

  /** Gate check for tool calls by an external driver: returns a refusal message or null. */
  async gateExternalCall(principal: Principal, projectIds: string[] | null, tool: ToolDef, args: unknown): Promise<string | null> {
    // The run tools manage runs themselves (waiting, checkpoints, finishing), paused or not.
    if (tool.category === 'agent') return null;
    if (tool.access !== 'write' && !isExportCall(tool.name, args)) return null;
    const run = this.activeExternalRun(principal.connectionId, projectIds);
    if (!run) return null;
    if (run.status === 'awaiting_approval') return `The run "${run.data.goal.slice(0, 60)}" is paused for approval (${run.data.pendingGate?.title}). Call agent_wait with runId ${run.id} and continue once the user answers.`;
    const kind = gateFor(run.data.gates, tool.name, args, tool);
    if (!kind) return null;
    // One approval covers exactly the call that was paused.
    const key = JSON.stringify({ n: tool.name, a: args });
    if (run.data.approvedCall === key) {
      run.data.approvedCall = null;
      await this.save(run);
      return null;
    }
    run.data.gatedCall = key;
    await this.pause(run, kind, gateTitle(kind, tool.name), await this.describeCall(tool.name, args), { name: tool.name, input: args });
    return `Paused for the user's approval (${gateTitle(kind, tool.name)}). Call agent_wait with runId ${run.id}; once approved, call ${tool.name} again with the same arguments.`;
  }

  /* Internal driver -------------------------------------------------------------- */

  async runInternal(jc: JobContext<AgentInput>): Promise<unknown> {
    const job = jc.job as JobRecord<AgentInput> & { data: AgentRunData };
    const data = job.data;
    const client = anthropicOf(this.services);
    if (!client) throw new Error('ANTHROPIC_API_KEY is not set on the Omnix server.');
    const user = await this.services.users.byId(job.ownerId);
    if (!user) throw new Error('The person who started this run no longer exists.');
    const projectId = job.input.projectId;
    const command = data.purpose === 'command';
    const principal: Principal = { user, author: AGENT_AUTHOR, mode: command ? 'approve' : 'autonomous', projectIds: [projectId], connectionId: `agent:${job.id}`, clientName: 'Omnix agent runner' };
    const tctx = makeToolContext(this.services, principal, 'agent', job.id);
    const tools = allTools(this.services).filter((t) => t.category !== 'agent' && !(command && (t.name === 'start_new_proposal' || t.name === 'export_file')));
    const byName = new Map(tools.map((t) => [t.name, t]));
    const specs: ToolSpec[] = [...tools.map(toolSpec), ...(command ? CONTROL_SPECS.filter((c) => c.name === 'finish') : CONTROL_SPECS)];
    data.model ??= await client.model();
    let tr = (await this.services.store.get<Transcript>(C.agentTranscripts, job.id)) ?? { messages: [], pending: null };
    if (!tr.messages.length) tr.messages.push({ role: 'user', content: await this.firstMessage(projectId, data) });
    const system = this.systemPrompt(projectId, data);

    // Resuming after a gate: answer the paused tool call first.
    if (data.pendingGate && data.resume) {
      const gate = data.pendingGate;
      const res = data.resume;
      data.pendingGate = null;
      data.resume = null;
      const content: ContentBlock[] = [...(tr.pending?.before ?? [])];
      if (tr.pending?.toolUseId) {
        let text: string;
        let isError = false;
        if (gate.tool && res.decision === 'approve') {
          const t = byName.get(gate.tool.name);
          const r = t ? await runTool(t, gate.tool.input, tctx) : { ok: false, result: null, error: 'Unknown tool' };
          data.steps++;
          this.log(job, { kind: 'tool', tool: gate.tool.name, ok: r.ok, text: r.ok ? r.result!.text.split('\n')[0]!.slice(0, 200) : r.error ?? 'failed' });
          text = r.ok ? `${r.result!.text}${r.result!.data !== undefined ? `\n${JSON.stringify(r.result!.data).slice(0, 6000)}` : ''}` : r.error ?? 'Tool failed';
          isError = !r.ok;
        } else if (gate.tool) {
          text = `Not run: ${user.name} declined this at the approval gate.${res.feedback ? ` Their feedback: ${res.feedback}` : ''}`;
          isError = true;
        } else if (res.decision === 'approve') {
          const current = gate.kind === 'stage' ? data.plan.find((s) => s.status === 'active') : undefined;
          const then = gate.kind !== 'stage' ? 'Continue.' : current ? `Next stage: ${current.title}.` : 'All stages are done: check the result (render_preview), then call finish.';
          text = `${user.name} approved "${gate.title}".${res.feedback ? ` Their note: ${res.feedback}` : ''} ${then}`;
        } else {
          text = `${user.name} asked for changes at "${gate.title}": ${res.feedback ?? '(no details)'}. Address this before moving on${gate.kind === 'plan' ? ', then call plan_stages again with the revised plan' : gate.kind === 'stage' ? ', then call checkpoint again' : ''}.`;
        }
        content.push({ type: 'tool_result', tool_use_id: tr.pending.toolUseId, content: text, ...(isError ? { is_error: true } : {}) });
      } else if (gate.kind === 'budget' && res.decision === 'approve') {
        data.maxSteps += 40;
      }
      for (const id of tr.pending?.skipped ?? []) content.push({ type: 'tool_result', tool_use_id: id, content: 'Not run: the run paused for approval before this call. Call it again if it is still needed.', is_error: true });
      if (content.length) tr.messages.push({ role: 'user', content });
      else if (res.decision === 'changes') tr.messages.push({ role: 'user', content: `${user.name} asked for changes: ${res.feedback ?? ''}` });
      tr.pending = null;
      await this.saveTranscript(job.id, tr);
      await this.save(job, { message: 'Continuing' });
    }

    for (;;) {
      if (jc.signal.aborted) return null;
      if (data.steps >= data.maxSteps) {
        await this.saveTranscript(job.id, tr);
        await this.pause(job, 'budget', gateTitle('budget'), `Claude has used ${data.steps} steps. Approve to allow 40 more, or stop the run.`);
        return null;
      }
      let res;
      try {
        res = await client.messages({ system, messages: tr.messages, tools: specs, max_tokens: 4096, model: data.model! }, jc.signal);
      } catch (e) {
        await this.saveTranscript(job.id, tr);
        if (jc.signal.aborted) return null;
        this.log(job, { kind: 'error', text: (e as Error).message });
        await this.save(job);
        throw e instanceof AnthropicError ? new Error(e.message) : e;
      }
      data.usage.input += res.usage?.input_tokens ?? 0;
      data.usage.output += res.usage?.output_tokens ?? 0;
      tr.messages.push({ role: 'assistant', content: res.content });
      const said = replyText(res);
      if (said) this.log(job, { kind: 'message', text: said.slice(0, 600) });
      const uses = res.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      if (!uses.length) {
        if (res.stop_reason === 'max_tokens' || res.stop_reason === 'pause_turn') {
          tr.messages.push({ role: 'user', content: 'Continue.' });
          continue;
        }
        // Ending without calling finish counts as finishing with what it said.
        await this.saveTranscript(job.id, tr);
        await this.finish(job, said || 'Finished.');
        return { summary: data.summary };
      }
      const results: ContentBlock[] = [];
      for (let i = 0; i < uses.length; i++) {
        const u = uses[i]!;
        const skipRest = () => uses.slice(i + 1).map((x) => x.id);
        if (CONTROL_NAMES.has(u.name)) {
          const out = await this.control(job, u.name, u.input);
          if (out.finished) {
            await this.saveTranscript(job.id, { messages: [...tr.messages, { role: 'user', content: [...results, { type: 'tool_result', tool_use_id: u.id, content: 'Run finished.' }] }], pending: null });
            return { summary: data.summary };
          }
          if (out.paused) {
            tr.pending = { before: results, toolUseId: u.id, skipped: skipRest() };
            await this.saveTranscript(job.id, tr);
            return null;
          }
          results.push({ type: 'tool_result', tool_use_id: u.id, content: out.text, ...(out.error ? { is_error: true } : {}) });
          continue;
        }
        const tool = byName.get(u.name);
        if (!tool) {
          results.push({ type: 'tool_result', tool_use_id: u.id, content: `Unknown tool ${u.name}`, is_error: true });
          continue;
        }
        const pid = (u.input as { projectId?: unknown }).projectId;
        if (typeof pid === 'string' && pid !== projectId && tool.access === 'write') {
          results.push({ type: 'tool_result', tool_use_id: u.id, content: `This run may only change project ${projectId}.`, is_error: true });
          continue;
        }
        const gate = gateFor(data.gates, u.name, u.input, tool);
        if (gate) {
          tr.pending = { before: results, toolUseId: u.id, skipped: skipRest() };
          await this.saveTranscript(job.id, tr);
          await this.pause(job, gate, gateTitle(gate, u.name), await this.describeCall(u.name, u.input), { name: u.name, input: u.input });
          return null;
        }
        const r = await runTool(tool, u.input, tctx);
        data.steps++;
        this.log(job, { kind: 'tool', tool: u.name, ok: r.ok, text: r.ok ? r.result!.text.split('\n')[0]!.slice(0, 200) : (r.error ?? 'failed').slice(0, 200) });
        results.push(toolResultBlock(u.id, r));
        jc.progress(job.progress, `${tool.title}`);
      }
      tr.messages.push({ role: 'user', content: results });
      tr = compact(tr);
      await this.saveTranscript(job.id, tr);
      await this.save(job);
    }
  }

  private async control(job: JobRecord, name: string, input: Record<string, unknown>): Promise<{ text: string; paused?: boolean; finished?: boolean; error?: boolean }> {
    switch (name) {
      case 'plan_stages': {
        const stages = Array.isArray(input.stages) ? input.stages.filter((s): s is string => typeof s === 'string' && !!s.trim()) : [];
        if (!stages.length) return { text: 'Give at least one stage.', error: true };
        const { paused } = await this.setPlan(job, stages);
        return paused ? { text: '', paused: true } : { text: `Plan saved. Start stage 1: ${stages[0]}. Call checkpoint when it is done.` };
      }
      case 'checkpoint': {
        const { next, paused } = await this.checkpoint(job, String(input.summary ?? ''));
        if (paused) return { text: '', paused: true };
        return { text: next ? `Checkpoint saved. Next stage: ${next.title}.` : 'Checkpoint saved. All stages are done: check the result (render_preview), then call finish.' };
      }
      case 'request_approval':
        await this.requestApproval(job, String(input.title ?? 'Approval requested'), String(input.summary ?? ''));
        return { text: '', paused: true };
      case 'finish':
        await this.finish(job, String(input.summary ?? 'Finished.'));
        return { text: 'Finished', finished: true };
      default:
        return { text: `Unknown control ${name}`, error: true };
    }
  }

  private async saveTranscript(jobId: string, tr: Transcript): Promise<void> {
    await this.services.store.put(C.agentTranscripts, jobId, tr);
  }

  private systemPrompt(projectId: string, data: AgentRunData): string {
    if (data.purpose === 'command') {
      const c = data.context;
      return `You are Claude, working inside Omnix, a creative studio with six tools in one project (image, video, animation, code, documents, slides). A person typed a command in the editor and you carry it out with the Omnix tools, as an equal partner with good taste.

Project id: ${projectId}.${c?.documentId ? ` The person is looking at document ${c.documentId}.` : ''}${c?.slideId ? ` Current slide: ${c.slideId}.` : ''}${c?.selection.length ? ` Selected: ${c.selection.join(', ')}.` : ''}${c?.time !== null && c?.time !== undefined ? ` Playhead: ${c.time.toFixed(2)} s.` : ''}

Your changes become one proposal the person previews and accepts, modifies or rejects, so make the whole change, then call finish with one short sentence describing it. Read what you need first (get_node, get_project). Do not plan stages, do not ask questions in text, and keep it to what the command asks.`;
    }
    const gates = data.gates.map((g) => (g.kind === 'custom' ? `- Pause with request_approval ${g.label ?? 'when you reach a point the user should check'}.` : g.kind === 'plan' ? '- The user approves your plan before you start (plan_stages pauses for it).' : g.kind === 'stage' ? '- The user reviews each finished stage (checkpoint pauses for it).' : g.kind === 'export' ? '- Exporting files pauses for approval first (handled automatically).' : '- Deleting anything pauses for approval first (handled automatically).'));
    return `You are Claude, working autonomously inside Omnix, a creative studio with six tools in one project: an image editor, a video editor, an animation maker, Code Grounds (code and notebooks), documents and slideshows. You were given a goal by a person you work with as an equal partner: they set direction and approve results; you do the work end to end, carefully and with good taste.

Project id: ${projectId}. Only change this project.

How to work:
1. Read the project first (get_project, list_notes). Respect decisions and rejected options recorded in session memory.
2. Call plan_stages with 2 to 8 short stages that reach the goal (for example: script the document, generate visuals, build slides, render the video).
3. Work through the stages with the Omnix tools. Changes apply directly and are attributed to you; the person can undo any of them.
4. After each stage, check your work visually (render_preview) and call checkpoint with a one-paragraph summary of what you did.
5. When the goal is reached, call finish with a short summary for the person: what you made, where it is, and anything they should look at.

Approval gates the person chose:
${gates.join('\n') || '- None: work through to the end, but use request_approval if you need a decision only the person can make.'}

Do not ask questions in plain text: nobody reads them mid-run. If you need a decision, call request_approval with the question in the summary. Keep tool calls purposeful; you have a budget of about ${data.maxSteps} tool calls. Record important decisions with add_note.`;
  }

  private async firstMessage(projectId: string, data: AgentRunData): Promise<string> {
    const state = await this.services.projects.state(projectId);
    if (data.purpose === 'command') return `Command: ${data.goal}\n\nProject contents:\n${projectTreeText(state, 200)}`;
    const outline = outlineProject(state);
    const notes = childrenOf(state, notesContainer(state).id)
      .filter((n): n is SceneNode<'note'> => n.type === 'note')
      .slice(-15)
      .map((n) => `- [${n.props.kind}] ${n.props.text}`);
    return `Goal: ${data.goal}

Project "${outline.name}" (${outline.primaryTool}). Everything in it right now (all tools):
${projectTreeText(state, 250)}
${notes.length ? `\nSession memory (latest notes):\n${notes.join('\n')}\n` : ''}
Start by planning (plan_stages).`;
  }
}

/** Finish the current stage and start the next one, which it returns. */
function advanceStage(data: AgentRunData): PlanStage | null {
  const current = data.plan.find((s) => s.status === 'active');
  if (current) current.status = 'done';
  const next = data.plan.find((s) => s.status === 'pending') ?? null;
  if (next) next.status = 'active';
  return next;
}

function describeCall(name: string, input: unknown): string {
  const a = (input ?? {}) as Record<string, unknown>;
  if (name === 'export_file') return `Export ${String(a.nodeId ?? 'a document')} as ${String(a.format ?? 'a file')}.`;
  if (name === 'merge_assets') return `Merge ${Array.isArray(a.drop) ? a.drop.length : 0} cop(ies) into ${String(a.keep)} and remove the copies from the library.`;
  if (name === 'delete_node') return `Delete ${String(a.nodeId ?? 'a node')}.`;
  return `${name} ${JSON.stringify(input).slice(0, 400)}`;
}

function toolResultBlock(id: string, r: Awaited<ReturnType<typeof runTool>>): ContentBlock {
  if (!r.ok) return { type: 'tool_result', tool_use_id: id, content: r.error ?? 'Tool failed', is_error: true };
  const res = r.result!;
  const parts: ({ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } })[] = [{ type: 'text', text: res.text }];
  if (res.data !== undefined) parts.push({ type: 'text', text: JSON.stringify(res.data).slice(0, 12000) });
  for (const img of (res.images ?? []).slice(0, 2)) parts.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data.toString('base64') } });
  return { type: 'tool_result', tool_use_id: id, content: parts };
}

/** Keep long transcripts affordable: drop images from older turns. */
function compact(tr: Transcript): Transcript {
  const keepFrom = Math.max(0, tr.messages.length - 6);
  tr.messages.forEach((m, i) => {
    if (i >= keepFrom || typeof m.content === 'string') return;
    m.content = m.content.map((b) => (b.type === 'tool_result' && Array.isArray(b.content) ? { ...b, content: b.content.map((p) => (p.type === 'image' ? { type: 'text' as const, text: '[image omitted]' } : p)) } : b));
  });
  return tr;
}

export function toolSpec(t: ToolDef): ToolSpec {
  const schema = z.toJSONSchema(z.object(t.input), { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: t.name, description: t.description.slice(0, 1024), input_schema: schema };
}

const CONTROL_SPECS: ToolSpec[] = [
  { name: 'plan_stages', description: 'Set the plan for this run: 2 to 8 short stages in order. Call this first. It may pause for the person to approve the plan.', input_schema: { type: 'object', properties: { stages: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 } }, required: ['stages'] } },
  { name: 'checkpoint', description: 'Finish the current stage: saves a named version of the project and records your summary. It may pause for review.', input_schema: { type: 'object', properties: { summary: { type: 'string', description: 'What this stage did, for the person reviewing it.' } }, required: ['summary'] } },
  { name: 'request_approval', description: 'Pause and ask the person to approve something or make a decision. Put the question and the options in the summary.', input_schema: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' } }, required: ['title', 'summary'] } },
  { name: 'finish', description: 'End the run with a short summary for the person.', input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
];
const CONTROL_NAMES = new Set(CONTROL_SPECS.map((s) => s.name));

export function agentOf(services: Services): AgentService {
  let a = services.ext.agent as AgentService | undefined;
  if (!a) {
    a = new AgentService(services);
    services.ext.agent = a;
  }
  return a;
}

