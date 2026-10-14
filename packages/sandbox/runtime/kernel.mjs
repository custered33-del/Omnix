// Omnix sandbox kernel.
//
// Runs in its own Node process started by the server with:
//   - the Node permission model (no file writes, reads limited to this runtime and Pyodide,
//     no child processes, no worker threads, no native addons),
//   - an empty environment,
//   - a separate network namespace (`unshare -n`) when the host supports it,
//   - memory and wall-clock limits enforced by the parent.
// It speaks newline-delimited JSON on stdin/stdout. One kernel serves one project
// workspace, so notebook variables persist between cells but never across projects.
//
// This file is plain JavaScript on purpose: it must start without any build step
// under the restricted permission model.

import vm from 'node:vm';
import readline from 'node:readline';

const PYODIDE_DIR = process.env.OMNIX_PYODIDE_DIR || '';
const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

let config = { language: 'python', allowNetwork: false, packages: [], maxOutputBytes: 1_000_000 };
let currentRun = null;
let pyodide = null;
let jsContext = null;
const pending = new Map(); // parent round-trips (read_asset, write_asset)
let reqCounter = 0;

function request(type, payload) {
  const reqId = `r${++reqCounter}`;
  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    out({ type, reqId, ...payload });
  });
}

function emit(kind, text) {
  if (!currentRun) return;
  currentRun.bytes += text.length;
  if (currentRun.bytes > config.maxOutputBytes) {
    if (!currentRun.truncated) {
      currentRun.truncated = true;
      out({ type: 'stream', id: currentRun.id, stream: 'stderr', text: '\n[output truncated: limit reached]\n' });
    }
    return;
  }
  out({ type: 'stream', id: currentRun.id, stream: kind, text });
}

function display(output) {
  if (!currentRun) return;
  out({ type: 'display', id: currentRun.id, output });
}

/** The `omnix` helper API available to user code in both languages. */
function omnixApi() {
  return {
    chart(spec) {
      const s = typeof spec === 'string' ? JSON.parse(spec) : spec;
      display({ kind: 'chart', spec: s });
    },
    table(rows, columns) {
      const r = Array.isArray(rows) ? rows : [];
      const cols = columns || (r[0] && typeof r[0] === 'object' && !Array.isArray(r[0]) ? Object.keys(r[0]) : r[0] ? r[0].map((_, i) => `col${i + 1}`) : []);
      const data = r.map((row) => (Array.isArray(row) ? row : cols.map((c) => row[c] ?? null)));
      display({ kind: 'table', columns: cols.map(String), rows: data.map((row) => row.map((v) => (v === null || typeof v === 'number' || typeof v === 'string' ? v : String(v)))) });
    },
    image(data, mime = 'image/png') {
      const base64 = typeof data === 'string' ? data.replace(/^data:[^;]+;base64,/, '') : Buffer.from(data).toString('base64');
      display({ kind: 'image-data', base64, mime });
    },
    display(value) {
      display({ kind: 'result', text: typeof value === 'string' ? value : safeRepr(value) });
    },
    async readAsset(assetId) {
      const r = await request('read-asset', { assetId });
      return new Uint8Array(Buffer.from(r.base64, 'base64'));
    },
    async readAssetText(assetId) {
      const r = await request('read-asset', { assetId });
      return Buffer.from(r.base64, 'base64').toString('utf8');
    },
    async writeAsset(name, data, mime = 'application/octet-stream') {
      const base64 = typeof data === 'string' ? Buffer.from(data, 'utf8').toString('base64') : Buffer.from(data).toString('base64');
      const r = await request('write-asset', { name, base64, mime });
      return r.assetId;
    },
  };
}

function safeRepr(v) {
  try {
    if (v === undefined) return 'undefined';
    if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
    if (typeof v === 'string') return JSON.stringify(v);
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x), 2) ?? String(v);
  } catch {
    return String(v);
  }
}

/* ------------------------------------------------------------------ */
/* Lock down globals that could reach the network or the host.         */
/* ------------------------------------------------------------------ */

function lockDown() {
  if (!config.allowNetwork) {
    for (const k of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'Request', 'Response', 'Headers']) {
      try {
        delete globalThis[k];
      } catch {}
    }
  }
  try {
    process.getBuiltinModule = undefined;
  } catch {}
  try {
    process.dlopen = undefined;
  } catch {}
  for (const k of Object.keys(process.env)) delete process.env[k];
}

/* ------------------------------------------------------------------ */
/* JavaScript / TypeScript (TypeScript is transpiled by the parent)    */
/* ------------------------------------------------------------------ */

function jsCtx() {
  if (jsContext) return jsContext;
  const consoleShim = {
    log: (...a) => emit('stdout', a.map(fmt).join(' ') + '\n'),
    info: (...a) => emit('stdout', a.map(fmt).join(' ') + '\n'),
    debug: (...a) => emit('stdout', a.map(fmt).join(' ') + '\n'),
    warn: (...a) => emit('stderr', a.map(fmt).join(' ') + '\n'),
    error: (...a) => emit('stderr', a.map(fmt).join(' ') + '\n'),
    table: (rows) => omnixApi().table(rows),
  };
  const sandbox = {
    console: consoleShim,
    omnix: omnixApi(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    structuredClone,
    atob,
    btoa,
  };
  if (config.allowNetwork && typeof fetch === 'function') sandbox.fetch = fetch;
  jsContext = vm.createContext(sandbox, { name: 'omnix-js', codeGeneration: { strings: true, wasm: false } });
  return jsContext;
}

function fmt(v) {
  return typeof v === 'string' ? v : safeRepr(v);
}

async function runJs(code, timeoutMs) {
  const ctx = jsCtx();
  const usesAwait = /\bawait\b/.test(code);
  if (!usesAwait) {
    const value = vm.runInContext(code, ctx, { timeout: timeoutMs, filename: 'cell.js' });
    const resolved = value && typeof value.then === 'function' ? await value : value;
    return resolved;
  }
  // Top-level await: run inside an async function and return the final expression's value.
  // We try compiling with `return (<last line>)`; if that is not valid JavaScript (a statement,
  // a block, a declaration) we fall back to running the code as-is.
  const lines = code.trimEnd().split('\n');
  const last = lines[lines.length - 1].trim().replace(/;$/, '');
  let fn;
  if (last && !last.startsWith('//')) {
    try {
      fn = vm.runInContext(`(async () => {\n${[...lines.slice(0, -1), `return (${last});`].join('\n')}\n})`, ctx, { timeout: timeoutMs, filename: 'cell.js' });
    } catch (e) {
      if (!(e instanceof SyntaxError) && e?.name !== 'SyntaxError') throw e;
    }
  }
  fn ??= vm.runInContext(`(async () => {\n${code}\n})`, ctx, { timeout: timeoutMs, filename: 'cell.js' });
  return await fn();
}

/* ------------------------------------------------------------------ */
/* Python via Pyodide                                                  */
/* ------------------------------------------------------------------ */

const PY_PRELUDE = `
import sys, json, builtins
import js as _js
class _OmnixModule:
    def chart(self, spec=None, **kw):
        if spec is None:
            spec = kw
        _js._omnix_chart(json.dumps(spec))
    def table(self, rows, columns=None):
        _js._omnix_table(json.dumps(rows, default=str), json.dumps(columns) if columns else "null")
    def image(self, data, mime="image/png"):
        import base64
        if isinstance(data, (bytes, bytearray)):
            data = base64.b64encode(bytes(data)).decode()
        _js._omnix_image(data, mime)
    def display(self, value):
        _js._omnix_display(value if isinstance(value, str) else repr(value))
    async def read_asset(self, asset_id):
        import base64
        b64 = await _js._omnix_read_asset(asset_id)
        return base64.b64decode(b64)
    async def read_asset_text(self, asset_id):
        return (await self.read_asset(asset_id)).decode("utf-8")
    async def write_asset(self, name, data, mime="application/octet-stream"):
        import base64
        if isinstance(data, str):
            data = data.encode("utf-8")
        return await _js._omnix_write_asset(name, base64.b64encode(bytes(data)).decode(), mime)
omnix = _OmnixModule()
sys.modules["omnix"] = omnix
del _OmnixModule
`;

async function ensurePython() {
  if (pyodide) return pyodide;
  if (!PYODIDE_DIR) throw new Error('Python runtime is not installed on this server');
  // Emscripten asks for fs constants through process.binding, which the permission model blocks.
  const realBinding = process.binding;
  process.binding = (name) => {
    if (name === 'constants') return { fs: (globalThis.__omnixFsConstants ??= {}) };
    return realBinding.call(process, name);
  };
  const fsMod = await import('node:fs');
  globalThis.__omnixFsConstants = fsMod.constants;
  const { loadPyodide } = await import(PYODIDE_DIR + '/pyodide.mjs');
  pyodide = await loadPyodide({
    indexURL: PYODIDE_DIR + '/',
    stdout: (s) => emit('stdout', s + '\n'),
    stderr: (s) => emit('stderr', s + '\n'),
    ...(config.allowNetwork && config.packageBaseUrl ? { packageBaseUrl: config.packageBaseUrl } : {}),
  });
  process.binding = () => {
    throw new Error('process.binding is disabled in the Omnix sandbox');
  };
  const api = omnixApi();
  globalThis._omnix_chart = (s) => api.chart(s);
  globalThis._omnix_table = (rows, cols) => api.table(JSON.parse(rows), cols === 'null' ? undefined : JSON.parse(cols));
  globalThis._omnix_image = (b64, mime) => api.image(b64, mime);
  globalThis._omnix_display = (v) => display({ kind: 'result', text: String(v) });
  globalThis._omnix_read_asset = async (id) => (await request('read-asset', { assetId: id })).base64;
  globalThis._omnix_write_asset = async (name, b64, mime) => (await request('write-asset', { name, base64: b64, mime })).assetId;
  pyodide.FS.mkdirTree('/workspace');
  pyodide.FS.chdir('/workspace');
  await pyodide.runPythonAsync(PY_PRELUDE);
  if (config.allowNetwork && config.packages.length) {
    try {
      await pyodide.loadPackage(config.packages);
    } catch (e) {
      emit('stderr', `Could not load packages ${config.packages.join(', ')}: ${e.message}\n`);
    }
  }
  lockDown();
  return pyodide;
}

function writeWorkspaceFiles(files) {
  if (!pyodide) return;
  for (const [p, content] of Object.entries(files)) {
    const full = '/workspace/' + p.replace(/^\/+/, '');
    const dir = full.slice(0, full.lastIndexOf('/'));
    pyodide.FS.mkdirTree(dir);
    pyodide.FS.writeFile(full, content);
  }
}

async function runPython(code, filename) {
  const py = await ensurePython();
  try {
    const result = await py.runPythonAsync(code, { filename: filename || '<cell>' });
    if (result === undefined || result === null) return undefined;
    // Show Python's repr() for every result, like a notebook does ('text' -> 'text', True, 12...).
    const reprFn = py.globals.get('repr');
    try {
      return { __repr: String(reprFn(result)) };
    } finally {
      reprFn.destroy?.();
      result?.destroy?.();
    }
  } catch (e) {
    const msg = String(e.message || e);
    const lines = msg.trim().split('\n');
    const lastLine = lines[lines.length - 1] || 'Error';
    const m = /^(\w+(?:Error|Exception|Exit|Interrupt|Warning)?):\s?(.*)$/.exec(lastLine);
    const err = new Error(m ? m[2] : lastLine);
    err.name = m ? m[1] : 'PythonError';
    // Drop Pyodide-internal frames from the traceback.
    err.traceback = lines.filter((l) => !l.includes('/lib/python3') || l.includes('<cell>') || l.includes('/workspace/')).join('\n');
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Message loop                                                        */
/* ------------------------------------------------------------------ */

async function handle(msg) {
  switch (msg.type) {
    case 'init':
      config = { ...config, ...msg.config };
      if (config.language === 'python') {
        try {
          await ensurePython();
        } catch (e) {
          out({ type: 'init-error', error: String(e.message || e) });
          return;
        }
      } else lockDown();
      out({ type: 'ready', language: config.language });
      return;
    case 'files':
      if (config.language === 'python') {
        await ensurePython();
        writeWorkspaceFiles(msg.files || {});
      } else {
        const ctx = jsCtx();
        ctx.omnix.files = { ...(msg.files || {}) };
      }
      out({ type: 'files-ok' });
      return;
    case 'response': {
      const p = pending.get(msg.reqId);
      if (!p) return;
      pending.delete(msg.reqId);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg);
      return;
    }
    case 'run': {
      currentRun = { id: msg.id, bytes: 0, truncated: false };
      const start = Date.now();
      try {
        const value = config.language === 'python' ? await runPython(msg.code, msg.filename) : await runJs(msg.code, msg.timeoutMs || 30000);
        if (value !== undefined && value !== null) {
          const text = value && typeof value === 'object' && '__repr' in value ? value.__repr : config.language === 'python' ? String(value) : safeRepr(value);
          out({ type: 'display', id: msg.id, output: { kind: 'result', text } });
        }
        out({ type: 'done', id: msg.id, ms: Date.now() - start });
      } catch (e) {
        out({ type: 'display', id: msg.id, output: { kind: 'error', name: e.name || 'Error', message: String(e.message || e), ...(e.traceback ? { traceback: e.traceback } : e.stack ? { traceback: String(e.stack).split('\n').filter((l) => !l.includes('kernel.mjs')).join('\n') } : {}) } });
        out({ type: 'done', id: msg.id, ms: Date.now() - start, failed: true });
      } finally {
        currentRun = null;
      }
      return;
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain = Promise.resolve();
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // Responses to our own requests must not wait behind the run that awaits them.
  if (msg.type === 'response') {
    void handle(msg);
    return;
  }
  chain = chain.then(() => handle(msg)).catch((e) => out({ type: 'fatal', error: String(e && e.message ? e.message : e) }));
});
rl.on('close', () => process.exit(0));
process.on('uncaughtException', (e) => out({ type: 'fatal', error: String(e && e.message ? e.message : e) }));
process.on('unhandledRejection', (e) => out({ type: 'fatal', error: String(e && e.message ? e.message : e) }));
