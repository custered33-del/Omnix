import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Services } from '../services.js';
import { useModule } from '../app.js';
import { h, requireUser } from '../http/middleware.js';
import { modeFromScopes, scopesForMode, type PermissionMode } from '../mcp/registry.js';
import { OMNIX_VERSION } from '../mcp/server.js';
import type { User } from '../auth/users.js';

/**
 * Claude connection overview for the dashboard: which credentials can act for this user,
 * in which permission mode, when Claude was last active, and what is waiting for review.
 * OAuth connector grants are added to `connections` by the OAuth module.
 */
export interface ConnectionSummary {
  id: string;
  kind: 'token' | 'oauth';
  name: string;
  mode: PermissionMode;
  projectIds: 'all' | string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export type ConnectionLister = (userId: string) => Promise<ConnectionSummary[]>;

export function registerConnectionLister(services: Services, lister: ConnectionLister): void {
  const list = (services.ext.connectionListers as ConnectionLister[] | undefined) ?? [];
  list.push(lister);
  services.ext.connectionListers = list;
}

export async function listConnections(services: Services, userId: string): Promise<ConnectionSummary[]> {
  const tokens = await services.users.listAccessTokens(userId);
  const out: ConnectionSummary[] = tokens.map((t) => ({ id: `pat:${t.id.slice(0, 12)}`, kind: 'token', name: t.name, mode: modeFromScopes(t.scopes), projectIds: 'all', createdAt: t.createdAt, lastUsedAt: t.lastUsedAt }));
  for (const l of (services.ext.connectionListers as ConnectionLister[] | undefined) ?? []) out.push(...(await l(userId)));
  return out;
}

/** One line of the connection test, with a fix when something is wrong. */
export interface SelfCheck {
  id: 'address' | 'mcp' | 'read' | 'write' | 'claude';
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  detail: string;
  /** What to do about it, in plain words. */
  fix?: string;
  /** Troubleshooting section that explains it further. */
  help?: string;
}

const TEST_TOKEN_NAME = 'Omnix connection test';
const TEST_PROJECT_NAME = 'Omnix connection test';

export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.local') || h === '0.0.0.0';
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** The small project the test writes its blank note into (created once, with AI allowed). */
async function testProject(services: Services, user: User): Promise<string> {
  const known = user.setup.testProjectId;
  if (known) {
    try {
      const meta = await services.projects.getMeta(known);
      if (services.projects.roleOf(meta, user.id) && !meta.archived) return meta.id;
    } catch {
      // Deleted: make a new one.
    }
  }
  const meta = await services.projects.create({ name: TEST_PROJECT_NAME, primaryTool: 'document', ownerId: user.id, author: { type: 'human', id: user.id, name: user.name }, aiConsent: true, description: 'Made by the Claude setup guide so the connection test has somewhere safe to write. You can delete it.' });
  await services.users.update(user.id, { setup: { ...user.setup, testProjectId: meta.id } });
  return meta.id;
}

/**
 * The setup guide's connection test. Omnix checks the address Claude will use, then connects to
 * its own MCP endpoint with a temporary token in the chosen permission mode, reads the project
 * list and writes a blank note, exactly as Claude would. Finally it reports whether Claude
 * itself has reached Omnix yet.
 */
export async function selfTest(services: Services, user: User, mode: PermissionMode): Promise<{ ok: boolean; checks: SelfCheck[]; testProjectId: string | null }> {
  const checks: SelfCheck[] = [];
  const publicUrl = services.config.publicUrl;
  let url: URL | null = null;
  try {
    url = new URL(publicUrl);
  } catch {
    url = null;
  }
  if (!url) {
    checks.push({ id: 'address', label: 'Address for Claude', status: 'fail', detail: `OMNIX_PUBLIC_URL is not a valid address (${publicUrl}).`, fix: 'Set OMNIX_PUBLIC_URL to the address people use to open Omnix, for example https://omnix.example.com, and restart Omnix.', help: 'https' });
  } else if (isLocalHost(url.hostname)) {
    checks.push({ id: 'address', label: 'Address for Claude', status: 'warn', detail: `Omnix is at ${publicUrl}, which only this computer (or network) can reach.`, fix: 'Claude Code and a local Claude Desktop setup can use this address. For claude.ai and the Claude apps, make Omnix reachable over HTTPS (for example with a tunnel) and set OMNIX_PUBLIC_URL to that address.', help: 'local-address' });
  } else if (url.protocol !== 'https:') {
    checks.push({ id: 'address', label: 'Address for Claude', status: 'fail', detail: `${publicUrl} uses plain HTTP. Claude only connects to connectors over HTTPS.`, fix: 'Put Omnix behind HTTPS (a reverse proxy with a certificate, or a tunnel) and set OMNIX_PUBLIC_URL to the https:// address.', help: 'https' });
  } else {
    try {
      const r = await fetch(`${publicUrl}/api/health`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      checks.push({ id: 'address', label: 'Address for Claude', status: 'pass', detail: `${publicUrl} reaches this Omnix server over HTTPS.` });
    } catch (e) {
      checks.push({ id: 'address', label: 'Address for Claude', status: 'fail', detail: `Omnix could not reach itself at ${publicUrl} (${(e as Error).message}).`, fix: 'Check that the tunnel or reverse proxy is running and forwards to this Omnix server, then try again.', help: 'unreachable' });
    }
  }

  let testProjectId: string | null = null;
  const port = services.ext.boundPort as number | undefined;
  const host = !services.config.host || services.config.host === '0.0.0.0' || services.config.host === '::' ? '127.0.0.1' : services.config.host;
  const { token, record } = await services.users.createAccessToken(user.id, TEST_TOKEN_NAME, scopesForMode(mode));
  const client = new Client({ name: 'omnix-connection-test', version: OMNIX_VERSION });
  try {
    if (!port) throw new Error('the server is not listening yet');
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://${host.includes(':') ? `[${host}]` : host}:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const tools = await client.listTools();
    const writes = tools.tools.filter((t) => t.annotations?.readOnlyHint === false).length;
    checks.push({ id: 'mcp', label: 'Omnix answers like a connector', status: 'pass', detail: `The MCP endpoint at ${publicUrl}/mcp offers ${tools.tools.length} tools${writes ? ` (${writes} can make changes)` : ''}.` });
    const list = await client.callTool({ name: 'list_projects', arguments: {} });
    if (list.isError) throw Object.assign(new Error(textOfResult(list)), { step: 'read' });
    const projects = ((list.structuredContent as { projects?: unknown[] } | undefined)?.projects ?? []).length;
    checks.push({ id: 'read', label: 'Read your project list', status: 'pass', detail: `Claude would see ${projects} ${projects === 1 ? 'project' : 'projects'}.` });
    if (mode === 'view') {
      checks.push({ id: 'write', label: 'Create a blank test note', status: 'skip', detail: 'Skipped: with View only, Claude cannot change anything. That is expected.' });
    } else {
      testProjectId = await testProject(services, (await services.users.byId(user.id)) ?? user);
      const note = await client.callTool({ name: 'add_note', arguments: { projectId: testProjectId, kind: 'note', text: '' } });
      if (note.isError) throw Object.assign(new Error(textOfResult(note)), { step: 'write' });
      const status = (note.structuredContent as { status?: string } | undefined)?.status;
      checks.push({
        id: 'write',
        label: 'Create a blank test note',
        status: 'pass',
        detail: status === 'proposed' ? `The blank note is waiting for your approval in "${TEST_PROJECT_NAME}". That is how Edit with approval works: Claude proposes, you decide.` : `A blank note was added to "${TEST_PROJECT_NAME}". With Autonomous, Claude's changes apply right away (and can be undone).`,
      });
    }
  } catch (e) {
    const step = (e as { step?: 'read' | 'write' }).step;
    const msg = (e as Error).message;
    if (!checks.some((c) => c.id === 'mcp')) checks.push({ id: 'mcp', label: 'Omnix answers like a connector', status: 'fail', detail: `The MCP endpoint did not answer: ${msg}`, fix: 'Restart Omnix and look at its log for errors. If you run Omnix behind a proxy, make sure /mcp is forwarded with streaming enabled.', help: 'mcp' });
    else if (step === 'write') checks.push({ id: 'write', label: 'Create a blank test note', status: 'fail', detail: msg, fix: 'Make sure the test project allows AI (Project settings → Allow AI), then run the test again.', help: 'permissions' });
    else checks.push({ id: 'read', label: 'Read your project list', status: 'fail', detail: msg, fix: 'Run the test again. If it keeps failing, check the Omnix log.', help: 'permissions' });
  } finally {
    await client.close().catch(() => {});
    await services.users.revokeAccessToken(user.id, record.id);
  }

  const conns = (await listConnections(services, user.id)).filter((c) => c.name !== TEST_TOKEN_NAME);
  const used = conns.filter((c) => c.lastUsedAt).sort((a, b) => b.lastUsedAt!.localeCompare(a.lastUsedAt!));
  if (!conns.length) checks.push({ id: 'claude', label: 'Claude has connected', status: 'warn', detail: 'Claude has not connected to Omnix yet.', fix: 'Finish adding the connector in Claude (steps 3 and 4), then come back and run this again.', help: 'no-connection' });
  else if (!used.length) checks.push({ id: 'claude', label: 'Claude has connected', status: 'warn', detail: `Claude is set up (${conns.map((c) => c.name).join(', ')}) but has not called Omnix yet.`, fix: 'In a new Claude chat, ask: "List my Omnix projects." Then run this again.', help: 'no-calls' });
  else checks.push({ id: 'claude', label: 'Claude has connected', status: 'pass', detail: `${used[0]!.name} last reached Omnix ${ago(used[0]!.lastUsedAt!)} (${used[0]!.mode === 'view' ? 'View only' : used[0]!.mode === 'approve' ? 'Edit with approval' : 'Autonomous'}).` });
  return { ok: !checks.some((c) => c.status === 'fail'), checks, testProjectId };
}

function textOfResult(r: unknown): string {
  const content = (r as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? '').join(' ').trim() || 'The tool reported an error';
}

useModule(({ services, router }) => {
  router.post(
    '/claude/self-test',
    h(async (req, res) => {
      const user = requireUser(req);
      const body = z.object({ mode: z.enum(['view', 'approve', 'autonomous']).optional() }).parse(req.body ?? {});
      res.json(await selfTest(services, user, body.mode ?? user.setup.preset ?? 'approve'));
    }),
  );

  /** What the setup guide explains: where Omnix keeps data and the address to give Claude. */
  router.get(
    '/claude/setup-info',
    h(async (req, res) => {
      const user = requireUser(req);
      const url = new URL(services.config.publicUrl);
      res.json({
        publicUrl: services.config.publicUrl,
        mcpUrl: `${services.config.publicUrl}/mcp`,
        local: isLocalHost(url.hostname),
        https: url.protocol === 'https:',
        storage: services.store.kind,
        blobs: services.blobs.kind,
        ...(user.role === 'owner' && services.store.kind === 'file' ? { dataDir: services.config.dataDir } : {}),
        // Where Omnix is installed, for the Claude Desktop config snippet (owner only).
        ...(user.role === 'owner' ? { installDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..') } : {}),
        aiKey: !!services.config.anthropicApiKey,
      });
    }),
  );

  router.get(
    '/claude/status',
    h(async (req, res) => {
      const user = requireUser(req);
      const connections = await listConnections(services, user.id);
      const projects = await services.projects.listForUser(user.id);
      const ids = new Set(projects.map((p) => p.id));
      const lastAi = (await services.activity.list({ projectIds: ids, actorType: 'ai', limit: 1 }))[0] ?? null;
      const jobs = await services.jobs.list({ ownerId: user.id, status: ['running', 'queued', 'awaiting_approval'] });
      let openProposals = 0;
      const proposalsByProject: { projectId: string; name: string; count: number }[] = [];
      for (const p of projects) {
        // Only count proposals in sessions that are already loaded or small; loading every project would be wasteful.
        const session = await services.projects.session(p.id);
        const n = session.listProposals('open').length;
        if (n) {
          openProposals += n;
          proposalsByProject.push({ projectId: p.id, name: p.name, count: n });
        }
      }
      res.json({
        connected: connections.length > 0,
        connections,
        lastActivity: lastAi ? { ts: lastAi.ts, summary: lastAi.summary, projectId: lastAi.projectId, projectName: lastAi.projectName } : null,
        jobs: {
          running: jobs.filter((j) => j.status === 'running' || j.status === 'queued').filter((j) => j.kind.startsWith('agent')).length,
          awaitingApproval: jobs.filter((j) => j.status === 'awaiting_approval').length,
          list: jobs.filter((j) => j.kind.startsWith('agent')).slice(0, 5).map((j) => ({ id: j.id, title: j.title, status: j.status, progress: j.progress, projectId: j.projectId, message: j.message })),
        },
        openProposals,
        proposalsByProject,
        mcpUrl: `${services.config.publicUrl}/mcp`,
      });
    }),
  );
});
