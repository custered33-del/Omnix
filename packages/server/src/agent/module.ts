import { z } from 'zod';
import express from 'express';
import type { Services } from '../services.js';
import { useModule } from '../app.js';
import { h, requireUser } from '../http/middleware.js';
import { anthropicOf } from '../ai/anthropic.js';
import { defineTool, ToolError, zProjectId, type Principal, type ToolDef } from '../mcp/registry.js';
import { registerToolProvider } from '../mcp/tools/index.js';
import { AgentError, agentOf, DEFAULT_GATES, zGateSpec, type AgentInput, type AgentRunData, type AgentService } from './runner.js';
import type { JobRecord } from '../jobs/queue.js';
import { ProjectError } from '../projects/service.js';

function runView(job: JobRecord) {
  const d = job.data as AgentRunData;
  return {
    id: job.id,
    projectId: job.projectId,
    title: job.title,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    goal: d.goal,
    driver: d.driver,
    gates: d.gates,
    plan: d.plan,
    checkpoints: d.checkpoints,
    pendingGate: d.pendingGate,
    decisions: d.decisions,
    log: d.log,
    steps: d.steps,
    maxSteps: d.maxSteps,
    model: d.model,
    usage: d.usage,
    summary: d.summary,
  };
}

const zStatus = z.object({ runId: z.string(), status: z.string(), stage: z.string().nullable(), pendingGate: z.object({ id: z.string(), title: z.string(), summary: z.string() }).nullable(), decision: z.object({ decision: z.string(), feedback: z.string().optional() }).nullable().optional() });

function statusOf(agent: AgentService, job: JobRecord, decision?: AgentRunData['resume']) {
  const d = job.data as AgentRunData;
  const stage = d.plan.find((s) => s.status === 'active')?.title ?? null;
  return { runId: job.id, status: job.status, stage, pendingGate: d.pendingGate ? { id: d.pendingGate.id, title: d.pendingGate.title, summary: d.pendingGate.summary } : null, ...(decision !== undefined ? { decision } : {}) };
}

function statusText(s: ReturnType<typeof statusOf>): string {
  if (s.status === 'awaiting_approval') return `Paused for the user's approval: ${s.pendingGate?.title}. Call agent_wait with runId ${s.runId} to get their answer before doing anything else on this project.`;
  if (s.decision?.decision === 'approve') return `Approved${s.decision.feedback ? ` with a note: ${s.decision.feedback}` : ''}. Continue${s.stage ? ` with: ${s.stage}` : ''}.`;
  if (s.decision?.decision === 'changes') return `The user asked for changes: ${sentence(s.decision.feedback ?? '(no details)')} Address them, then checkpoint again.`;
  if (s.status === 'cancelled') return 'The user stopped this run. Do not make further changes for it.';
  if (s.status === 'done') return 'The run is finished.';
  return `Running${s.stage ? `. Current stage: ${s.stage}` : ''}.`;
}

/** MCP tools that let a connected Claude run an autonomous goal with checkpoints and approval gates. */
function agentTools(services: Services): ToolDef[] {
  const agent = agentOf(services);
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AgentError) throw new ToolError(e.message);
      throw e;
    }
  };
  return [
    defineTool({
      name: 'agent_start_run',
      title: 'Start an autonomous run',
      description:
        'Start an autonomous run toward a goal in one project (needs an autonomous connection). Give a short plan of stages; work through them with the normal tools, call agent_checkpoint after each stage, and agent_finish at the end. The user chooses approval gates (approve the plan, review each stage, before exporting, before deleting); when one applies the run pauses, write tools are held, and you call agent_wait for their answer.',
      category: 'agent',
      access: 'write',
      input: { projectId: zProjectId, goal: z.string().min(1).max(4000), plan: z.array(z.string().max(200)).max(20).optional().describe('Stages in order, for example ["Script", "Visuals", "Slides", "Video"].'), gates: z.array(zGateSpec).optional().describe('Defaults to the user\'s usual gates: plan, each stage, before export, before delete.') },
      output: zStatus,
      example: { input: { projectId: 'prj_8Kq2...', goal: 'Make a 30-second product teaser from the uploaded clips', plan: ['Pick and trim the best shots', 'Add titles and music', 'Color and pacing pass', 'Export'] }, output: { runId: 'job_7f...', status: 'awaiting_approval', stage: 'Pick and trim the best shots', pendingGate: { id: 'gate_1', title: 'Approve the plan', summary: '1. Pick and trim...' } } },
      async handler(args, ctx) {
        const job = await wrap(() => agent.startExternal(ctx.principal, { projectId: args.projectId, goal: args.goal, ...(args.plan ? { plan: args.plan } : {}), gates: args.gates ?? DEFAULT_GATES }));
        const s = statusOf(agent, agent.get(job.id));
        return { text: `Run ${job.id} started. ${statusText(s)}`, data: s };
      },
    }),
    defineTool({
      name: 'agent_set_plan',
      title: 'Set or revise a run\'s plan',
      description: 'Replace the plan of an autonomous run (for example after the user asked for changes). May pause for the user to approve the plan.',
      category: 'agent',
      access: 'write',
      input: { runId: z.string(), stages: z.array(z.string().max(200)).min(1).max(20) },
      output: zStatus,
      example: { input: { runId: 'job_7f...', stages: ['Script', 'Storyboard', 'Edit', 'Export'] }, output: { runId: 'job_7f...', status: 'awaiting_approval', stage: 'Script', pendingGate: { id: 'gate_2', title: 'Approve the plan', summary: '1. Script...' } } },
      async handler(args, ctx) {
        const job = agent.requireExternal(ctx.principal, args.runId);
        await agent.setPlan(job, args.stages);
        const s = statusOf(agent, agent.get(job.id));
        return { text: statusText(s), data: s };
      },
    }),
    defineTool({
      name: 'agent_checkpoint',
      title: 'Checkpoint a finished stage',
      description: 'Mark the current stage done: saves a named version of the project (the user can roll back to it) with your summary, then moves to the next stage. When the user reviews each stage, the run pauses first: if they approve, the next stage starts; if they ask for changes, the same stage continues, so make the changes and checkpoint it again.',
      category: 'agent',
      access: 'write',
      input: { runId: z.string(), summary: z.string().max(2000).describe('What this stage did, for the person reviewing it.') },
      output: zStatus,
      example: { input: { runId: 'job_7f...', summary: 'Trimmed the five strongest shots to 26 s and ordered them wide to close.' }, output: { runId: 'job_7f...', status: 'awaiting_approval', stage: 'Pick and trim the best shots', pendingGate: { id: 'gate_3', title: 'Stage finished: Pick and trim the best shots', summary: 'Trimmed the five...' } } },
      async handler(args, ctx) {
        const job = agent.requireExternal(ctx.principal, args.runId);
        if (job.status === 'awaiting_approval') throw new ToolError('The run is waiting for approval; call agent_wait first.');
        await agent.checkpoint(job, args.summary);
        const s = statusOf(agent, agent.get(job.id));
        return { text: `Checkpoint saved. ${statusText(s)}`, data: s };
      },
    }),
    defineTool({
      name: 'agent_request_approval',
      title: 'Ask the user to approve',
      description: 'Pause the run and ask the user for a decision or approval. Put the question and options in the summary, then call agent_wait.',
      category: 'agent',
      access: 'write',
      input: { runId: z.string(), title: z.string().max(200), summary: z.string().max(4000) },
      output: zStatus,
      example: { input: { runId: 'job_7f...', title: 'Pick a music track', summary: 'Option A: upbeat synth. Option B: acoustic guitar. I suggest A for the product focus.' }, output: { runId: 'job_7f...', status: 'awaiting_approval', stage: 'Add titles and music', pendingGate: { id: 'gate_4', title: 'Pick a music track', summary: 'Option A...' } } },
      async handler(args, ctx) {
        const job = agent.requireExternal(ctx.principal, args.runId);
        await agent.requestApproval(job, args.title, args.summary);
        const s = statusOf(agent, agent.get(job.id));
        return { text: statusText(s), data: s };
      },
    }),
    defineTool({
      name: 'agent_wait',
      title: 'Wait for the user\'s answer',
      description: 'Wait (up to about 50 seconds) for the user to answer the current approval gate. If it returns still waiting, call it again. The answer is approve (continue), changes (with feedback to address), or stopped.',
      category: 'agent',
      access: 'read',
      input: { runId: z.string(), timeoutSeconds: z.number().min(1).max(55).default(50) },
      output: zStatus,
      example: { input: { runId: 'job_7f...' }, output: { runId: 'job_7f...', status: 'running', stage: 'Add titles and music', pendingGate: null, decision: { decision: 'approve', feedback: 'Keep the titles short.' } } },
      async handler(args, ctx) {
        agent.requireExternal(ctx.principal, args.runId);
        const job = await agent.waitForDecision(args.runId, args.timeoutSeconds * 1000);
        const decision = job.status === 'awaiting_approval' ? undefined : agent.takeDecision(job);
        const s = statusOf(agent, job, decision ?? null);
        return { text: job.status === 'awaiting_approval' ? `Still waiting for the user (${s.pendingGate?.title}). Call agent_wait again.` : statusText(s), data: s };
      },
    }),
    defineTool({
      name: 'agent_status',
      title: 'Check a run',
      description: 'Status of an autonomous run: current stage, any pending approval, and the user\'s latest decision. Without runId, lists this connection\'s runs on a project.',
      category: 'agent',
      access: 'read',
      input: { runId: z.string().optional(), projectId: zProjectId.optional() },
      output: z.object({ runs: z.array(zStatus) }),
      example: { input: { runId: 'job_7f...' }, output: { runs: [{ runId: 'job_7f...', status: 'running', stage: 'Color and pacing pass', pendingGate: null }] } },
      async handler(args, ctx) {
        const jobs = args.runId ? [agent.get(args.runId)] : services.jobs.snapshot({ kind: 'agent' }).filter((j) => j.ownerId === ctx.principal.user.id && (!args.projectId || j.projectId === args.projectId)).slice(0, 10);
        const runs = jobs.map((j) => statusOf(agent, j));
        return { text: runs.map((r) => `${r.runId}: ${statusText(r)}`).join('\n') || 'No runs.', data: { runs } };
      },
    }),
    defineTool({
      name: 'agent_finish',
      title: 'Finish a run',
      description: 'End an autonomous run with a short summary for the user: what you made, where it is, and anything they should check.',
      category: 'agent',
      access: 'write',
      input: { runId: z.string(), summary: z.string().max(4000) },
      output: zStatus,
      example: { input: { runId: 'job_7f...', summary: 'The teaser is in "Teaser v1" (28 s) and exported to MP4; titles use the launch copy from the brief.' }, output: { runId: 'job_7f...', status: 'done', stage: null, pendingGate: null } },
      async handler(args, ctx) {
        const job = agent.requireExternal(ctx.principal, args.runId);
        if (job.status === 'awaiting_approval') throw new ToolError('The run is waiting for approval; call agent_wait first.');
        await agent.finish(job, args.summary);
        return { text: 'Run finished. The summary is in the run log and session memory.', data: statusOf(agent, agent.get(job.id)) };
      },
    }),
  ] as unknown as ToolDef[];
}

useModule(({ services, router }) => {
  const agent = agentOf(services);
  services.jobs.register<AgentInput, unknown>('agent', (jc) => agent.runInternal(jc));
  registerToolProvider(services, agentTools);
  // Tool calls from a connection that is driving a run: gate exports and deletions, hold writes while paused.
  services.ext.agentGate = (principal: Principal, projectIds: string[] | null, tool: ToolDef, args: unknown) => agent.gateExternalCall(principal, projectIds, tool, args);
  services.ext.agentRunFor = (principal: Principal, projectId: string) => agent.activeExternalRun(principal.connectionId, [projectId])?.id;

  const r = express.Router();
  const fail = (e: unknown): never => {
    if (e instanceof AgentError) throw new ProjectError(e.message, e.status);
    throw e;
  };

  r.get(
    '/agent/status',
    h(async (req, res) => {
      requireUser(req);
      res.json({ available: !!anthropicOf(services), model: services.config.agentModel, defaultGates: DEFAULT_GATES });
    }),
  );

  r.post(
    '/projects/:id/agent',
    h(async (req, res) => {
      const user = requireUser(req);
      const body = z.object({ goal: z.string().min(1).max(4000), gates: z.array(zGateSpec).max(10).optional(), maxSteps: z.number().int().min(5).max(400).optional() }).parse(req.body);
      const job = await agent.start(user, { projectId: String(req.params.id), goal: body.goal, ...(body.gates ? { gates: body.gates } : {}), ...(body.maxSteps ? { maxSteps: body.maxSteps } : {}) }).catch(fail);
      res.status(201).json({ run: runView(job!) });
    }),
  );

  r.get(
    '/agent/runs',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
      const list = (await services.jobs.list({ ownerId: user.id, ...(projectId ? { projectId } : {}) })).filter((j) => j.kind === 'agent');
      res.json({ runs: list.slice(0, 50).map(runView) });
    }),
  );

  r.get(
    '/agent/runs/:jobId',
    h(async (req, res) => {
      const user = requireUser(req);
      let job;
      try {
        job = agent.get(String(req.params.jobId));
      } catch (e) {
        fail(e);
      }
      if (job!.ownerId !== user.id) await services.projects.requireAccess(job!.projectId!, user.id, 'read');
      res.json({ run: runView(job!) });
    }),
  );

  r.post(
    '/agent/runs/:jobId/decision',
    h(async (req, res) => {
      const user = requireUser(req);
      const body = z.object({ decision: z.enum(['approve', 'changes', 'stop']), feedback: z.string().max(4000).optional(), rollbackTo: z.string().optional() }).parse(req.body);
      const job = await agent.decide(user, String(req.params.jobId), body.decision, body.feedback, body.rollbackTo ? { rollbackTo: body.rollbackTo } : {}).catch(fail);
      res.json({ run: runView(job!) });
    }),
  );

  r.post(
    '/agent/runs/:jobId/rollback',
    h(async (req, res) => {
      const user = requireUser(req);
      const body = z.object({ to: z.string() }).parse(req.body);
      let job;
      try {
        job = agent.get(String(req.params.jobId));
      } catch (e) {
        fail(e);
      }
      await services.projects.requireAccess(job!.projectId!, user.id, 'write');
      const reverted = await agent.rollback(user, job!, body.to).catch(fail);
      res.json({ reverted, run: runView(agent.get(job!.id)) });
    }),
  );

  r.post(
    '/agent/runs/:jobId/retry',
    h(async (req, res) => {
      const user = requireUser(req);
      let job;
      try {
        job = agent.get(String(req.params.jobId));
      } catch (e) {
        fail(e);
      }
      if (job!.ownerId !== user.id) throw new ProjectError('Only the person who started this run can retry it', 403);
      if (job!.status !== 'failed' || (job!.data as AgentRunData).driver !== 'internal') throw new ProjectError('Only a failed run can be retried', 409);
      await services.jobs.update(job!.id, { error: null });
      await services.jobs.resume(job!.id);
      res.json({ run: runView(agent.get(job!.id)) });
    }),
  );

  router.use(r);
});

/** End a person's note with exactly one full stop (or their own ? or !). */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}
