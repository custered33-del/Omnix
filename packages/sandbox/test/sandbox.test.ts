import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { SandboxManager, DEFAULT_LIMITS, type SandboxHost } from '../src/index.js';

const written: { name: string; data: Buffer; mime: string }[] = [];
const host: SandboxHost = {
  async readAsset(id) {
    if (id === 'csv1') return { data: Buffer.from('city,temp\nOslo,4\nLima,19\n'), mime: 'text/csv' };
    throw new Error('Asset not found');
  },
  async writeAsset(name, data, mime) {
    written.push({ name, data, mime });
    return `asset-${written.length}`;
  },
};

let sb: SandboxManager;
beforeAll(() => {
  sb = new SandboxManager(host, { ...DEFAULT_LIMITS, timeoutMs: 8000 });
});
afterAll(() => sb.shutdown());

describe('sandbox status', () => {
  it('reports runtimes and isolation', () => {
    const s = sb.status();
    expect(s.javascript).toBe(true);
    expect(s.python).toBe(true);
    expect(s.permissionModel).toBe(true);
  });
});

describe('JavaScript and TypeScript', () => {
  it('runs code, captures console, returns the last value, and keeps state between cells', async () => {
    const a = await sb.run({ kernelKey: 'p1:ws1', language: 'javascript', code: 'const x = 20; console.log("hi", {a: 1}); x + 1' });
    expect(a.ok).toBe(true);
    expect(a.outputs).toEqual([
      { kind: 'stdout', text: 'hi {\n  "a": 1\n}\n' },
      { kind: 'result', text: '21' },
    ]);
    const b = await sb.run({ kernelKey: 'p1:ws1', language: 'javascript', code: 'x * 2' });
    expect(b.outputs).toEqual([{ kind: 'result', text: '40' }]);
  });

  it('supports top-level await and the omnix API', async () => {
    const r = await sb.run({
      kernelKey: 'p1:ws1',
      language: 'javascript',
      code: 'const csv = await omnix.readAssetText("csv1");\nomnix.chart({ type: "bar", labels: ["a"], series: [{ name: "s", values: [1] }] });\nconst id = await omnix.writeAsset("out.txt", "hello", "text/plain");\nid',
    });
    expect(r.ok).toBe(true);
    expect(r.outputs[0]).toMatchObject({ kind: 'chart', spec: { type: 'bar' } });
    expect(r.outputs[1]).toEqual({ kind: 'result', text: '"asset-1"' });
    expect(written[0]!.data.toString()).toBe('hello');
  });

  it('transpiles TypeScript and reports type-syntax errors', async () => {
    const ok = await sb.run({ kernelKey: 'p1:ts', language: 'typescript', code: 'const n: number = 5;\ninterface A { b: string }\nn * 3' });
    expect(ok.outputs).toEqual([{ kind: 'result', text: '15' }]);
    const bad = await sb.run({ kernelKey: 'p1:ts', language: 'typescript', code: 'const = ;' });
    expect(bad.ok).toBe(false);
    expect(bad.outputs[0]!.kind).toBe('error');
  });

  it('reports runtime errors with a traceback', async () => {
    const r = await sb.run({ kernelKey: 'p1:ws1', language: 'javascript', code: 'null.boom' });
    expect(r.ok).toBe(false);
    expect(r.outputs[0]).toMatchObject({ kind: 'error', name: 'TypeError' });
  });

  it('has no access to the host: no require, process env, files or child processes', async () => {
    const r = await sb.run({
      kernelKey: 'p1:sec',
      language: 'javascript',
      code: [
        'const out = [];',
        'out.push(typeof require, typeof fetch);',
        'const P = this.constructor.constructor("return process")();',
        'out.push(JSON.stringify(P.env));',
        'try { P.binding("fs"); out.push("binding OK") } catch (e) { out.push("binding denied") }',
        'out.push(typeof P.getBuiltinModule);',
        'out.join("|")',
      ].join('\n'),
    });
    expect(r.outputs.at(-1)).toEqual({ kind: 'result', text: '"undefined|undefined|{}|binding denied|undefined"' });
    // Module loading is not available to JavaScript cells at all (no require, no dynamic import).
    const fsTry = await sb.run({
      kernelKey: 'p1:sec',
      language: 'javascript',
      code: 'const F = this.constructor.constructor("return import(\\"node:fs\\")")();\nconst fs = await F;\ntry { fs.readFileSync("/etc/passwd"); "READ" } catch (e) { e.code }',
    });
    expect(fsTry.ok).toBe(false);
    expect(JSON.stringify(fsTry.outputs)).not.toContain('READ');
  });

  it('blocks files, processes and network even where module loading is possible (Python FFI)', async () => {
    const js = [
      '(async () => {',
      '  const out = [];',
      '  const fs = await import("node:fs");',
      '  try { fs.readFileSync("/etc/passwd"); out.push("READ") } catch (e) { out.push(e.code) }',
      '  try { fs.writeFileSync("/tmp/omnix-escape", "x"); out.push("WROTE") } catch (e) { out.push(e.code) }',
      '  const cp = await import("node:child_process");',
      '  try { cp.execSync("id"); out.push("EXEC") } catch (e) { out.push(e.code) }',
      '  const net = await import("node:net");',
      '  out.push(await new Promise((res) => { const s = net.connect(443, "1.1.1.1"); s.on("error", (e) => res(e.code)); s.on("connect", () => res("CONNECTED")); setTimeout(() => res("TIMEOUT"), 3000); }));',
      '  return out.join(",");',
      '})()',
    ].join('\n');
    const r = await sb.run({ kernelKey: 'p1:pynet', language: 'python', code: `from pyodide.code import run_js\nres = await run_js(${JSON.stringify(js)})\nres` });
    const text = JSON.stringify(r.outputs);
    expect(text).not.toMatch(/READ|WROTE|EXEC|CONNECTED/);
    expect(text).toContain('ERR_ACCESS_DENIED');
    if (sb.status().networkIsolation === 'namespace') expect(text).toMatch(/ENETUNREACH|EACCES/);
  }, 60_000);

  it('refuses to run code when it could read the server\'s files, unless the owner accepts that', async () => {
    const strict = new SandboxManager(host, DEFAULT_LIMITS, { forceNoPermission: true, forceNoNamespace: true });
    const relaxed = new SandboxManager(host, DEFAULT_LIMITS, { forceNoPermission: true, forceNoNamespace: true, requireFileIsolation: false });
    try {
      expect(strict.status()).toMatchObject({ canRun: false, permissionModel: false, networkIsolation: 'js-only' });
      expect(strict.status().warnings).toHaveLength(2);
      const refused = await strict.run({ kernelKey: 'p9:a', language: 'javascript', code: '1 + 1' });
      expect(refused.ok).toBe(false);
      expect(refused.outputs[0]).toMatchObject({ kind: 'error', name: 'SandboxUnavailable', message: expect.stringMatching(/OMNIX_SANDBOX_ISOLATION=best-effort/) });
      expect(relaxed.status()).toMatchObject({ canRun: true });
      expect(relaxed.status().warnings[0]).toMatch(/can read this server's files/);
      expect((await relaxed.run({ kernelKey: 'p9:b', language: 'javascript', code: '1 + 1' })).outputs).toEqual([{ kind: 'result', text: '2' }]);
    } finally {
      strict.shutdown();
      relaxed.shutdown();
    }
    // This server has both layers, so nothing to warn about.
    if (sb.status().permissionModel && sb.status().networkIsolation === 'namespace') expect(sb.status()).toMatchObject({ canRun: true, warnings: [] });
  }, 60_000);

  it('kills runaway code at the time limit and recovers', async () => {
    const quick = new SandboxManager(host, { ...DEFAULT_LIMITS, timeoutMs: 1500 });
    try {
      const r = await quick.run({ kernelKey: 'p2:loop', language: 'javascript', code: 'await new Promise(() => {}); 1' });
      expect(r.killed).toBe('timeout');
      expect(r.outputs.at(-1)).toMatchObject({ kind: 'error', name: 'TimeoutError' });
      const sync = await quick.run({ kernelKey: 'p2:loop', language: 'javascript', code: 'while (true) {}' });
      expect(sync.ok).toBe(false);
      const after = await quick.run({ kernelKey: 'p2:loop', language: 'javascript', code: '1 + 1' });
      expect(after.outputs).toEqual([{ kind: 'result', text: '2' }]);
    } finally {
      quick.shutdown();
    }
  });

  it('kills kernels that exceed the memory ceiling', async () => {
    const small = new SandboxManager(host, { ...DEFAULT_LIMITS, maxRssMb: 150, maxHeapMb: 1024, timeoutMs: 20000 });
    try {
      const r = await small.run({ kernelKey: 'p3:mem', language: 'javascript', code: 'const a = []; for (let i = 0; i < 1e8; i++) a.push(new Array(1000).fill(i)); a.length' });
      expect(r.ok).toBe(false);
      expect(['memory', 'crash']).toContain(r.killed);
    } finally {
      small.shutdown();
    }
  });

  it('isolates kernels per project', async () => {
    await sb.run({ kernelKey: 'projA:ws', language: 'javascript', code: 'globalThis.secret = 42' });
    const r = await sb.run({ kernelKey: 'projB:ws', language: 'javascript', code: 'typeof secret' });
    expect(r.outputs).toEqual([{ kind: 'result', text: '"undefined"' }]);
  });

  it('caps output volume', async () => {
    const tiny = new SandboxManager(host, { ...DEFAULT_LIMITS, maxOutputBytes: 1000 });
    try {
      const r = await tiny.run({ kernelKey: 'p4:out', language: 'javascript', code: 'for (let i = 0; i < 1000; i++) console.log("line " + i)' });
      const text = r.outputs.map((o) => ('text' in o ? o.text : '')).join('');
      expect(text).toContain('output truncated');
      expect(text.length).toBeLessThan(2000);
    } finally {
      tiny.shutdown();
    }
  });
});

describe('Python', () => {
  it('runs Python with persistent state, files, results and errors', async () => {
    const a = await sb.run({ kernelKey: 'p1:py', language: 'python', code: 'import statistics\nvals = [3, 4, 5]\nprint("mean", statistics.mean(vals))\nsum(vals)', files: { 'data/notes.txt': 'hello file' } });
    expect(a.ok).toBe(true);
    expect(a.outputs).toEqual([
      { kind: 'stdout', text: 'mean 4\n' },
      { kind: 'result', text: '12' },
    ]);
    const b = await sb.run({ kernelKey: 'p1:py', language: 'python', code: 'open("data/notes.txt").read().upper()' });
    expect(b.outputs).toEqual([{ kind: 'result', text: "'HELLO FILE'" }]);
    const c = await sb.run({ kernelKey: 'p1:py', language: 'python', code: 'def f():\n    return 1/0\nf()' });
    expect(c.ok).toBe(false);
    expect(c.outputs[0]).toMatchObject({ kind: 'error', name: 'ZeroDivisionError', message: 'division by zero' });
  }, 60_000);

  it('exposes the omnix module for charts, tables, images and assets', async () => {
    const r = await sb.run({
      kernelKey: 'p1:py',
      language: 'python',
      code: [
        'import omnix',
        'omnix.chart(type="line", labels=["Q1","Q2"], series=[{"name":"rev","values":[1,2]}])',
        'omnix.table([{"a": 1, "b": "x"}])',
        'omnix.image(b"\\x89PNG fake", "image/png")',
        'text = await omnix.read_asset_text("csv1")',
        'aid = await omnix.write_asset("report.md", "# Hi", "text/markdown")',
        'print(text.splitlines()[1])',
        'aid',
      ].join('\n'),
    });
    expect(r.ok).toBe(true);
    const kinds = r.outputs.map((o) => o.kind);
    expect(kinds).toEqual(['chart', 'table', 'image-data', 'stdout', 'result']);
    expect(r.outputs[1]).toEqual({ kind: 'table', columns: ['a', 'b'], rows: [[1, 'x']] });
    expect(written.at(-1)!.name).toBe('report.md');
  }, 60_000);

  it('cannot reach host files or the network', async () => {
    const r = await sb.run({
      kernelKey: 'p1:py',
      language: 'python',
      code: 'import os\nres = []\ntry:\n    open("/etc/passwd").read()\n    res.append("READ")\nexcept Exception as e:\n    res.append(type(e).__name__)\nimport js\nres.append(str(hasattr(js, "fetch")))\n",".join(res)',
    });
    expect(r.outputs.at(-1)).toEqual({ kind: 'result', text: "'FileNotFoundError,False'" });
  }, 60_000);
});
