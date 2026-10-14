import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { startTestServer, json, type TestServer } from './helpers.js';
import { pkceMatches } from '../src/oauth/module.js';

let ts: TestServer;
let allowed = '';
let other = '';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

async function register(extra: Record<string, unknown> = {}) {
  const r = await fetch(`${ts.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], ...extra }) });
  expect(r.status).toBe(201);
  return (await r.json()) as { client_id: string; client_secret?: string };
}

/** Run the browser part: /oauth/authorize, then the person approves on the consent page. */
async function authorize(clientId: string, challenge: string, decision: Record<string, unknown>, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: `${ts.url}/mcp`, ...extra });
  const r = await fetch(`${ts.url}/oauth/authorize?${q}`, { redirect: 'manual' });
  expect(r.status).toBe(302);
  const loc = r.headers.get('location')!;
  expect(loc).toMatch(/^\/connect\//);
  const requestId = decodeURIComponent(loc.split('/').pop()!);
  const info = await json(await ts.api(`/api/oauth/requests/${requestId}`));
  const d = await json(await ts.api(`/api/oauth/requests/${requestId}/decision`, { method: 'POST', json: decision }));
  return { info, redirect: new URL(d.redirect as string) };
}

async function token(body: Record<string, string>) {
  const r = await fetch(`${ts.url}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}

async function connect(accessToken: string) {
  const client = new Client({ name: 'claude-ai', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${ts.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}

beforeAll(async () => {
  ts = await startTestServer();
  allowed = (await json(await ts.api('/api/projects', { method: 'POST', json: { name: 'Allowed', primaryTool: 'document', aiConsent: true } }))).project.id;
  other = (await json(await ts.api('/api/projects', { method: 'POST', json: { name: 'Private', primaryTool: 'image', aiConsent: true } }))).project.id;
});

afterAll(async () => {
  await ts?.close();
});

describe('discovery', () => {
  it('publishes resource and authorization server metadata', async () => {
    const res = await (await fetch(`${ts.url}/.well-known/oauth-protected-resource`)).json();
    expect(res).toMatchObject({ resource: `${ts.url}/mcp`, authorization_servers: [ts.url] });
    const as = await fetch(`${ts.url}/.well-known/oauth-authorization-server`);
    expect(as.headers.get('access-control-allow-origin')).toBe('*');
    const meta = await as.json();
    expect(meta).toMatchObject({ issuer: ts.url, authorization_endpoint: `${ts.url}/oauth/authorize`, token_endpoint: `${ts.url}/oauth/token`, registration_endpoint: `${ts.url}/oauth/register`, code_challenge_methods_supported: ['S256'] });
  });

  it('asks MCP clients without a token to sign in', async () => {
    const r = await fetch(`${ts.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain(`resource_metadata="${ts.url}/.well-known/oauth-protected-resource"`);
  });
});

describe('connecting Claude', () => {
  let clientId = '';
  let refresh = '';
  let access = '';

  it('registers, signs in with PKCE and limits the connection to the chosen projects', async () => {
    clientId = (await register()).client_id;
    const { verifier, challenge } = pkce();
    const { info, redirect } = await authorize(clientId, challenge, { approve: true, mode: 'approve', projectIds: [allowed] });
    expect(info.client).toMatchObject({ name: 'Claude', redirectHost: 'claude.ai' });
    expect(info.maxMode).toBe('autonomous');
    expect(info.projects.map((p: { name: string }) => p.name).sort()).toEqual(['Allowed', 'Private']);
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
    expect(redirect.searchParams.get('state')).toBe('xyz');
    expect(redirect.searchParams.get('iss')).toBe(ts.url);
    const code = redirect.searchParams.get('code')!;

    const bad = await token({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: 'wrong' });
    expect(bad.body.error).toBe('invalid_grant');
    // The code was spent by the failed attempt; get a new one.
    const again = await authorize(clientId, challenge, { approve: true, mode: 'approve', projectIds: [allowed] });
    const ok = await token({ grant_type: 'authorization_code', code: again.redirect.searchParams.get('code')!, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'omnix:read omnix:edit' });
    access = ok.body.access_token!;
    refresh = ok.body.refresh_token!;
    expect(access).toMatch(/^omxa_/);
    const reuse = await token({ grant_type: 'authorization_code', code: again.redirect.searchParams.get('code')!, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(reuse.body.error).toBe('invalid_grant');

    const mcp = await connect(access);
    const list = await mcp.callTool({ name: 'list_projects', arguments: {} });
    expect((list.structuredContent as { projects: { name: string }[] }).projects.map((p) => p.name)).toEqual(['Allowed']);
    const note = await mcp.callTool({ name: 'add_note', arguments: { projectId: allowed, text: 'Hello from Claude' } });
    expect((note.structuredContent as { status: string }).status).toBe('proposed');
    const blocked = await mcp.callTool({ name: 'add_note', arguments: { projectId: other, text: 'nope' } });
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked.content)).toMatch(/not allowed to access project/);

    // Switching to Autonomous in Omnix applies to the very next call in the same session.
    const status = await json(await ts.api('/api/claude/status'));
    const conn = status.connections.find((c: { kind: string }) => c.kind === 'oauth');
    expect(conn).toMatchObject({ name: 'Claude', mode: 'approve', projectIds: [allowed] });
    expect(conn.lastUsedAt).toBeTruthy();
    await ts.api(`/api/claude/connections/${conn.id}`, { method: 'PATCH', json: { mode: 'autonomous' } });
    const direct = await mcp.callTool({ name: 'add_note', arguments: { projectId: allowed, text: 'Applied directly' } });
    expect((direct.structuredContent as { status: string }).status).toBe('committed');
    await mcp.close();
  });

  it('rotates refresh tokens', async () => {
    const r = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe('omnix:read omnix:edit omnix:autonomous');
    const old = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    expect(old.body.error).toBe('invalid_grant');
    access = r.body.access_token!;
    refresh = r.body.refresh_token!;
  });

  it('stops working the moment the connection is revoked', async () => {
    const status = await json(await ts.api('/api/claude/status'));
    const conn = status.connections.find((c: { kind: string }) => c.kind === 'oauth');
    await ts.api(`/api/claude/connections/${conn.id}`, { method: 'DELETE' });
    const r = await fetch(`${ts.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${access}` }, body: '{}' });
    expect(r.status).toBe(401);
    expect((await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId })).body.error).toBe('invalid_grant');
    expect((await json(await ts.api('/api/claude/status'))).connections.filter((c: { kind: string }) => c.kind === 'oauth')).toHaveLength(0);
  });
});

describe('approval choices and errors', () => {
  it('sends access_denied back to Claude when the person says no', async () => {
    const { client_id } = await register();
    const { redirect } = await authorize(client_id, pkce().challenge, { approve: false });
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('state')).toBe('xyz');
  });

  it('never grants more than the app asked for', async () => {
    const { client_id } = await register();
    const { verifier, challenge } = pkce();
    const { info, redirect } = await authorize(client_id, challenge, { approve: true, mode: 'autonomous' }, { scope: 'omnix:read' });
    expect(info.maxMode).toBe('view');
    const t = await token({ grant_type: 'authorization_code', code: redirect.searchParams.get('code')!, client_id, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(t.body.scope).toBe('omnix:read');
  });

  it('authenticates confidential clients', async () => {
    const { client_id, client_secret } = await register({ token_endpoint_auth_method: 'client_secret_post' });
    expect(client_secret).toBeTruthy();
    const { verifier, challenge } = pkce();
    const { redirect } = await authorize(client_id, challenge, { approve: true, mode: 'view' });
    const code = redirect.searchParams.get('code')!;
    expect((await token({ grant_type: 'authorization_code', code, client_id, redirect_uri: REDIRECT, code_verifier: verifier, client_secret: 'wrong' })).status).toBe(401);
    const second = await authorize(client_id, challenge, { approve: true, mode: 'view' });
    const ok = await token({ grant_type: 'authorization_code', code: second.redirect.searchParams.get('code')!, client_id, redirect_uri: REDIRECT, code_verifier: verifier, client_secret: client_secret! });
    expect(ok.status).toBe(200);
  });

  it('shows a page instead of redirecting when the client or redirect is wrong', async () => {
    const unknown = await fetch(`${ts.url}/oauth/authorize?response_type=code&client_id=nope&redirect_uri=${encodeURIComponent(REDIRECT)}`, { redirect: 'manual' });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain('not registered');
    const { client_id } = await register();
    const wrong = await fetch(`${ts.url}/oauth/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=x&code_challenge_method=S256`, { redirect: 'manual' });
    expect(wrong.status).toBe(400);
  });

  it('requires PKCE and rejects unsafe redirect URIs at registration', async () => {
    const { client_id } = await register();
    const r = await fetch(`${ts.url}/oauth/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    const bad = await fetch(`${ts.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_redirect_uri');
    // Loopback addresses are fine for command-line clients.
    expect((await fetch(`${ts.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:33418/callback'] }) })).status).toBe(201);
  });

  it('checks PKCE verifiers', () => {
    const { verifier, challenge } = pkce();
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(pkceMatches(`${verifier}x`, challenge)).toBe(false);
  });

  it('needs a signed-in person to approve', async () => {
    const { client_id } = await register();
    const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' });
    const loc = (await fetch(`${ts.url}/oauth/authorize?${q}`, { redirect: 'manual' })).headers.get('location')!;
    const id = loc.split('/').pop()!;
    expect((await fetch(`${ts.url}/api/oauth/requests/${id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve: true }) })).status).toBe(401);
  });
});

describe('the MCP SDK OAuth client', () => {
  it('discovers, registers, signs in and calls tools exactly as an MCP client does', async () => {
    let info: unknown;
    let tokens: unknown;
    let verifier = '';
    let authUrl: URL | null = null;
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return REDIRECT;
      },
      get clientMetadata() {
        return { client_name: 'Claude', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
      },
      clientInformation: () => info as never,
      saveClientInformation: (i) => void (info = i),
      tokens: () => tokens as never,
      saveTokens: (t) => void (tokens = t),
      redirectToAuthorization: (u) => void (authUrl = u),
      saveCodeVerifier: (v) => void (verifier = v),
      codeVerifier: () => verifier,
    };
    const transport = new StreamableHTTPClientTransport(new URL(`${ts.url}/mcp`), { authProvider: provider });
    const client = new Client({ name: 'claude-ai', version: '1.0.0' });
    await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(authUrl).not.toBeNull();
    // The person approves in the browser.
    const r = await fetch(authUrl!, { redirect: 'manual' });
    const requestId = decodeURIComponent(r.headers.get('location')!.split('/').pop()!);
    const d = await json(await ts.api(`/api/oauth/requests/${requestId}/decision`, { method: 'POST', json: { approve: true, mode: 'view' } }));
    await transport.finishAuth(new URL(d.redirect).searchParams.get('code')!);
    const again = new Client({ name: 'claude-ai', version: '1.0.0' });
    await again.connect(new StreamableHTTPClientTransport(new URL(`${ts.url}/mcp`), { authProvider: provider }));
    const list = await again.callTool({ name: 'list_projects', arguments: {} });
    expect((list.structuredContent as { projects: unknown[] }).projects.length).toBe(2);
    await again.close();
  });
});
