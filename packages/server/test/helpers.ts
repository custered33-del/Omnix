import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createOmnix, type OmnixInstance } from '../src/app.js';
import '../src/modules.js';

export interface TestServer {
  omnix: OmnixInstance;
  url: string;
  dataDir: string;
  /** fetch with the signed-in cookie jar */
  api(pathname: string, init?: RequestInit & { json?: unknown }): Promise<Response>;
  cookie: string;
  close(): Promise<void>;
}

export async function startTestServer(options: { memory?: boolean; signup?: boolean; openSignup?: boolean; pluginsDir?: string } = {}): Promise<TestServer> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnix-test-'));
  const omnix = await createOmnix({ dataDir, memory: options.memory ?? false, port: 0, host: '127.0.0.1', webDist: null, openSignup: options.openSignup ?? true, dev: true, ...(options.pluginsDir ? { pluginsDir: options.pluginsDir } : {}) });
  const port = await omnix.listen(0);
  const url = `http://127.0.0.1:${port}`;
  omnix.config.publicUrl = url;
  const ts: TestServer = {
    omnix,
    url,
    dataDir,
    cookie: '',
    async api(pathname, init = {}) {
      const headers = new Headers(init.headers);
      if (ts.cookie) headers.set('cookie', ts.cookie);
      let body = init.body;
      if (init.json !== undefined) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(init.json);
      }
      const res = await fetch(url + pathname, { ...init, headers, body });
      const set = res.headers.get('set-cookie');
      if (set) ts.cookie = set.split(';')[0]!;
      return res;
    },
    async close() {
      await omnix.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
  if (options.signup !== false) {
    const r = await ts.api('/api/auth/signup', { method: 'POST', json: { email: 'seb@example.com', name: 'Seb', password: 'correct horse battery' } });
    if (r.status !== 201) throw new Error(`signup failed: ${r.status} ${await r.text()}`);
  }
  return ts;
}

export async function json<T = any>(r: Response): Promise<T> {
  const text = await r.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON (status ${r.status}): ${text.slice(0, 300)}`);
  }
}
