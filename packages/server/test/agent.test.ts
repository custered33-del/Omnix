import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { childrenOf, documentBlocks, notesContainer, type ProjectState, type SceneNode } from '@omnix/core';
import { startTestServer, json, type TestServer } from './helpers.js';

/**
 * The autonomous agent runner against a fake Claude API: scripted model turns drive the real
 * runner, tools, checkpoints and approval gates end to end.
 */

type Turn = { content: unknown[]; stop_reason: string } | { status: number; body: unknown };
type Script = (req: { messages: { role: string; content: unknown }[]; tools?: { name: string }[]; model: string; system?: string }) => Turn;

const fake = {
  server: null as http.Server | null,
  url: '',
  script: [] as Script[],
  requests: [] as { messages: { role: string; content: unknown }[]; tools?: { name: string }[]; model: string; system?: string }[],
  modelLookups: 0,
};

let n = 0;
const toolUse = (name: string, input: Record<string, unknown>): Turn => ({ content: [{ type: 'text', text: `Calling ${name}` }, { type: 'tool_use', id: `tu_${++n}`, name, input }], stop_reason: 'tool_use' });
const say = (text: string): Turn => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });

/** The text of the tool results in the latest user message. */
function lastResults(req: { messages: { role: string; content: unknown }[] }): string {
  const last = req.messages[req.messages.length - 1]!;
  if (typeof last.content === 'string') return last.content;
  return (last.content as { type: string; content?: unknown; is_error?: boolean }[])
    .map((b) => `${b.is_error ? '[error] ' : ''}${typeof b.content === 'string' ? b.content : (b.content as { type: string; text?: string }[]).map((x) => x.text ?? `[${x.type}]`).join('\n')}`)
    .join('\n');
}

let ts: TestServer;

async function waitRun(id: string, statuses: string[], ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const run = (await json(await ts.api(`/api/agent/runs/${id}`))).run;
    if (statuses.includes(run.status)) return run;
    if (Date.now() > end) throw new Error(`run ${id} is ${run.status} (${run.error ?? run.message}), wanted ${statuses.join('/')}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function decide(id: string, decision: 'approve' | 'changes' | 'stop', extra: Record<string, unknown> = {}) {
  const r = await ts.api(`/api/agent/runs/${id}/decision`, { method: 'POST', json: { decision, ...extra } });
  if (r.status !== 200) throw new Error(`decision failed: ${await r.text()}`);
  return (await json(r)).run;
}

const state = async (projectId: string) => (await json(await ts.api(`/api/projects/${projectId}`))).state as ProjectState;

async function docProject(aiConsent = true) {
  const p = (await json(await ts.api('/api/projects', { method: 'POST', json: { name: 'Launch note', primaryTool: 'document', aiConsent } }))).project;
  const s = await state(p.id);
  return { id: p.id as string, doc: childrenOf(s, s.rootId).find((x) => x.type === 'document')!.id };
}

beforeAll(async () => {
  fake.server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    res.setHeader('content-type', 'application/json');
    if (req.headers['x-api-key'] !== 'test-key') {
      res.writeHead(401);
      return res.end(JSON.stringify({ error: { message: 'bad key' } }));
    }
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      fake.modelLookups++;
      return res.end(JSON.stringify({ data: [{ id: 'claude-test-newest' }, { id: 'claude-test-older' }] }));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    fake.requests.push(body);
    const next = fake.script.shift();
    if (!next) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: { message: 'script exhausted' } }));
    }
    const turn = next(body);
    if ('status' in turn) {
      res.writeHead(turn.status);
      return res.end(JSON.stringify(turn.body));
    }
    res.end(JSON.stringify({ id: `msg_${fake.requests.length}`, model: body.model, ...turn, usage: { input_tokens: 100, output_tokens: 20 } }));
  });
  await new Promise<void>((r) => fake.server!.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${(fake.server!.address() as { port: number }).port}`;
  ts = await startTestServer();
  Object.assign(ts.omnix.config, { anthropicApiKey: 'test-key', anthropicBaseUrl: fake.url, agentModel: null });
  delete ts.omnix.services.ext.anthropic;
});

afterAll(async () => {
  await ts?.close();
  fake.server?.close();
});

beforeEach(() => {
  fake.script = [];
  fake.requests = [];
});

describe('built-in agent runner', () => {
  it('plans, works, checkpoints and pauses at each gate the person chose', async () => {
    const p = await docProject();
    fake.script = [
      () => toolUse('plan_stages', { stages: ['Write the note', 'Export it'] }),
      (req) => {
        expect(lastResults(req)).toMatch(/approved "Approve the plan".*Keep it short/);
        return toolUse('doc_insert_markdown', { projectId: p.id, documentId: p.doc, markdown: 'Omnix ships **today**.' });
      },
      (req) => {
        expect(lastResults(req)).toMatch(/^Done: /);
        return toolUse('checkpoint', { summary: 'Wrote a one-line note.' });
      },
      () => toolUse('export_file', { projectId: p.id, nodeId: p.doc, format: 'md' }),
      (req) => {
        expect(lastResults(req)).toMatch(/api\/files\//);
        return toolUse('checkpoint', { summary: 'Exported as Markdown.' });
      },
      () => toolUse('finish', { summary: 'The note is written and exported.' }),
    ];
    const started = await ts.api(`/api/projects/${p.id}/agent`, { method: 'POST', json: { goal: 'Write a one-line launch note and export it' } });
    expect(started.status).toBe(201);
    const id = (await json(started)).run.id as string;

    let run = await waitRun(id, ['awaiting_approval']);
    expect(run.pendingGate).toMatchObject({ kind: 'plan', title: 'Approve the plan' });
    expect(run.plan.map((s: { title: string }) => s.title)).toEqual(['Write the note', 'Export it']);
    await decide(id, 'approve', { feedback: 'Keep it short' });

    run = await waitRun(id, ['awaiting_approval']);
    expect(run.pendingGate.kind).toBe('stage');
    expect(run.checkpoints).toHaveLength(1);
    // Nothing runs while paused.
    const before = fake.requests.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.requests.length).toBe(before);
    await decide(id, 'approve');

    run = await waitRun(id, ['awaiting_approval']);
    expect(run.pendingGate).toMatchObject({ kind: 'export' });
    expect(run.pendingGate.tool.name).toBe('export_file');
    await decide(id, 'approve');

    run = await waitRun(id, ['awaiting_approval']);
    expect(run.pendingGate.kind).toBe('stage');
    await decide(id, 'approve');

    run = await waitRun(id, ['done']);
    expect(run.summary).toBe('The note is written and exported.');
    expect(run.plan.every((s: { status: string }) => s.status === 'done')).toBe(true);
    expect(run.decisions.map((d: { decision: string }) => d.decision)).toEqual(['approve', 'approve', 'approve', 'approve']);
    expect(run.usage.input).toBe(600);

    // The model came from the Models API (newest first) and saw Omnix's tools plus the run controls.
    expect(fake.modelLookups).toBe(1);
    expect(fake.requests[0]!.model).toBe('claude-test-newest');
    const names = fake.requests[0]!.tools!.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['plan_stages', 'checkpoint', 'request_approval', 'finish', 'doc_insert_markdown', 'render_preview']));
    expect(names).not.toContain('agent_start_run');
    expect(fake.requests[0]!.system).toMatch(/approves your plan/);

    // Changes are attributed to Claude and the run; checkpoints are named versions.
    const s = await state(p.id);
    expect(documentBlocks(s, p.doc).some((b) => b.props.text === 'Omnix ships **today**.')).toBe(true);
    const history = (await json(await ts.api(`/api/projects/${p.id}/history`))).commits as { author: { type: string; name: string }; jobId?: string; label: string }[];
    const mine = history.filter((c) => c.jobId === id);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((c) => c.author.type === 'ai' && c.author.name === 'Claude')).toBe(true);
    const snaps = (await json(await ts.api(`/api/projects/${p.id}/history`))).snapshots as { name: string }[];
    expect(snaps.map((x) => x.name)).toEqual(['Claude: Write the note', 'Claude: Export it']);
    // Session memory: the goal, the note given at a gate, and the result.
    const notes = (childrenOf(s, notesContainer(s).id) as SceneNode<'note'>[]).map((x) => `${x.props.kind}: ${x.props.text}`);
    expect(notes).toEqual(expect.arrayContaining([expect.stringMatching(/^prompt: Agent goal: Write a one-line/), expect.stringMatching(/^decision: Approve the plan: Keep it short/), expect.stringMatching(/^decision: Agent finished/)]));
    // Activity shows the agent's tool calls.
    const activity = (await json(await ts.api(`/api/activity?projectId=${p.id}`))).entries as { via: string; tool?: string }[];
    expect(activity.some((e) => e.via === 'agent' && e.tool === 'doc_insert_markdown')).toBe(true);
  });

  it('declines a gated deletion with feedback, then stops and rolls back on request', async () => {
    const p = await docProject();
    const s0 = await state(p.id);
    const firstBlock = documentBlocks(s0, p.doc)[0]!.id;
    fake.script = [
      () => toolUse('doc_insert_markdown', { projectId: p.id, documentId: p.doc, markdown: 'Draft line one.' }),
      () => toolUse('delete_node', { projectId: p.id, nodeId: firstBlock }),
      (req) => {
        expect(lastResults(req)).toMatch(/\[error\] Not run: Seb declined.*keep the title/);
        return toolUse('request_approval', { title: 'Tone check', summary: 'Formal or playful?' });
      },
    ];
    const id = (await json(await ts.api(`/api/projects/${p.id}/agent`, { method: 'POST', json: { goal: 'Tidy the note', gates: [{ kind: 'delete' }] } }))).run.id;
    let run = await waitRun(id, ['awaiting_approval']);
    expect(run.pendingGate).toMatchObject({ kind: 'delete' });
    await decide(id, 'changes', { feedback: 'Please keep the title' });
    run = await waitRun(id, ['awaiting_approval']);
    expect(run.pendingGate).toMatchObject({ kind: 'custom', title: 'Tone check', summary: 'Formal or playful?' });
    expect((await state(p.id)).nodes[firstBlock]).toBeTruthy();
    expect(documentBlocks(await state(p.id), p.doc).some((b) => b.props.text === 'Draft line one.')).toBe(true);
    // Stop and undo everything the run did.
    run = await decide(id, 'stop', { rollbackTo: 'start' });
    expect(run.status).toBe('cancelled');
    const s = await state(p.id);
    expect(documentBlocks(s, p.doc).some((b) => b.props.text === 'Draft line one.')).toBe(false);
    const notes = (childrenOf(s, notesContainer(s).id) as SceneNode<'note'>[]).map((x) => `${x.props.kind}: ${x.props.text}`);
    expect(notes).toEqual(expect.arrayContaining([expect.stringMatching(/^rejected: At "Before deleting \(delete_node\)" Seb asked for changes: Please keep the title/)]));
  });

  it('fails clearly on API errors and can be retried from where it stopped', async () => {
    const p = await docProject();
    fake.script = [() => toolUse('add_note', { projectId: p.id, kind: 'decision', text: 'Use the blue palette.' }), () => ({ status: 400, body: { error: { message: 'prompt is too long' } } })];
    const id = (await json(await ts.api(`/api/projects/${p.id}/agent`, { method: 'POST', json: { goal: 'Note the palette', gates: [] } }))).run.id;
    let run = await waitRun(id, ['failed']);
    expect(run.error).toMatch(/Claude API error 400: prompt is too long/);
    fake.script = [
      (req) => {
        // The conversation resumes with the earlier tool result intact.
        expect(JSON.stringify(req.messages)).toMatch(/Use the blue palette/);
        return say('All set: the palette decision is recorded.');
      },
    ];
    expect((await ts.api(`/api/agent/runs/${id}/retry`, { method: 'POST' })).status).toBe(200);
    run = await waitRun(id, ['done']);
    expect(run.summary).toBe('All set: the palette decision is recorded.');
  });

  it('pauses when the step budget runs out', async () => {
    const p = await docProject();
    fake.script = Array.from({ length: 5 }, (_, i) => () => toolUse('add_note', { projectId: p.id, text: `Step ${i}` }));
    fake.script.push(() => toolUse('finish', { summary: 'Done.' }));
    const id = (await json(await ts.api(`/api/projects/${p.id}/agent`, { method: 'POST', json: { goal: 'Take notes', gates: [], maxSteps: 5 } }))).run.id;
    let run = await waitRun(id, ['awaiting_approval']);
    expect(run.pendingGate.kind).toBe('budget');
    await decide(id, 'approve');
    run = await waitRun(id, ['done']);
    expect(run.maxSteps).toBe(45);
  });

  it('needs AI consent and an API key', async () => {
    const p = await docProject(false);
    const r = await ts.api(`/api/projects/${p.id}/agent`, { method: 'POST', json: { goal: 'Anything' } });
    expect(r.status).toBe(403);
    expect((await json(r)).error).toMatch(/Allow AI/);
    const status = await json(await ts.api('/api/agent/status'));
    expect(status.available).toBe(true);
  });

  it('hands natural-language commands it cannot parse to Claude as one proposal', async () => {
    const p = await docProject();
    fake.script = [
      (req) => {
        expect(req.system).toMatch(/typed a command/);
        expect(req.tools!.map((t) => t.name)).not.toContain('plan_stages');
        return toolUse('doc_insert_markdown', { projectId: p.id, documentId: p.doc, markdown: '## Risks\n\n- Timeline' });
      },
      () => toolUse('doc_insert_markdown', { projectId: p.id, documentId: p.doc, markdown: '- Budget' }),
      () => toolUse('finish', { summary: 'Added a risks section.' }),
    ];
    const r = await json(await ts.api(`/api/projects/${p.id}/commands`, { method: 'POST', json: { text: 'write a short risks section with two bullets', documentId: p.doc } }));
    expect(r.status).toBe('delegated');
    await waitRun(r.runId, ['done']);
    const proposals = (await json(await ts.api(`/api/projects/${p.id}/proposals?status=open`))).proposals as { author: { name: string }; jobId: string; steps?: string[]; ops: unknown[] }[];
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ author: { name: 'Claude' }, jobId: r.runId });
    expect(proposals[0]!.steps).toHaveLength(2);
    // Nothing changed yet.
    expect(documentBlocks(await state(p.id), p.doc).some((b) => b.props.text === 'Risks')).toBe(false);
  });
});

describe('agent runs driven by Claude over MCP', () => {
  it('holds writes while paused, gates exports, and records checkpoints', async () => {
    const p = await docProject();
    const { token } = await json(await ts.api('/api/auth/tokens', { method: 'POST', json: { name: 'Claude', scopes: ['omnix:read', 'omnix:edit', 'omnix:autonomous'] } }));
    const c = new Client({ name: 'claude', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${ts.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await c.callTool({ name, arguments: args });
      return { error: r.isError ? JSON.stringify(r.content) : null, data: r.structuredContent as Record<string, any> };
    };
    try {
      const start = await call('agent_start_run', { projectId: p.id, goal: 'Draft and export the launch note', plan: ['Draft', 'Export'] });
      expect(start.error).toBeNull();
      const runId = start.data.runId as string;
      expect(start.data).toMatchObject({ status: 'awaiting_approval', pendingGate: { title: 'Approve the plan' } });
      // Paused: writes on that project are held.
      const held = await call('add_note', { projectId: p.id, text: 'too early' });
      expect(held.error).toMatch(/paused for approval/);
      // Nobody answered yet.
      const waiting = await call('agent_wait', { runId, timeoutSeconds: 1 });
      expect(waiting.data.status).toBe('awaiting_approval');
      setTimeout(() => void decide(runId, 'approve', { feedback: 'Go' }), 200);
      const answer = await call('agent_wait', { runId, timeoutSeconds: 10 });
      expect(answer.data).toMatchObject({ status: 'running', decision: { decision: 'approve', feedback: 'Go' } });
      const w = await call('doc_insert_markdown', { projectId: p.id, documentId: p.doc, markdown: 'Launching soon.' });
      expect(w.error).toBeNull();
      const cp = await call('agent_checkpoint', { runId, summary: 'Drafted the note.' });
      // The stage being reviewed stays current until it is approved.
      expect(cp.data).toMatchObject({ status: 'awaiting_approval', stage: 'Draft' });
      await decide(runId, 'approve');
      expect((await call('agent_wait', { runId, timeoutSeconds: 5 })).data.stage).toBe('Export');
      // Exporting is gated: the first attempt pauses, the same call after approval goes through.
      const ex1 = await call('export_file', { projectId: p.id, nodeId: p.doc, format: 'md' });
      expect(ex1.error).toMatch(/Paused for the user's approval \(Before exporting/);
      await decide(runId, 'approve');
      await call('agent_wait', { runId, timeoutSeconds: 5 });
      const ex2 = await call('export_file', { projectId: p.id, nodeId: p.doc, format: 'md' });
      expect(ex2.error).toBeNull();
      expect(ex2.data.url).toMatch(/\/api\/files\//);
      const done = await call('agent_finish', { runId, summary: 'Drafted and exported.' });
      expect(done.data.status).toBe('done');
      const run = (await json(await ts.api(`/api/agent/runs/${runId}`))).run;
      expect(run.driver).toBe('external');
      expect(run.checkpoints).toHaveLength(1);
      const history = (await json(await ts.api(`/api/projects/${p.id}/history`))).commits as { jobId?: string; label: string }[];
      expect(history.some((h) => h.jobId === runId)).toBe(true);
      // Approve-mode connections cannot start autonomous runs.
      const { token: t2 } = await json(await ts.api('/api/auth/tokens', { method: 'POST', json: { name: 'Claude review', scopes: ['omnix:read', 'omnix:edit'] } }));
      const c2 = new Client({ name: 'claude2', version: '1' });
      await c2.connect(new StreamableHTTPClientTransport(new URL(`${ts.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${t2}` } } }));
      const refused = await c2.callTool({ name: 'agent_start_run', arguments: { projectId: p.id, goal: 'x' } });
      expect(JSON.stringify(refused.content)).toMatch(/autonomous connection/);
      await c2.close();
    } finally {
      await c.close();
    }
  });

  it('keeps working on a stage when the person asks for changes at its review', async () => {
    const p = await docProject();
    const { token } = await json(await ts.api('/api/auth/tokens', { method: 'POST', json: { name: 'Claude', scopes: ['omnix:read', 'omnix:edit', 'omnix:autonomous'] } }));
    const c = new Client({ name: 'claude', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${ts.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })).structuredContent as Record<string, any>;
    try {
      const runId = (await call('agent_start_run', { projectId: p.id, goal: 'Draft and polish', plan: ['Draft', 'Polish'] })).runId as string;
      await decide(runId, 'approve');
      await call('agent_wait', { runId, timeoutSeconds: 5 });
      expect((await call('agent_checkpoint', { runId, summary: 'First draft.' })).checkpoint ?? {}).toBeDefined();
      await decide(runId, 'changes', { feedback: 'Shorter, please.' });
      expect((await call('agent_wait', { runId, timeoutSeconds: 5 })).stage).toBe('Draft');
      let run = (await json(await ts.api(`/api/agent/runs/${runId}`))).run;
      expect(run.plan.map((s: { status: string }) => s.status)).toEqual(['active', 'pending']);
      // The revision is checkpointed, and saved as a version, under the same stage.
      const again = await call('agent_checkpoint', { runId, summary: 'Shorter draft.' });
      expect(again).toMatchObject({ stage: 'Draft', status: 'awaiting_approval' });
      run = (await json(await ts.api(`/api/agent/runs/${runId}`))).run;
      expect(run.checkpoints.map((cp: { stage: string }) => cp.stage)).toEqual(['Draft', 'Draft']);
      await decide(runId, 'approve');
      expect((await call('agent_wait', { runId, timeoutSeconds: 5 })).stage).toBe('Polish');
      run = (await json(await ts.api(`/api/agent/runs/${runId}`))).run;
      expect(run.plan.map((s: { status: string }) => s.status)).toEqual(['done', 'active']);
      const versions = (await json(await ts.api(`/api/projects/${p.id}/history`))).snapshots as { name: string }[];
      expect(versions.filter((v) => v.name === 'Claude: Draft')).toHaveLength(2);
    } finally {
      await c.close();
    }
  });

  it('gates exports and deletions made through batches, merges and plugins, and holds batch writes while paused', async () => {
    const p = await docProject();
    const { token } = await json(await ts.api('/api/auth/tokens', { method: 'POST', json: { name: 'Claude', scopes: ['omnix:read', 'omnix:edit', 'omnix:autonomous'] } }));
    const c = new Client({ name: 'claude', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${ts.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await c.callTool({ name, arguments: args });
      return { error: r.isError ? JSON.stringify(r.content) : null, data: r.structuredContent as Record<string, any> };
    };
    const svg = (fill: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="${fill}"/><circle cx="9" cy="9" r="5" fill="#fff"/></svg>`);
    const up = async (name: string, fill: string) => (await json(await ts.api(`/api/assets?name=${name}`, { method: 'POST', body: new Uint8Array(svg(fill)), headers: { 'content-type': 'image/svg+xml' } }))).asset ?? (await json(await ts.api(`/api/assets?name=${name}`, { method: 'POST', body: new Uint8Array(svg(fill)), headers: { 'content-type': 'image/svg+xml' } })));
    try {
      // Claude is told which tools can remove content.
      const tools = (await c.listTools()).tools;
      const hint = (name: string) => tools.find((t) => t.name === name)?.annotations?.destructiveHint;
      expect(hint('delete_node')).toBe(true);
      expect(hint('merge_assets')).toBe(true);
      expect(hint('doc_insert_markdown')).toBe(false);

      const start = await call('agent_start_run', { projectId: p.id, goal: 'Tidy up and export', plan: ['Tidy'] });
      const runId = start.data.runId as string;
      // While the plan waits for approval, a batch on the project is held like any other write.
      const held = await call('run_batch', { operation: 'document.command', params: { text: 'make the headings bold' }, targets: [{ projectId: p.id, documentId: p.doc }] });
      expect(held.error).toMatch(/paused for approval/);
      // The run's own tools keep working while it is paused.
      expect((await call('agent_status', { runId })).error).toBeNull();
      await decide(runId, 'approve');
      await call('agent_wait', { runId, timeoutSeconds: 5 });

      // Exporting many documents at once is still exporting.
      const ex = await call('run_batch', { operation: 'document.export', params: { format: 'md' }, targets: [{ projectId: p.id, documentId: p.doc }] });
      expect(ex.error).toMatch(/Paused for the user's approval \(Before exporting \(run_batch\)\)/);
      let run = (await json(await ts.api(`/api/agent/runs/${runId}`))).run;
      expect(run.pendingGate).toMatchObject({ kind: 'export', summary: 'Export 1 document as MD: Launch note.' });
      await decide(runId, 'approve');
      await call('agent_wait', { runId, timeoutSeconds: 5 });
      const ex2 = await call('run_batch', { operation: 'document.export', params: { format: 'md' }, targets: [{ projectId: p.id, documentId: p.doc }] });
      expect(ex2.error).toBeNull();

      // A command that removes things, and a merge that removes library files, wait for approval too.
      const rm = await call('run_command', { projectId: p.id, documentId: p.doc, text: 'delete the second paragraph' });
      expect(rm.error).toMatch(/Before deleting \(run_command\)/);
      await decide(runId, 'approve');
      await call('agent_wait', { runId, timeoutSeconds: 5 });
      const a = await up('merge-keep.svg', '#2266aa');
      const b = await up('merge-drop.svg', '#aa2266');
      const merge = await call('merge_assets', { keep: a.id, drop: [b.id] });
      expect(merge.error).toMatch(/Before deleting \(merge_assets\)/);
      run = (await json(await ts.api(`/api/agent/runs/${runId}`))).run;
      expect(run.pendingGate.summary).toMatch(/remove the copies/);
      await decide(runId, 'stop');
      // The file was not merged away.
      expect((await ts.api(`/api/assets/${b.id}`)).status).toBe(200);
    } finally {
      await c.close();
    }
  });
});
