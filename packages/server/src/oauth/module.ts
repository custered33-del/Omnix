import express from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Services } from '../services.js';
import { useModule } from '../app.js';
import { h, requireUser } from '../http/middleware.js';
import { C } from '../storage/store.js';
import { randomToken, tokenHash, type User } from '../auth/users.js';
import { modeFromScopes, scopesForMode, ALL_SCOPES, type PermissionMode, type Principal } from '../mcp/registry.js';
import { registerConnectionLister, type ConnectionSummary } from '../claude/module.js';
import { ProjectError } from '../projects/service.js';

/**
 * OAuth 2.1 for the Claude connector. Claude discovers Omnix through the protected-resource
 * and authorization-server metadata, registers itself (dynamic client registration), sends the
 * person to Omnix to sign in and approve (authorization code with PKCE), and then calls MCP
 * with short-lived access tokens it refreshes as needed.
 *
 * Each approval is a grant: one Claude connection with a permission mode and the projects it
 * may reach. People change or revoke grants in Omnix at any time, and the change applies to the
 * very next request.
 */

export const ACCESS_TTL_S = 60 * 60;
export const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_S = 10 * 60;
const REQUEST_TTL_S = 10 * 60;

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  /** sha256 of the client secret, for confidential clients. */
  secretHash: string | null;
  authMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
  createdAt: string;
  clientUri?: string;
  logoUri?: string;
}

/** A pending approval: the parameters of one /oauth/authorize request while the person decides. */
interface AuthRequest {
  id: string;
  kind: 'request';
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  requestedScopes: string[] | null;
  resource: string | null;
  expiresAt: string;
}

interface AuthCode {
  id: string;
  kind: 'code';
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  grantId: string;
  expiresAt: string;
}

/** A Claude connection the person approved. */
export interface Grant {
  id: string;
  userId: string;
  clientId: string;
  clientName: string;
  mode: PermissionMode;
  projectIds: 'all' | string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

interface TokenRecord {
  id: string;
  kind: 'access' | 'refresh';
  grantId: string;
  clientId: string;
  expiresAt: string;
}

class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const now = () => new Date();
const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();
const expired = (iso: string) => new Date(iso).getTime() < Date.now();

/** PKCE S256: base64url(sha256(verifier)) must equal the challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  const digest = crypto.createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(digest);
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAllowedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    // Native and CLI clients (Claude Code) listen on a loopback port.
    if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return true;
    // Private-use schemes for desktop apps.
    return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/i.test(u.protocol);
  } catch {
    return false;
  }
}

function redirectWith(uri: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

export class OAuthService {
  constructor(private readonly services: Services) {}

  private get store() {
    return this.services.store;
  }

  get issuer(): string {
    return this.services.config.publicUrl;
  }

  get resource(): string {
    return `${this.services.config.publicUrl}/mcp`;
  }

  metadata() {
    const base = this.issuer;
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: ALL_SCOPES,
      service_documentation: `${base}/help/troubleshooting`,
    };
  }

  resourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: ALL_SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'Omnix',
      resource_documentation: `${this.issuer}/setup`,
    };
  }

  /* Clients ------------------------------------------------------- */

  async register(body: Record<string, unknown>): Promise<{ client: OAuthClient; secret: string | null }> {
    const parsed = z
      .object({
        redirect_uris: z.array(z.string()).min(1).max(20),
        client_name: z.string().max(200).optional(),
        token_endpoint_auth_method: z.enum(['none', 'client_secret_post', 'client_secret_basic']).optional(),
        grant_types: z.array(z.string()).optional(),
        response_types: z.array(z.string()).optional(),
        client_uri: z.string().url().optional(),
        logo_uri: z.string().url().optional(),
        scope: z.string().optional(),
      })
      .passthrough()
      .safeParse(body);
    if (!parsed.success) throw new OAuthError('invalid_client_metadata', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const m = parsed.data;
    const bad = m.redirect_uris.find((u) => !isAllowedRedirect(u));
    if (bad) throw new OAuthError('invalid_redirect_uri', `Redirect URI not allowed: ${bad}. Use https, a loopback http address, or an app scheme.`);
    if (m.grant_types && m.grant_types.some((g) => !['authorization_code', 'refresh_token'].includes(g))) throw new OAuthError('invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported');
    const authMethod = m.token_endpoint_auth_method ?? 'none';
    const secret = authMethod === 'none' ? null : randomToken(32);
    const client: OAuthClient = {
      id: `omxc_${randomToken(16)}`,
      name: (m.client_name ?? 'MCP client').trim() || 'MCP client',
      redirectUris: m.redirect_uris,
      secretHash: secret ? tokenHash(secret) : null,
      authMethod,
      createdAt: now().toISOString(),
      ...(m.client_uri ? { clientUri: m.client_uri } : {}),
      ...(m.logo_uri ? { logoUri: m.logo_uri } : {}),
    };
    await this.store.put(C.oauthClients, client.id, client);
    return { client, secret };
  }

  async client(id: string): Promise<OAuthClient | undefined> {
    return id ? this.store.get<OAuthClient>(C.oauthClients, id) : undefined;
  }

  /** Check client credentials on the token and revocation endpoints. */
  private async authenticateClient(req: express.Request, body: Record<string, string>): Promise<OAuthClient> {
    let id = body.client_id ?? '';
    let secret = body.client_secret ?? null;
    const basic = req.headers.authorization;
    if (basic && /^Basic\s+/i.test(basic)) {
      const [u, p] = Buffer.from(basic.replace(/^Basic\s+/i, ''), 'base64').toString('utf8').split(':');
      id = decodeURIComponent(u ?? '');
      secret = decodeURIComponent(p ?? '');
    }
    const client = await this.client(id);
    if (!client) throw new OAuthError('invalid_client', 'Unknown client', 401);
    if (client.secretHash) {
      if (!secret || tokenHash(secret) !== client.secretHash) throw new OAuthError('invalid_client', 'Client authentication failed', 401);
    }
    return client;
  }

  /* Authorization ------------------------------------------------- */

  /**
   * Validate an /oauth/authorize request and keep it while the person decides. Problems with
   * the client or redirect URI are shown to the person (never redirected); others go back to
   * the client as OAuth errors.
   */
  async startAuthorization(q: Record<string, string | undefined>): Promise<{ requestId: string } | { redirect: string } | { error: string }> {
    const client = await this.client(q.client_id ?? '');
    if (!client) return { error: 'This app is not registered with Omnix. Remove the connector in Claude and add it again.' };
    const redirectUri = q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : '');
    if (!client.redirectUris.includes(redirectUri)) return { error: 'The redirect address does not match the one the app registered.' };
    const fail = (error: string, description: string) => ({ redirect: redirectWith(redirectUri, { error, error_description: description, state: q.state ?? null, iss: this.issuer }) });
    if (q.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported');
    if (!q.code_challenge || (q.code_challenge_method ?? 'plain') !== 'S256') return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    if (q.resource && ![this.resource, this.issuer, `${this.issuer}/`].includes(q.resource)) return fail('invalid_target', `Unknown resource ${q.resource}`);
    const scopes = q.scope ? q.scope.split(/\s+/).filter(Boolean) : null;
    if (scopes && scopes.some((s) => !(ALL_SCOPES as string[]).includes(s))) return fail('invalid_scope', `Supported scopes: ${ALL_SCOPES.join(' ')}`);
    const req: AuthRequest = {
      id: randomToken(18),
      kind: 'request',
      clientId: client.id,
      redirectUri,
      state: q.state ?? null,
      codeChallenge: q.code_challenge,
      requestedScopes: scopes,
      resource: q.resource ?? null,
      expiresAt: inSeconds(REQUEST_TTL_S),
    };
    await this.store.put(C.oauthCodes, tokenHash(req.id), req);
    return { requestId: req.id };
  }

  async pendingRequest(id: string): Promise<{ req: AuthRequest; client: OAuthClient }> {
    const req = await this.store.get<AuthRequest>(C.oauthCodes, tokenHash(id));
    if (!req || req.kind !== 'request') throw new ProjectError('This sign-in request was not found. Start again from Claude.', 404);
    if (expired(req.expiresAt)) {
      await this.store.delete(C.oauthCodes, tokenHash(id));
      throw new ProjectError('This sign-in request expired. Click Connect in Claude again.', 410);
    }
    const client = await this.client(req.clientId);
    if (!client) throw new ProjectError('The app that asked for access is no longer registered.', 404);
    return { req, client };
  }

  /** Highest mode the client asked for (the person can only choose up to it). */
  static ceiling(requested: string[] | null): PermissionMode {
    return requested ? modeFromScopes(requested) : 'autonomous';
  }

  async decide(id: string, user: User, decision: { approve: boolean; mode?: PermissionMode; projectIds?: 'all' | string[] }): Promise<string> {
    const { req, client } = await this.pendingRequest(id);
    await this.store.delete(C.oauthCodes, tokenHash(id));
    if (!decision.approve) return redirectWith(req.redirectUri, { error: 'access_denied', error_description: 'The person declined access', state: req.state, iss: this.issuer });
    const order: PermissionMode[] = ['view', 'approve', 'autonomous'];
    const ceiling = OAuthService.ceiling(req.requestedScopes);
    const wanted = decision.mode ?? user.setup.preset ?? 'approve';
    const mode = order.indexOf(wanted) > order.indexOf(ceiling) ? ceiling : wanted;
    let projectIds = decision.projectIds ?? 'all';
    if (projectIds !== 'all') {
      const mine = new Set((await this.services.projects.listForUser(user.id, { includeArchived: true })).map((p) => p.id));
      projectIds = projectIds.filter((p) => mine.has(p));
    }
    // One grant per person and app: approving again updates it.
    const existing = (await this.store.list<Grant>(C.connections)).find((g) => g.userId === user.id && g.clientId === client.id);
    const at = now().toISOString();
    const grant: Grant = existing ? { ...existing, mode, projectIds, updatedAt: at } : { id: `grant_${randomToken(12)}`, userId: user.id, clientId: client.id, clientName: client.name, mode, projectIds, createdAt: at, updatedAt: at, lastUsedAt: null };
    await this.store.put(C.connections, grant.id, grant);
    const code = randomToken(32);
    const rec: AuthCode = { id: tokenHash(code), kind: 'code', clientId: client.id, redirectUri: req.redirectUri, codeChallenge: req.codeChallenge, grantId: grant.id, expiresAt: inSeconds(CODE_TTL_S) };
    await this.store.put(C.oauthCodes, rec.id, rec);
    await this.services.activity.record({ projectId: null, projectName: null, actor: { type: 'human', id: user.id, name: user.name }, kind: 'connection', summary: `Connected ${client.name} (${mode === 'view' ? 'view only' : mode === 'approve' ? 'edit with approval' : 'autonomous'}${projectIds === 'all' ? ', all projects' : `, ${projectIds.length} projects`})`, via: 'ui' });
    return redirectWith(req.redirectUri, { code, state: req.state, iss: this.issuer });
  }

  /* Tokens -------------------------------------------------------- */

  private async issue(grant: Grant, clientId: string): Promise<Record<string, unknown>> {
    const access = `omxa_${randomToken(32)}`;
    const refresh = `omxr_${randomToken(32)}`;
    await this.store.put<TokenRecord>(C.oauthTokens, tokenHash(access), { id: tokenHash(access), kind: 'access', grantId: grant.id, clientId, expiresAt: inSeconds(ACCESS_TTL_S) });
    await this.store.put<TokenRecord>(C.oauthTokens, tokenHash(refresh), { id: tokenHash(refresh), kind: 'refresh', grantId: grant.id, clientId, expiresAt: inSeconds(REFRESH_TTL_S) });
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopesForMode(grant.mode).join(' ') };
  }

  async token(req: express.Request, body: Record<string, string>): Promise<Record<string, unknown>> {
    const client = await this.authenticateClient(req, body);
    if (body.grant_type === 'authorization_code') {
      const code = body.code ?? '';
      const rec = await this.store.get<AuthCode>(C.oauthCodes, tokenHash(code));
      if (!rec || rec.kind !== 'code') throw new OAuthError('invalid_grant', 'Unknown or used authorization code');
      // Codes are single-use, whatever happens next.
      await this.store.delete(C.oauthCodes, rec.id);
      if (expired(rec.expiresAt)) throw new OAuthError('invalid_grant', 'The authorization code expired');
      if (rec.clientId !== client.id) throw new OAuthError('invalid_grant', 'The code was issued to another client');
      if (body.redirect_uri && body.redirect_uri !== rec.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri does not match');
      if (!body.code_verifier || !pkceMatches(body.code_verifier, rec.codeChallenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed');
      const grant = await this.store.get<Grant>(C.connections, rec.grantId);
      if (!grant) throw new OAuthError('invalid_grant', 'The connection was revoked');
      return this.issue(grant, client.id);
    }
    if (body.grant_type === 'refresh_token') {
      const rec = await this.store.get<TokenRecord>(C.oauthTokens, tokenHash(body.refresh_token ?? ''));
      if (!rec || rec.kind !== 'refresh' || expired(rec.expiresAt)) throw new OAuthError('invalid_grant', 'The refresh token is invalid or expired. Connect Omnix in Claude again.');
      if (rec.clientId !== client.id) throw new OAuthError('invalid_grant', 'The refresh token belongs to another client');
      // Rotate: the old refresh token stops working.
      await this.store.delete(C.oauthTokens, rec.id);
      const grant = await this.store.get<Grant>(C.connections, rec.grantId);
      if (!grant) throw new OAuthError('invalid_grant', 'The connection was revoked');
      return this.issue(grant, client.id);
    }
    throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
  }

  async revokeToken(req: express.Request, body: Record<string, string>): Promise<void> {
    const client = await this.authenticateClient(req, body);
    const rec = await this.store.get<TokenRecord>(C.oauthTokens, tokenHash(body.token ?? ''));
    if (rec && rec.clientId === client.id) await this.store.delete(C.oauthTokens, rec.id);
  }

  /* Grants -------------------------------------------------------- */

  async resolve(token: string): Promise<Principal | null> {
    if (!token.startsWith('omxa_')) return null;
    const rec = await this.store.get<TokenRecord>(C.oauthTokens, tokenHash(token));
    if (!rec || rec.kind !== 'access') return null;
    if (expired(rec.expiresAt)) {
      await this.store.delete(C.oauthTokens, rec.id);
      return null;
    }
    const grant = await this.store.get<Grant>(C.connections, rec.grantId);
    if (!grant) return null;
    const user = await this.services.users.byId(grant.userId);
    if (!user) return null;
    // Record use at most once a minute to keep writes low.
    if (!grant.lastUsedAt || Date.now() - new Date(grant.lastUsedAt).getTime() > 60_000) {
      grant.lastUsedAt = now().toISOString();
      await this.store.put(C.connections, grant.id, grant);
    }
    return {
      user,
      author: { type: 'ai', id: `claude:${grant.id.slice(6, 18)}`, name: /claude/i.test(grant.clientName) ? 'Claude' : grant.clientName },
      mode: grant.mode,
      projectIds: grant.projectIds,
      connectionId: `oauth:${grant.id}`,
      clientName: grant.clientName,
    };
  }

  async grantsFor(userId: string): Promise<Grant[]> {
    return (await this.store.list<Grant>(C.connections)).filter((g) => g.userId === userId);
  }

  async updateGrant(userId: string, id: string, patch: { mode?: PermissionMode; projectIds?: 'all' | string[] }): Promise<Grant> {
    const g = await this.store.get<Grant>(C.connections, id);
    if (!g || g.userId !== userId) throw new ProjectError('Connection not found', 404);
    const next: Grant = { ...g, ...(patch.mode ? { mode: patch.mode } : {}), ...(patch.projectIds ? { projectIds: patch.projectIds } : {}), updatedAt: now().toISOString() };
    await this.store.put(C.connections, id, next);
    return next;
  }

  /** Revoke a connection: its tokens stop working at once. */
  async revokeGrant(userId: string, id: string): Promise<void> {
    const g = await this.store.get<Grant>(C.connections, id);
    if (!g || g.userId !== userId) throw new ProjectError('Connection not found', 404);
    await this.store.delete(C.connections, id);
    for (const t of await this.store.list<TokenRecord>(C.oauthTokens)) if (t.grantId === id) await this.store.delete(C.oauthTokens, t.id);
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

function cors(_req: express.Request, res: express.Response, next: express.NextFunction) {
  // Metadata, registration and token endpoints are called by Claude's servers and by browser-based clients.
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Cache-Control', 'no-store');
  if (_req.method === 'OPTIONS') return void res.status(204).end();
  next();
}

function oauthError(res: express.Response, e: unknown): void {
  if (e instanceof OAuthError) {
    if (e.status === 401) res.set('WWW-Authenticate', 'Basic realm="omnix"');
    res.status(e.status).json({ error: e.code, error_description: e.message });
    return;
  }
  res.status(500).json({ error: 'server_error', error_description: (e as Error).message });
}

function errorPage(title: string, message: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Omnix</title><body style="font-family:system-ui,sans-serif;max-width:560px;margin:12vh auto;padding:0 24px;color:#1d1f24;line-height:1.5"><h1 style="font-size:22px">${esc(title)}</h1><p>${esc(message)}</p><p><a href="/help/troubleshooting#expired">Troubleshooting</a></p></body>`;
}

useModule(({ services, app, router }) => {
  const oauth = new OAuthService(services);
  services.ext.oauth = oauth;
  services.ext.oauthResolver = (token: string) => oauth.resolve(token);

  registerConnectionLister(services, async (userId): Promise<ConnectionSummary[]> =>
    (await oauth.grantsFor(userId)).map((g) => ({ id: `oauth:${g.id}`, kind: 'oauth', name: /claude/i.test(g.clientName) ? g.clientName : `${g.clientName}`, mode: g.mode, projectIds: g.projectIds, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt })),
  );

  const meta = express.Router();
  meta.use(cors);
  meta.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp', '/.well-known/openid-configuration'], (_req, res) => void res.json(oauth.metadata()));
  meta.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => void res.json(oauth.resourceMetadata()));
  meta.post('/oauth/register', express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const { client, secret } = await oauth.register((req.body ?? {}) as Record<string, unknown>);
      res.status(201).json({
        client_id: client.id,
        client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: client.authMethod,
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      });
    } catch (e) {
      oauthError(res, e);
    }
  });
  const form = [express.urlencoded({ extended: false, limit: '64kb' }), express.json({ limit: '64kb' })];
  meta.post('/oauth/token', ...form, async (req, res) => {
    try {
      res.json(await oauth.token(req, (req.body ?? {}) as Record<string, string>));
    } catch (e) {
      oauthError(res, e);
    }
  });
  meta.post('/oauth/revoke', ...form, async (req, res) => {
    try {
      await oauth.revokeToken(req, (req.body ?? {}) as Record<string, string>);
      res.status(200).end();
    } catch (e) {
      oauthError(res, e);
    }
  });
  app.use(meta);

  /** The person lands here from Claude. Valid requests continue to the consent page in the web app. */
  app.get('/oauth/authorize', async (req, res) => {
    const q = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, typeof v === 'string' ? v : undefined]));
    const r = await oauth.startAuthorization(q);
    if ('error' in r) return void res.status(400).type('html').send(errorPage('Omnix cannot continue', r.error));
    if ('redirect' in r) return void res.redirect(302, r.redirect);
    res.redirect(302, `/connect/${encodeURIComponent(r.requestId)}`);
  });

  /* Consent page API ---------------------------------------------- */

  router.get(
    '/oauth/requests/:id',
    h(async (req, res) => {
      const user = requireUser(req);
      const { req: ar, client } = await oauth.pendingRequest(String(req.params.id));
      const projects = await services.projects.listForUser(user.id);
      res.json({
        client: { name: client.name, redirectHost: new URL(ar.redirectUri).host, clientUri: client.clientUri ?? null },
        maxMode: OAuthService.ceiling(ar.requestedScopes),
        defaultMode: user.setup.preset ?? 'approve',
        projects: projects.map((p) => ({ id: p.id, name: p.name, primaryTool: p.primaryTool, aiConsent: p.aiConsent })),
        expiresAt: ar.expiresAt,
      });
    }),
  );

  router.post(
    '/oauth/requests/:id/decision',
    h(async (req, res) => {
      const user = requireUser(req);
      const body = z.object({ approve: z.boolean(), mode: z.enum(['view', 'approve', 'autonomous']).optional(), projectIds: z.union([z.literal('all'), z.array(z.string()).max(1000)]).optional() }).parse(req.body);
      res.json({ redirect: await oauth.decide(String(req.params.id), user, body) });
    }),
  );

  /* Managing connections ------------------------------------------- */

  router.patch(
    '/claude/connections/:id',
    h(async (req, res) => {
      const user = requireUser(req);
      const body = z.object({ mode: z.enum(['view', 'approve', 'autonomous']).optional(), projectIds: z.union([z.literal('all'), z.array(z.string()).max(1000)]).optional() }).parse(req.body);
      const id = String(req.params.id);
      if (id.startsWith('oauth:')) {
        const g = await oauth.updateGrant(user.id, id.slice(6), body);
        await services.activity.record({ projectId: null, projectName: null, actor: { type: 'human', id: user.id, name: user.name }, kind: 'connection', summary: `Changed ${g.clientName} to ${g.mode === 'view' ? 'view only' : g.mode === 'approve' ? 'edit with approval' : 'autonomous'}`, via: 'ui' });
        return void res.json({ ok: true });
      }
      if (id.startsWith('pat:') && body.mode) {
        const tokens = await services.users.listAccessTokens(user.id);
        const t = tokens.find((x) => x.id.startsWith(id.slice(4)));
        if (!t) throw new ProjectError('Connection not found', 404);
        await services.store.put(C.tokens, t.id, { ...t, scopes: scopesForMode(body.mode) });
        return void res.json({ ok: true });
      }
      throw new ProjectError('Connection not found', 404);
    }),
  );

  router.delete(
    '/claude/connections/:id',
    h(async (req, res) => {
      const user = requireUser(req);
      const id = String(req.params.id);
      if (id.startsWith('oauth:')) {
        const g = (await oauth.grantsFor(user.id)).find((x) => x.id === id.slice(6));
        await oauth.revokeGrant(user.id, id.slice(6));
        await services.activity.record({ projectId: null, projectName: null, actor: { type: 'human', id: user.id, name: user.name }, kind: 'connection', summary: `Disconnected ${g?.clientName ?? 'Claude'}`, via: 'ui' });
      } else if (id.startsWith('pat:')) {
        const t = (await services.users.listAccessTokens(user.id)).find((x) => x.id.startsWith(id.slice(4)));
        if (!t) throw new ProjectError('Connection not found', 404);
        await services.users.revokeAccessToken(user.id, t.id);
      } else throw new ProjectError('Connection not found', 404);
      res.json({ ok: true });
    }),
  );
});
