import type { Services } from '../services.js';
import { useModule } from '../app.js';
import { h, requireUser } from '../http/middleware.js';
import { modeFromScopes, type PermissionMode } from '../mcp/registry.js';

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

useModule(({ services, router }) => {
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
