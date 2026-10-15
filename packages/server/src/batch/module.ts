import { z } from 'zod';
import express from 'express';
import type { Author, Operation } from '@omnix/core';
import type { Services } from '../services.js';
import { useModule } from '../app.js';
import { h, requireUser } from '../http/middleware.js';
import { ProjectError } from '../projects/service.js';
import { defineTool, ToolError, type ToolDef } from '../mcp/registry.js';
import { registerToolProvider } from '../mcp/tools/index.js';
import { requireAsset } from '../mcp/tools/assets.js';
import type { User } from '../auth/users.js';
import type { JobContext, JobRecord } from '../jobs/queue.js';
import { runCommand } from '../ai/commands.js';
import { loadReference, STYLE_ASPECTS, styleMatch, type StyleAspect } from '../ai/style.js';
import { runExport } from '../export/module.js';
import { batchOperations, builtinBatchOperations, defineBatchOperation, registerBatchOperation, type BatchItemResult, type BatchOperation, type BatchRunContext, type BatchTarget } from './operations.js';

export { registerBatchOperation, defineBatchOperation, batchOperations, type BatchOperation, type BatchTarget } from './operations.js';

const DOC_TYPES = ['canvas', 'sequence', 'codeWorkspace', 'document', 'deck'];

interface BatchInput {
  operation: string;
  params: Record<string, unknown>;
  targets: BatchTarget[];
  outputTags: string[];
  author: Author;
  via: 'ui' | 'mcp';
  /** An approval-mode Claude connection: document changes become proposals. */
  proposeOnly: boolean;
}

export interface BatchItem {
  target: BatchTarget;
  label: string;
  result: BatchItemResult | null;
}

/** Operations on project documents: a command, an export, or a borrowed look, per document. */
function documentOperations(services: Services): BatchOperation[] {
  const docOf = async (target: BatchTarget) => {
    if (!('documentId' in target)) throw new Error('This operation works on project documents.');
    const state = await services.projects.state(target.projectId);
    const doc = state.nodes[target.documentId];
    if (!doc) throw new Error('That document no longer exists.');
    return { state, doc };
  };
  return [
    defineBatchOperation({
      id: 'document.command',
      label: 'Run a command',
      description: 'Run the same plain-language request on each document, such as "make the title larger" or "warmer colors". Each document gets its own reviewable change, or the change applies straight away.',
      group: 'document',
      ai: true,
      documentTypes: ['canvas', 'sequence', 'document', 'deck'],
      params: { text: z.string().min(1).max(2000), apply: z.boolean().default(false).describe('Apply right away instead of leaving each change to review') },
      async run(ctx, target, p) {
        await docOf(target);
        const t = target as { projectId: string; documentId: string };
        const r = await runCommand(services, ctx.user, { projectId: t.projectId, text: p.text, documentId: t.documentId, allowClaude: false });
        if (r.status !== 'proposed') return { status: 'skipped', message: r.status === 'not-understood' ? `Not understood here: ${r.unmatched.map((u) => u.clause).join(', ')}` : 'Nothing to change' };
        if (p.apply && !ctx.proposeOnly) {
          const commit = await services.projects.acceptProposal(t.projectId, r.proposalId, ctx.author);
          return { status: 'done', commitId: commit.id, message: r.steps.join('; ') };
        }
        return { status: 'done', proposalId: r.proposalId, message: r.steps.join('; ') };
      },
    }),
    defineBatchOperation({
      id: 'document.export',
      label: 'Export',
      description: 'Export each document to a file in the library: pictures (png, jpeg, webp), video (a preset such as youtube-1080p, or mp4, gif), documents (pdf, docx, md), slideshows (pptx, pdf).',
      group: 'document',
      documentTypes: DOC_TYPES,
      params: { format: z.string().min(2).max(40), scale: z.number().min(0.05).max(4).optional(), quality: z.number().min(1).max(100).optional() },
      async run(ctx, target, p) {
        await docOf(target);
        const t = target as { projectId: string; documentId: string };
        const r = await runExport(services, t.projectId, { nodeId: t.documentId, format: p.format, ...(p.scale ? { scale: p.scale } : {}), ...(p.quality ? { quality: p.quality } : {}) }, ctx.user.id, { signal: ctx.signal, progress: () => {} });
        const a = await services.assets.get(r.assetId);
        if (a) await services.assets.update(a.id, { tags: [...new Set([...a.tags, 'batch', ...ctx.outputTags])] });
        return { status: 'done', outputAssetId: r.assetId, outputName: r.name, ...(r.notes.length ? { message: r.notes.join(' ') } : {}) };
      },
    }),
    defineBatchOperation({
      id: 'document.styleMatch',
      label: 'Match a reference look',
      description: 'Give each canvas, video, slideshow or document the look of a reference picture: color and tone, texture, fonts and motion where they apply. Lands as editable settings.',
      group: 'document',
      ai: true,
      documentTypes: ['canvas', 'sequence', 'document', 'deck'],
      params: { referenceAssetId: z.string(), aspects: z.array(z.enum(STYLE_ASPECTS as unknown as [StyleAspect, ...StyleAspect[]])).optional(), strength: z.number().min(0).max(1).default(0.8) },
      async run(ctx, target, p) {
        const { state, doc } = await docOf(target);
        const t = target as { projectId: string; documentId: string };
        const reference = await loadReference(services, state, { assetId: p.referenceAssetId });
        const r = await styleMatch(services, state, { targetId: doc.id, reference, aspects: p.aspects ?? [], strength: p.strength, projectId: t.projectId, ownerId: ctx.user.id });
        if (!r.ops.length) return { status: 'skipped', message: r.skipped.join('; ') || 'Nothing to match' };
        const out = await ctx.apply(t.projectId, r.ops, `Match look of ${reference.label}`);
        return { status: 'done', ...(out.status === 'committed' ? { commitId: out.id } : { proposalId: out.id }), message: r.applied.join('; ') };
      },
    }),
  ];
}

async function labelOf(services: Services, target: BatchTarget): Promise<string> {
  if ('assetId' in target) return (await services.assets.get(target.assetId))?.name ?? target.assetId.slice(0, 10);
  const state = await services.projects.state(target.projectId).catch(() => null);
  return String((state?.nodes[target.documentId]?.props as { name?: string } | undefined)?.name ?? target.documentId);
}

/** Check a batch request: the operation exists, the parameters fit, and every target suits it and is reachable. */
export async function prepareBatch(services: Services, user: User, req: { operation: string; params: unknown; targets: BatchTarget[] }): Promise<{ op: BatchOperation; params: Record<string, unknown> }> {
  const op = batchOperations(services).find((o) => o.id === req.operation);
  if (!op) throw new ProjectError(`Unknown batch operation "${req.operation}". See /api/batch/operations.`, 400);
  const parsed = z.object(op.params).safeParse(req.params ?? {});
  if (!parsed.success) throw new ProjectError(`Check the settings: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')}`, 400);
  if (!req.targets.length) throw new ProjectError('Pick at least one file or document.', 400);
  for (const t of req.targets) {
    if ('assetId' in t) {
      if (!op.kinds) throw new ProjectError(`"${op.label}" works on project documents, not library files.`, 400);
      const a = await requireAsset(services, user.id, t.assetId).catch(() => null);
      if (!a) throw new ProjectError(`File not found: ${t.assetId}`, 404);
      if (!op.kinds.includes(a.kind)) throw new ProjectError(`"${op.label}" does not apply to ${a.name} (${a.kind}).`, 400);
    } else {
      if (!op.documentTypes) throw new ProjectError(`"${op.label}" works on library files, not project documents.`, 400);
      await services.projects.requireAccess(t.projectId, user.id, op.id === 'document.export' ? 'read' : 'write');
      const state = await services.projects.state(t.projectId);
      const doc = state.nodes[t.documentId];
      if (!doc || !op.documentTypes.includes(doc.type)) throw new ProjectError(`"${op.label}" does not apply to ${doc ? doc.type : 'a missing document'}.`, 400);
    }
  }
  return { op, params: parsed.data as Record<string, unknown> };
}

async function runBatchJob(services: Services, jc: JobContext<BatchInput>): Promise<{ items: BatchItem[]; done: number; failed: number; skipped: number }> {
  const input = jc.job.input;
  const op = batchOperations(services).find((o) => o.id === input.operation);
  if (!op) throw new Error(`Unknown batch operation ${input.operation}`);
  const user = await services.users.byId(jc.job.ownerId);
  if (!user) throw new Error('The person who started this batch no longer exists.');
  const ctx: BatchRunContext = {
    services,
    user,
    author: input.author,
    signal: jc.signal,
    outputTags: input.outputTags,
    proposeOnly: input.proposeOnly,
    async apply(projectId: string, ops: Operation[], label: string) {
      if (input.proposeOnly) {
        const p = await services.projects.propose(projectId, ops, { author: input.author, label, via: input.via, jobId: jc.job.id });
        return { status: 'proposed', id: p.id };
      }
      const c = await services.projects.commit(projectId, ops.length === 1 ? ops[0]! : { kind: 'batch', ops }, input.author, { label, via: input.via === 'mcp' ? 'mcp' : 'ui', jobId: jc.job.id });
      return { status: 'committed', id: c.id };
    },
  };
  const items: BatchItem[] = await Promise.all(input.targets.map(async (target) => ({ target, label: await labelOf(services, target), result: null })));
  jc.job.data = { ...jc.job.data, items };
  for (let i = 0; i < items.length; i++) {
    if (jc.signal.aborted) break;
    jc.progress(i / items.length, `${op.label}: ${items[i]!.label} (${i + 1} of ${items.length})`);
    try {
      items[i]!.result = await op.run(ctx, items[i]!.target, input.params as never);
    } catch (e) {
      items[i]!.result = { status: 'failed', message: e instanceof Error ? e.message : String(e) };
    }
    jc.progress((i + 1) / items.length);
  }
  const count = (s: BatchItemResult['status']) => items.filter((x) => x.result?.status === s).length;
  const summary = { items, done: count('done'), failed: count('failed'), skipped: count('skipped') };
  jc.progress(1, `${summary.done} done${summary.failed ? `, ${summary.failed} failed` : ''}${summary.skipped ? `, ${summary.skipped} skipped` : ''}`);
  return summary;
}

/** Start a batch as a background job. */
export async function startBatch(services: Services, user: User, req: { operation: string; params: unknown; targets: BatchTarget[]; tags?: string[]; author?: Author; via?: 'ui' | 'mcp'; proposeOnly?: boolean }): Promise<JobRecord<BatchInput>> {
  const { op, params } = await prepareBatch(services, user, req);
  const projectIds = [...new Set(req.targets.filter((t): t is { projectId: string; documentId: string } => 'projectId' in t).map((t) => t.projectId))];
  const input: BatchInput = {
    operation: op.id,
    params,
    targets: req.targets,
    outputTags: (req.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 10),
    author: req.author ?? { type: 'human', id: user.id, name: user.name },
    via: req.via ?? 'ui',
    proposeOnly: !!req.proposeOnly,
  };
  const n = req.targets.length;
  return services.jobs.enqueue('batch', input, { title: `${op.label} · ${n} ${n === 1 ? 'item' : 'items'}`, ownerId: user.id, projectId: projectIds.length === 1 ? projectIds[0]! : null, data: { operation: op.id, items: [] } });
}

function describeOp(op: BatchOperation) {
  return { id: op.id, label: op.label, description: op.description, group: op.group, ai: !!op.ai, ...(op.kinds ? { kinds: op.kinds } : {}), ...(op.documentTypes ? { documentTypes: op.documentTypes } : {}), params: z.toJSONSchema(z.object(op.params)) };
}

function jobView(j: JobRecord) {
  return { id: j.id, title: j.title, status: j.status, progress: j.progress, message: j.message, error: j.error, createdAt: j.createdAt, finishedAt: j.finishedAt, operation: (j.input as BatchInput).operation, items: ((j.data.items as BatchItem[] | undefined) ?? []).map((x) => ({ ...x })) };
}

const zTarget = z.union([z.object({ assetId: z.string() }), z.object({ projectId: z.string(), documentId: z.string() })]);

function batchTools(services: Services): ToolDef[] {
  return [
    defineTool({
      name: 'list_batch_operations',
      title: 'What batch processing can do',
      description: 'The operations run_batch can apply to many library files or project documents at once, with their settings. File operations (resize, convert, grade, LUT, filter, crop, watermark, remove background, upscale, match a look; video conversion and LUTs; audio loudness) make new files next to the originals. Document operations (run a command, export, match a look) change or export each document.',
      category: 'assets',
      access: 'read',
      input: {},
      output: z.object({ operations: z.array(z.object({ id: z.string(), label: z.string() }).passthrough()) }),
      example: { input: {}, output: { operations: [{ id: 'image.resize', label: 'Resize', group: 'image', kinds: ['image'] }] } },
      async handler() {
        const operations = batchOperations(services).map(describeOp);
        return { text: operations.map((o) => `- ${o.id}: ${o.label}${o.ai ? ' (AI)' : ''}. ${o.description}`).join('\n'), data: { operations } };
      },
    }),
    defineTool({
      name: 'run_batch',
      title: 'Process many files or documents',
      description:
        'Apply one operation (see list_batch_operations) to many library files ({assetId}) or project documents ({projectId, documentId}). Runs in the background; waits up to 20 seconds and returns the results so far, then check get_job with the job id. New files are tagged "batch" plus any tags you give. With edit-with-approval, document changes arrive as proposals.',
      category: 'assets',
      access: 'write',
      input: { operation: z.string(), params: z.record(z.string(), z.unknown()).default({}), targets: z.array(zTarget).min(1).max(500), tags: z.array(z.string().max(40)).max(10).optional() },
      output: z.object({ jobId: z.string(), status: z.string(), items: z.array(z.unknown()) }),
      example: { input: { operation: 'image.resize', params: { width: 1080, format: 'webp' }, targets: [{ assetId: '3f9a...' }, { assetId: '77c1...' }], tags: ['instagram'] }, output: { jobId: 'job_b1...', status: 'done', items: [{ label: 'beach.jpg', result: { status: 'done', outputAssetId: 'c0de...', outputName: 'beach-1080.webp' } }] } },
      async handler(args, ctx) {
        if (ctx.principal.mode === 'view') throw new ToolError('This connection is view-only.');
        for (const t of args.targets) if ('projectId' in t) await ctx.requireProject(t.projectId, 'write');
        let job: JobRecord<BatchInput>;
        try {
          job = await startBatch(services, ctx.principal.user, { operation: args.operation, params: args.params, targets: args.targets as BatchTarget[], ...(args.tags ? { tags: args.tags } : {}), author: ctx.principal.author, via: 'mcp', proposeOnly: ctx.principal.mode !== 'autonomous' });
        } catch (e) {
          throw new ToolError(e instanceof Error ? e.message : String(e));
        }
        const deadline = Date.now() + 20_000;
        let j: JobRecord | undefined = services.jobs.get(job.id);
        while (j && !['done', 'failed', 'cancelled'].includes(j.status) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 250));
          j = services.jobs.get(job.id);
        }
        const view = jobView(j ?? job);
        const lines = view.items.map((x) => `- ${x.label}: ${x.result ? `${x.result.status}${x.result.outputName ? ` → ${x.result.outputName} (${x.result.outputAssetId})` : ''}${x.result.proposalId ? ` → proposal ${x.result.proposalId}` : ''}${x.result.commitId ? ' → applied' : ''}${x.result.message ? ` (${x.result.message})` : ''}` : 'waiting'}`);
        return { text: `${view.title}: ${view.status}${view.status === 'running' || view.status === 'queued' ? ` (${Math.round(view.progress * 100)}%; check get_job ${view.id})` : ''}\n${lines.join('\n')}`, data: { jobId: view.id, status: view.status, items: view.items } };
      },
    }),
  ];
}

useModule(({ services, router }) => {
  for (const op of [...builtinBatchOperations(), ...documentOperations(services)]) registerBatchOperation(services, op);
  services.jobs.register<BatchInput, unknown>('batch', (jc) => runBatchJob(services, jc));
  registerToolProvider(services, () => batchTools(services));
  const r = express.Router();

  r.get(
    '/batch/operations',
    h(async (req, res) => {
      requireUser(req);
      res.json({ operations: batchOperations(services).map(describeOp) });
    }),
  );

  r.post(
    '/batch',
    h(async (req, res) => {
      const user = requireUser(req);
      const body = z.object({ operation: z.string(), params: z.record(z.string(), z.unknown()).default({}), targets: z.array(zTarget).min(1).max(1000), tags: z.array(z.string().max(40)).max(10).optional() }).parse(req.body);
      const job = await startBatch(services, user, { operation: body.operation, params: body.params, targets: body.targets as BatchTarget[], ...(body.tags ? { tags: body.tags } : {}) });
      res.status(202).json({ job: jobView(job) });
    }),
  );

  r.get(
    '/batch',
    h(async (req, res) => {
      const user = requireUser(req);
      const jobs = (await services.jobs.list({ ownerId: user.id })).filter((j) => j.kind === 'batch').slice(0, 30);
      res.json({ jobs: jobs.map(jobView) });
    }),
  );

  const own = (req: express.Request) => {
    const user = requireUser(req);
    const j = services.jobs.get(String(req.params.id));
    if (!j || j.kind !== 'batch' || j.ownerId !== user.id) throw new ProjectError('Batch not found', 404);
    return j;
  };
  r.get(
    '/batch/:id',
    h(async (req, res) => {
      res.json({ job: jobView(own(req)) });
    }),
  );
  r.post(
    '/batch/:id/cancel',
    h(async (req, res) => {
      services.jobs.cancel(own(req).id);
      res.json({ ok: true });
    }),
  );

  router.use(r);
});
