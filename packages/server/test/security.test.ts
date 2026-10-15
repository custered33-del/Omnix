import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startTestServer, json, type TestServer } from './helpers.js';
import { BlockedUrlError, isInternalAddress, safeFetch } from '../src/util/safeFetch.js';

let ts: TestServer;
beforeAll(async () => {
  ts = await startTestServer();
});
afterAll(async () => {
  await ts?.close();
});

describe('uploaded files', () => {
  it('never run as pages on Omnix: SVG downloads instead of opening, and every file is sandboxed', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(document.cookie)</script><rect width="10" height="10"/></svg>';
    const up = await json(await ts.api('/api/assets?name=evil.svg', { method: 'POST', body: new TextEncoder().encode(svg), headers: { 'content-type': 'image/svg+xml' } }));
    const file = await ts.api(`/api/assets/${up.asset.id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(file.headers.get('content-security-policy')).toMatch(/sandbox/);
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');

    // Plain pictures still open in the browser (and load in pages).
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const pic = await json(await ts.api('/api/assets?name=dot.png', { method: 'POST', body: new Uint8Array(png), headers: { 'content-type': 'image/png' } }));
    const shown = await ts.api(`/api/assets/${pic.asset.id}/file`);
    expect(shown.headers.get('content-disposition')).toBeNull();
    expect(shown.headers.get('content-security-policy')).toMatch(/sandbox/);
    // A name with quotes and accents still makes a valid header.
    const named = await json(await ts.api(`/api/assets?name=${encodeURIComponent('Café "logo".svg')}`, { method: 'POST', body: new TextEncoder().encode(svg.replace('10', '11')), headers: { 'content-type': 'image/svg+xml' } }));
    const dl = await ts.api(`/api/assets/${named.asset.id}/file?download=1`);
    expect(dl.headers.get('content-disposition')).toContain(`filename*=UTF-8''${encodeURIComponent('Café "logo".svg')}`);
  });
});

describe('importing from a URL', () => {
  it('knows which addresses are internal, however they are written', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', '[::1]', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', 'fd00::1', 'fe80::1', 'ff02::1', '224.0.0.1', 'not-an-ip']) expect(isInternalAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isInternalAddress(ip), ip).toBe(false);
  });

  it('refuses internal addresses by IP, and by a name that resolves to one', async () => {
    const server = http.createServer((_req, res) => res.end('secret'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(safeFetch(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(BlockedUrlError);
      await expect(safeFetch(`http://[::ffff:127.0.0.1]:${port}/`)).rejects.toBeInstanceOf(BlockedUrlError);
      // "localhost" passes no string check here: the address it resolves to is what is refused.
      await expect(safeFetch(`http://localhost:${port}/`)).rejects.toBeInstanceOf(BlockedUrlError);
      // Through the API and MCP's import, the same refusal comes back as a clear error.
      const r = await ts.api('/api/assets/import-url', { method: 'POST', json: { url: `http://127.0.0.1:${port}/x.png` } });
      expect(r.status).toBe(400);
      expect((await r.json()).error).toMatch(/private network/);
    } finally {
      server.close();
    }
  });
});

describe('signing in', () => {
  it('slows down password guessing: ten failures lock that account for a while from that address', async () => {
    const login = (password: string, email = 'seb@example.com') => fetch(`${ts.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    for (let i = 0; i < 10; i++) expect((await login(`guess ${i}`)).status).toBe(401);
    const locked = await login('correct horse battery');
    expect(locked.status).toBe(429);
    expect((await locked.json()).error).toMatch(/Try again in 15 minutes/);
    // Other accounts from the same address are not locked out by it.
    expect((await login('whatever', 'someone@example.com')).status).toBe(401);
  });
});
