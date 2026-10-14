import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import type { CellOutput } from '@omnix/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const KERNEL = path.resolve(here, '../runtime/kernel.mjs');

export type SandboxLanguage = 'python' | 'javascript' | 'typescript';

/** Outputs as produced by the kernel; image data is turned into assets by the host. */
export type RawOutput = Exclude<CellOutput, { kind: 'image' }> | { kind: 'image-data'; base64: string; mime: string };

export interface RunRequest {
  /** Isolation key: one kernel per key (e.g. `${projectId}:${workspaceId}`). Kernels never span projects. */
  kernelKey: string;
  language: SandboxLanguage;
  code: string;
  filename?: string;
  /** Workspace files made visible to the code (Python: /workspace; JS: omnix.files). */
  files?: Record<string, string>;
  allowNetwork?: boolean;
  packages?: string[];
  timeoutMs?: number;
  onStream?: (stream: 'stdout' | 'stderr', text: string) => void;
}

export interface RunResult {
  outputs: RawOutput[];
  ms: number;
  ok: boolean;
  /** Set when the kernel had to be killed (timeout, memory, crash). */
  killed?: 'timeout' | 'memory' | 'crash';
}

/** Asset access for code. `kernelKey` identifies the workspace, so hosts can scope access to one project. */
export interface SandboxHost {
  readAsset(assetId: string, kernelKey: string): Promise<{ data: Buffer; mime: string }>;
  writeAsset(name: string, data: Buffer, mime: string, kernelKey: string): Promise<string>;
}

export interface SandboxLimits {
  /** Wall-clock limit per run. */
  timeoutMs: number;
  /** Resident memory ceiling for a kernel process. */
  maxRssMb: number;
  /** JS heap limit passed to V8. */
  maxHeapMb: number;
  /** Kernels shut down after this much inactivity. */
  idleMs: number;
  /** Max simultaneous kernels on the server. */
  maxKernels: number;
  maxOutputBytes: number;
  /** Packages a project may request (only loadable when the project allows network). */
  packageAllowlist: string[];
  maxPackages: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  timeoutMs: 30_000,
  maxRssMb: 768,
  maxHeapMb: 384,
  idleMs: 10 * 60_000,
  maxKernels: 8,
  maxOutputBytes: 1_000_000,
  packageAllowlist: ['numpy', 'pandas', 'matplotlib', 'scipy', 'scikit-learn', 'pillow', 'sympy', 'networkx', 'regex', 'pyyaml', 'beautifulsoup4', 'micropip'],
  maxPackages: 8,
};

interface Kernel {
  key: string;
  language: 'python' | 'javascript';
  proc: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  lastUsed: number;
  busy: boolean;
  listeners: Set<(msg: KernelMessage) => void>;
  memTimer: NodeJS.Timeout;
  killedFor?: RunResult['killed'];
  network: boolean;
  packages: string[];
}

type KernelMessage = { type: string; [k: string]: unknown };

export interface SandboxStatus {
  python: boolean;
  javascript: boolean;
  networkIsolation: 'namespace' | 'js-only';
  permissionModel: boolean;
  kernels: { key: string; language: string; busy: boolean; idleSeconds: number }[];
}

function resolvePyodideDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('pyodide/package.json');
    return fs.realpathSync(path.dirname(pkg));
  } catch {
    return null;
  }
}

/**
 * Manages sandbox kernels. Each kernel is a separate, locked-down Node process.
 * See runtime/kernel.mjs for the isolation layers.
 */
export class SandboxManager {
  private kernels = new Map<string, Kernel>();
  private readonly pyodideDir = resolvePyodideDir();
  private readonly pyodideVersion: string | null = this.pyodideDir ? (JSON.parse(fs.readFileSync(path.join(this.pyodideDir, 'package.json'), 'utf8')) as { version: string }).version : null;
  private readonly netns: boolean;
  private readonly permission: boolean;
  private sweep: NodeJS.Timeout;
  private runCounter = 0;

  constructor(
    private readonly host: SandboxHost,
    readonly limits: SandboxLimits = DEFAULT_LIMITS,
    options: { forceNoNamespace?: boolean } = {},
  ) {
    this.netns = !options.forceNoNamespace && process.platform === 'linux' && spawnSync('unshare', ['-rn', 'true']).status === 0;
    this.permission = spawnSync(process.execPath, ['--permission', '-e', '0']).status === 0;
    this.sweep = setInterval(() => this.reapIdle(), 30_000);
    this.sweep.unref();
  }

  status(): SandboxStatus {
    return {
      python: !!this.pyodideDir,
      javascript: true,
      networkIsolation: this.netns ? 'namespace' : 'js-only',
      permissionModel: this.permission,
      kernels: [...this.kernels.values()].map((k) => ({ key: k.key, language: k.language, busy: k.busy, idleSeconds: Math.round((Date.now() - k.lastUsed) / 1000) })),
    };
  }

  private spawnKernel(key: string, language: 'python' | 'javascript', allowNetwork: boolean, packages: string[]): Kernel {
    if (this.kernels.size >= this.limits.maxKernels) {
      // Evict the least recently used idle kernel.
      const idle = [...this.kernels.values()].filter((k) => !k.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) throw new Error('The code sandbox is busy. Try again in a moment.');
      this.kill(idle.key);
    }
    const nodeArgs = [`--max-old-space-size=${this.limits.maxHeapMb}`];
    if (this.permission) {
      const reads = [path.dirname(KERNEL) + '/'];
      if (this.pyodideDir) reads.push(this.pyodideDir + '/');
      nodeArgs.unshift('--permission', ...reads.map((r) => `--allow-fs-read=${r}`));
    }
    nodeArgs.push(KERNEL);
    const useNs = this.netns && !allowNetwork;
    const cmd = useNs ? 'unshare' : process.execPath;
    const args = useNs ? ['-rn', process.execPath, ...nodeArgs] : nodeArgs;
    const proc = spawn(cmd, args, {
      env: { OMNIX_PYODIDE_DIR: language === 'python' ? this.pyodideDir ?? '' : '' },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: path.dirname(KERNEL),
    });
    const kernel: Kernel = {
      key,
      language,
      proc,
      lastUsed: Date.now(),
      busy: false,
      listeners: new Set(),
      ready: Promise.resolve(),
      memTimer: setInterval(() => this.checkMemory(kernel), 250),
      network: allowNetwork,
      packages,
    };
    kernel.memTimer.unref();
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      let msg: KernelMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === 'read-asset' || msg.type === 'write-asset') {
        void this.serviceRequest(kernel, msg);
        return;
      }
      for (const l of kernel.listeners) l(msg);
    });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    proc.on('exit', () => {
      clearInterval(kernel.memTimer);
      if (this.kernels.get(key) === kernel) this.kernels.delete(key);
      for (const l of kernel.listeners) l({ type: 'exit', stderr });
    });
    kernel.ready = new Promise<void>((resolve, reject) => {
      const onMsg = (m: KernelMessage) => {
        if (m.type === 'ready') {
          kernel.listeners.delete(onMsg);
          resolve();
        } else if (m.type === 'init-error' || m.type === 'exit') {
          kernel.listeners.delete(onMsg);
          reject(new Error(String(m.error ?? `Sandbox failed to start. ${String(m.stderr ?? '')}`.trim())));
        }
      };
      kernel.listeners.add(onMsg);
    });
    this.send(kernel, {
      type: 'init',
      config: {
        language,
        allowNetwork,
        packages,
        maxOutputBytes: this.limits.maxOutputBytes,
        packageBaseUrl: this.pyodideVersion ? `https://cdn.jsdelivr.net/pyodide/v${this.pyodideVersion}/full/` : null,
      },
    });
    this.kernels.set(key, kernel);
    return kernel;
  }

  private send(k: Kernel, msg: unknown): void {
    if (k.proc.stdin.writable) k.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  private async serviceRequest(k: Kernel, msg: KernelMessage): Promise<void> {
    try {
      if (msg.type === 'read-asset') {
        const a = await this.host.readAsset(String(msg.assetId), k.key);
        if (a.data.length > 50 * 1024 * 1024) throw new Error('Asset is too large to load in the sandbox (50 MB limit)');
        this.send(k, { type: 'response', reqId: msg.reqId, base64: a.data.toString('base64'), mime: a.mime });
      } else {
        const data = Buffer.from(String(msg.base64), 'base64');
        if (data.length > 50 * 1024 * 1024) throw new Error('Output file is too large (50 MB limit)');
        const assetId = await this.host.writeAsset(String(msg.name), data, String(msg.mime), k.key);
        this.send(k, { type: 'response', reqId: msg.reqId, assetId });
      }
    } catch (e) {
      this.send(k, { type: 'response', reqId: msg.reqId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private checkMemory(k: Kernel): void {
    const pid = k.proc.pid;
    if (!pid) return;
    try {
      // The kernel may be wrapped by `unshare`; read the RSS of the whole process group via /proc.
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = /VmRSS:\s+(\d+)/.exec(status);
      let rss = m ? Number(m[1]) / 1024 : 0;
      try {
        for (const child of fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean)) {
          const cs = fs.readFileSync(`/proc/${child}/status`, 'utf8');
          const cm = /VmRSS:\s+(\d+)/.exec(cs);
          if (cm) rss += Number(cm[1]) / 1024;
        }
      } catch {
        // children listing unavailable
      }
      if (rss > this.limits.maxRssMb) {
        k.killedFor = 'memory';
        this.kill(k.key);
      }
    } catch {
      // Not on Linux / process gone.
    }
  }

  private kernelFor(req: RunRequest): Kernel {
    const lang = req.language === 'python' ? 'python' : 'javascript';
    const key = `${req.kernelKey}:${lang}`;
    const network = !!req.allowNetwork;
    const packages = network ? this.allowedPackages(req.packages ?? []) : [];
    const existing = this.kernels.get(key);
    if (existing && (existing.network !== network || existing.packages.join(',') !== packages.join(','))) this.kill(key);
    return this.kernels.get(key) ?? this.spawnKernel(key, lang, network, packages);
  }

  /** Requested packages filtered by the allowlist and count limit. */
  allowedPackages(requested: string[]): string[] {
    const allowed = new Set(this.limits.packageAllowlist);
    return [...new Set(requested.map((p) => p.trim().toLowerCase()).filter((p) => allowed.has(p)))].slice(0, this.limits.maxPackages);
  }

  async run(req: RunRequest): Promise<RunResult> {
    if (req.language === 'python' && !this.pyodideDir) {
      return { ok: false, ms: 0, outputs: [{ kind: 'error', name: 'RuntimeUnavailable', message: 'Python is not installed in this Omnix server (the pyodide package is missing).' }] };
    }
    let code = req.code;
    if (req.language === 'typescript') {
      try {
        code = (await transform(code, { loader: 'ts', format: 'esm', target: 'es2022' })).code;
        // Scripts cannot contain `export`; strip the empty export esbuild may add.
        code = code.replace(/^export\s*\{\s*\};?\s*$/m, '');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, ms: 0, outputs: [{ kind: 'error', name: 'TypeScriptError', message: msg.split('\n').slice(0, 6).join('\n') }] };
      }
    }
    const kernel = this.kernelFor(req);
    if (kernel.busy) return { ok: false, ms: 0, outputs: [{ kind: 'error', name: 'Busy', message: 'Another cell is still running in this workspace. Wait for it or restart the kernel.' }] };
    kernel.busy = true;
    kernel.lastUsed = Date.now();
    try {
      try {
        await kernel.ready;
      } catch (e) {
        this.kill(kernel.key);
        return { ok: false, ms: 0, outputs: [{ kind: 'error', name: 'SandboxError', message: e instanceof Error ? e.message : String(e) }] };
      }
      if (req.files) {
        await new Promise<void>((resolve) => {
          const onMsg = (m: KernelMessage) => {
            if (m.type === 'files-ok' || m.type === 'exit' || m.type === 'fatal') {
              kernel.listeners.delete(onMsg);
              resolve();
            }
          };
          kernel.listeners.add(onMsg);
          this.send(kernel, { type: 'files', files: req.files });
        });
      }
      const id = `run${++this.runCounter}`;
      const timeoutMs = Math.min(req.timeoutMs ?? this.limits.timeoutMs, this.limits.timeoutMs * 10);
      const outputs: RawOutput[] = [];
      const pushStream = (stream: 'stdout' | 'stderr', text: string) => {
        req.onStream?.(stream, text);
        const last = outputs[outputs.length - 1];
        if (last && last.kind === stream) (last as { text: string }).text += text;
        else outputs.push({ kind: stream, text });
      };
      const start = Date.now();
      const result = await new Promise<RunResult>((resolve) => {
        const timer = setTimeout(() => {
          kernel.killedFor = 'timeout';
          this.kill(kernel.key);
        }, timeoutMs);
        const onMsg = (m: KernelMessage) => {
          if (m.type === 'stream' && m.id === id) pushStream(m.stream as 'stdout' | 'stderr', String(m.text));
          else if (m.type === 'display' && m.id === id) outputs.push(m.output as RawOutput);
          else if (m.type === 'fatal') outputs.push({ kind: 'error', name: 'SandboxError', message: String(m.error) });
          else if ((m.type === 'done' && m.id === id) || m.type === 'exit') {
            clearTimeout(timer);
            kernel.listeners.delete(onMsg);
            if (m.type === 'exit') {
              const why = kernel.killedFor ?? 'crash';
              const message =
                why === 'timeout'
                  ? `Stopped after ${Math.round(timeoutMs / 1000)}s (time limit). The kernel was restarted, so earlier variables are gone.`
                  : why === 'memory'
                    ? `Stopped: the code used more than ${this.limits.maxRssMb} MB of memory. The kernel was restarted.`
                    : `The sandbox process exited unexpectedly. ${String(m.stderr ?? '').split('\n').slice(-3).join(' ')}`.trim();
              outputs.push({ kind: 'error', name: why === 'timeout' ? 'TimeoutError' : why === 'memory' ? 'MemoryError' : 'SandboxCrash', message });
              resolve({ outputs, ms: Date.now() - start, ok: false, killed: why });
            } else resolve({ outputs, ms: Number(m.ms ?? Date.now() - start), ok: !m.failed });
          }
        };
        kernel.listeners.add(onMsg);
        this.send(kernel, { type: 'run', id, code, filename: req.filename, timeoutMs });
      });
      return result;
    } finally {
      kernel.busy = false;
      kernel.lastUsed = Date.now();
    }
  }

  /** Restart a workspace's kernel (clears its variables). */
  restart(kernelKey: string): void {
    for (const lang of ['python', 'javascript']) this.kill(`${kernelKey}:${lang}`);
  }

  private kill(key: string): void {
    const k = this.kernels.get(key);
    if (!k) return;
    this.kernels.delete(key);
    clearInterval(k.memTimer);
    try {
      k.proc.kill('SIGKILL');
    } catch {
      // already gone
    }
  }

  private reapIdle(): void {
    for (const k of this.kernels.values()) if (!k.busy && Date.now() - k.lastUsed > this.limits.idleMs) this.kill(k.key);
  }

  shutdown(): void {
    clearInterval(this.sweep);
    for (const key of [...this.kernels.keys()]) this.kill(key);
  }
}
