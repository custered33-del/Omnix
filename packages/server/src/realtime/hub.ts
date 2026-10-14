import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { newId, zOperation } from '@omnix/core';
import type { Services } from '../services.js';
import { authorOf, type User } from '../auth/users.js';
import type { ProjectEvent } from '../projects/service.js';
import type { ActivityEntry } from '../projects/activity.js';
import type { JobRecord } from '../jobs/queue.js';
import type { PresenceState } from './presence.js';
import { SESSION_COOKIE } from '../http/middleware.js';

/**
 * Realtime collaboration over WebSocket (`/ws`): project commits fan out to every open editor,
 * along with presence (live cursors and selections), proposals, activity and job progress.
 */
const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('join'), projectId: z.string() }),
  z.object({ type: z.literal('leave'), projectId: z.string() }),
  z.object({
    type: z.literal('presence'),
    projectId: z.string(),
    location: z
      .object({
        tool: z.enum(['image', 'video', 'animation', 'code', 'document', 'slides', 'dashboard']),
        nodeId: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        time: z.number().optional(),
        line: z.number().optional(),
        blockId: z.string().optional(),
      })
      .nullable()
      .optional(),
    selection: z.array(z.string()).max(500).optional(),
  }),
  z.object({ type: z.literal('commit'), projectId: z.string(), clientOpId: z.string(), op: zOperation, label: z.string().max(200).optional(), baseHead: z.string().nullable().optional() }),
  z.object({ type: z.literal('ping') }),
]);

interface Client {
  id: string;
  ws: WebSocket;
  user: User;
  projects: Set<string>;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class RealtimeHub {
  private wss: WebSocketServer;
  private clients = new Map<string, Client>();
  /** Recently applied client op ids -> commit id, so retried sends are acknowledged, not re-applied. */
  private seenOps = new Map<string, string>();

  constructor(
    private readonly services: Services,
    server: HttpServer,
  ) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') return;
      void this.authenticate(req).then((user) => {
        if (!user) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, user));
      });
    });

    services.projects.on('event', (e: ProjectEvent) => this.onProjectEvent(e));
    services.activity.on('entry', (e: ActivityEntry) => void this.onActivity(e));
    services.jobs.on('update', (j: JobRecord) => this.toUser(j.ownerId, { type: 'job', job: summarizeJob(j) }));
    services.presence.on('update', (p: PresenceState) => this.toProject(p.projectId, { type: 'presence', state: p }));
    services.presence.on('leave', (p: PresenceState) => this.toProject(p.projectId, { type: 'presence-leave', clientId: p.clientId }));
    const ping = setInterval(() => {
      for (const c of this.clients.values()) if (c.ws.readyState === WebSocket.OPEN) c.ws.ping();
    }, 25_000);
    ping.unref();
  }

  private async authenticate(req: IncomingMessage): Promise<User | undefined> {
    const cookies = parseCookies(req.headers.cookie);
    const fromCookie = await this.services.users.userForSession(cookies[SESSION_COOKIE]);
    if (fromCookie) return fromCookie;
    const token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
    if (token) return (await this.services.users.resolveAccessToken(token))?.user;
    return undefined;
  }

  private onConnection(ws: WebSocket, user: User): void {
    const client: Client = { id: newId('ws'), ws, user, projects: new Set() };
    this.clients.set(client.id, client);
    this.send(client, { type: 'hello', clientId: client.id, userId: user.id });
    ws.on('message', (raw) => void this.onMessage(client, raw.toString()));
    ws.on('close', () => {
      this.clients.delete(client.id);
      this.services.presence.leave(client.id);
    });
  }

  private send(c: Client, msg: unknown): void {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  }

  private toProject(projectId: string, msg: unknown, except?: string): void {
    for (const c of this.clients.values()) if (c.projects.has(projectId) && c.id !== except) this.send(c, msg);
  }

  private toUser(userId: string, msg: unknown): void {
    for (const c of this.clients.values()) if (c.user.id === userId) this.send(c, msg);
  }

  private async onMessage(c: Client, raw: string): Promise<void> {
    let msg: z.infer<typeof ClientMessage>;
    try {
      msg = ClientMessage.parse(JSON.parse(raw));
    } catch (e) {
      this.send(c, { type: 'error', error: 'Malformed message' });
      return;
    }
    try {
      switch (msg.type) {
        case 'ping':
          this.send(c, { type: 'pong', t: Date.now() });
          break;
        case 'join': {
          await this.services.projects.requireAccess(msg.projectId, c.user.id, 'read');
          c.projects.add(msg.projectId);
          const session = await this.services.projects.session(msg.projectId);
          this.services.presence.update(c.id, msg.projectId, authorOf(c.user), {});
          this.send(c, { type: 'joined', projectId: msg.projectId, head: session.head, presence: this.services.presence.inProject(msg.projectId) });
          break;
        }
        case 'leave':
          c.projects.delete(msg.projectId);
          this.services.presence.leave(c.id);
          break;
        case 'presence':
          if (!c.projects.has(msg.projectId)) return;
          this.services.presence.update(c.id, msg.projectId, authorOf(c.user), {
            ...(msg.location !== undefined ? { location: msg.location } : {}),
            ...(msg.selection ? { selection: msg.selection } : {}),
          });
          break;
        case 'commit': {
          await this.services.projects.requireAccess(msg.projectId, c.user.id, 'write');
          const dedupeKey = `${c.user.id}:${msg.clientOpId}`;
          const already = this.seenOps.get(dedupeKey);
          if (already) {
            this.send(c, { type: 'ack', clientOpId: msg.clientOpId, commitId: already, duplicate: true });
            break;
          }
          try {
            const commit = await this.services.projects.commit(msg.projectId, msg.op, authorOf(c.user), {
              ...(msg.label ? { label: msg.label } : {}),
              via: 'ui',
              clientOpId: msg.clientOpId,
              ...(msg.baseHead !== undefined ? { baseHead: msg.baseHead } : {}),
            });
            this.seenOps.set(dedupeKey, commit.id);
            if (this.seenOps.size > 5000) this.seenOps.delete(this.seenOps.keys().next().value!);
            this.send(c, { type: 'ack', clientOpId: msg.clientOpId, commitId: commit.id });
          } catch (e) {
            this.send(c, { type: 'nack', clientOpId: msg.clientOpId, error: e instanceof Error ? e.message : String(e) });
          }
          break;
        }
      }
    } catch (e) {
      this.send(c, { type: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  private onProjectEvent(e: ProjectEvent): void {
    switch (e.type) {
      case 'commit':
        this.toProject(e.projectId, { type: 'commit', projectId: e.projectId, commit: e.commit, head: e.head, ...(e.clientOpId ? { clientOpId: e.clientOpId } : {}) });
        break;
      case 'checkout':
        this.toProject(e.projectId, { type: 'checkout', projectId: e.projectId, head: e.head });
        break;
      case 'proposal':
        this.toProject(e.projectId, { type: 'proposal', projectId: e.projectId, proposal: e.proposal });
        break;
      case 'snapshot':
        this.toProject(e.projectId, { type: 'snapshot', projectId: e.projectId, snapshot: e.snapshot });
        break;
      case 'code':
        this.toProject(e.projectId, e);
        break;
      case 'meta':
      case 'deleted':
        for (const c of this.clients.values()) this.send(c, { ...e });
        break;
    }
  }

  private async onActivity(e: ActivityEntry): Promise<void> {
    if (!e.projectId) return;
    const meta = await this.services.projects.getMeta(e.projectId).catch(() => null);
    for (const c of this.clients.values()) {
      if (!meta || this.services.projects.roleOf(meta, c.user.id)) this.send(c, { type: 'activity', entry: e });
    }
  }

  close(): void {
    for (const c of this.clients.values()) c.ws.close();
    this.wss.close();
  }

  get connectionCount(): number {
    return this.clients.size;
  }
}

export function summarizeJob(j: JobRecord) {
  return { id: j.id, kind: j.kind, title: j.title, status: j.status, progress: j.progress, message: j.message, projectId: j.projectId, createdAt: j.createdAt, finishedAt: j.finishedAt, error: j.error, result: j.result, data: j.data };
}
