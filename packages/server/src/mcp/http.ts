import express, { type Request, type Response, type Router } from 'express';
import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '../services.js';
import { createMcpServer } from './server.js';
import { modeFromScopes, type Principal } from './registry.js';

/**
 * Resolve the caller of an MCP request from its bearer token:
 *  - `omx_...` personal access tokens (stdio bridge, scripts)
 *  - OAuth access tokens issued to Claude through the connector flow (registered by the OAuth module)
 */
export type PrincipalResolver = (token: string) => Promise<Principal | null>;

export async function resolvePrincipal(services: Services, token: string): Promise<Principal | null> {
  const pat = await services.users.resolveAccessToken(token);
  if (pat) {
    return {
      user: pat.user,
      author: { type: 'ai', id: `claude:${pat.token.id.slice(0, 12)}`, name: pat.token.name.toLowerCase().includes('claude') ? 'Claude' : pat.token.name },
      mode: modeFromScopes(pat.token.scopes),
      projectIds: 'all',
      connectionId: `pat:${pat.token.id.slice(0, 12)}`,
      clientName: pat.token.name,
    };
  }
  const extra = services.ext.oauthResolver as PrincipalResolver | undefined;
  return extra ? extra(token) : null;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport | SSEServerTransport;
  server: McpServer;
  principalKey: string;
  lastSeen: number;
}

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  return null;
}

/** Express router serving MCP over Streamable HTTP (`/mcp`) and legacy HTTP+SSE (`/sse`, `/messages`). */
export function mcpRouter(services: Services): Router {
  const router = express.Router();
  const sessions = new Map<string, SessionEntry>();
  const resourceMetadata = `${services.config.publicUrl}/.well-known/oauth-protected-resource`;

  // Expire idle sessions.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > 60 * 60_000) {
        void s.transport.close?.();
        sessions.delete(id);
      }
    }
  }, 5 * 60_000);
  sweep.unref();

  const authenticate = async (req: Request, res: Response): Promise<{ principal: Principal; key: string } | null> => {
    const token = bearer(req);
    const principal = token ? await resolvePrincipal(services, token) : null;
    if (!principal) {
      res
        .status(401)
        .set('WWW-Authenticate', `Bearer realm="omnix", resource_metadata="${resourceMetadata}"${token ? ', error="invalid_token"' : ''}`)
        .json({ error: 'unauthorized', error_description: token ? 'The access token is invalid or expired. Reconnect Omnix in Claude.' : 'Sign in required. Connect Omnix as a Claude connector or use a personal access token.' });
      return null;
    }
    return { principal, key: crypto.createHash('sha256').update(token!).digest('hex') };
  };

  router.post('/mcp', express.json({ limit: '20mb' }), async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const sid = req.headers['mcp-session-id'];
    let entry = typeof sid === 'string' ? sessions.get(sid) : undefined;
    if (entry && entry.principalKey !== auth.key) {
      res.status(403).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session belongs to a different credential' }, id: null });
      return;
    }
    if (!entry) {
      if (typeof sid === 'string') {
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found. Start a new session.' }, id: null });
        return;
      }
      if (!isInitializeRequest(req.body)) {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad request: send initialize first' }, id: null });
        return;
      }
      const server = createMcpServer(services, auth.principal);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, principalKey: auth.key, lastSeen: Date.now() });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      entry = { transport, server, principalKey: auth.key, lastSeen: Date.now() };
    }
    entry.lastSeen = Date.now();
    await (entry.transport as StreamableHTTPServerTransport).handleRequest(req, res, req.body);
  });

  const sessionRequest = async (req: Request, res: Response) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const sid = req.headers['mcp-session-id'];
    const entry = typeof sid === 'string' ? sessions.get(sid) : undefined;
    if (!entry || !(entry.transport instanceof StreamableHTTPServerTransport)) {
      res.status(404).send('Session not found');
      return;
    }
    if (entry.principalKey !== auth.key) {
      res.status(403).send('Forbidden');
      return;
    }
    entry.lastSeen = Date.now();
    await entry.transport.handleRequest(req, res);
  };
  router.get('/mcp', sessionRequest);
  router.delete('/mcp', sessionRequest);

  // Legacy HTTP+SSE transport for older MCP clients.
  router.get('/sse', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const transport = new SSEServerTransport('/messages', res);
    const server = createMcpServer(services, auth.principal);
    sessions.set(transport.sessionId, { transport, server, principalKey: auth.key, lastSeen: Date.now() });
    res.on('close', () => sessions.delete(transport.sessionId));
    await server.connect(transport);
  });

  router.post('/messages', express.json({ limit: '20mb' }), async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const entry = sessions.get(String(req.query.sessionId ?? ''));
    if (!entry || !(entry.transport instanceof SSEServerTransport) || entry.principalKey !== auth.key) {
      res.status(404).send('Session not found');
      return;
    }
    entry.lastSeen = Date.now();
    await entry.transport.handlePostMessage(req, res, req.body);
  });

  return router;
}
