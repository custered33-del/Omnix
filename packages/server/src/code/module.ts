import path from 'node:path';
import { z } from 'zod';
import { SandboxManager, type RawOutput, type SandboxLanguage } from '@omnix/sandbox';
import { childrenOf, closest, requireNodeOfType, type Author, type CellOutput, type ProjectState, type SceneNode } from '@omnix/core';
import type { Services } from '../services.js';
import { onShutdown, useModule } from '../app.js';
import { h, requireUser, author as authorOf } from '../http/middleware.js';
import { ProjectError, type ProjectEvent } from '../projects/service.js';
import { zipSync, strToU8 } from 'fflate';
import { CodeHistory, notebookJson } from './history.js';
import { registerExportHandler } from '../export/module.js';
import { registerToolProvider } from '../mcp/tools/index.js';
import { codeTools } from './tools.js';

/**
 * Code Grounds server module: sandboxed runs for files and notebook cells, live output
 * streaming, cell outputs saved into the project, and git-backed history.
 */
export interface CodeRunTarget {
  workspaceId: string;
  cellId?: string;
  fileId?: string;
  source?: string;
  language?: SandboxLanguage;
}

export interface CodeRunResult {
  ok: boolean;
  outputs: CellOutput[];
  ms: number;
  commitId?: string;
  runId: string;
}

let runSeq = 0;

export function languageOfFile(p: string): SandboxLanguage | null {
  const ext = p.split('.').pop()?.toLowerCase();
  if (ext === 'py') return 'python';
  if (ext === 'js' || ext === 'mjs') return 'javascript';
  if (ext === 'ts') return 'typescript';
  return null;
}

export class CodeService {
  readonly sandbox: SandboxManager;
  readonly history: CodeHistory;
  private kernelOwners = new Map<string, { projectId: string; userId: string }>();

  constructor(private readonly services: Services) {
    this.history = new CodeHistory(path.join(services.config.dataDir, 'git'));
    this.sandbox = new SandboxManager({
      readAsset: async (assetId, kernelKey) => {
        const owner = this.ownerOf(kernelKey);
        const a = await services.assets.get(assetId);
        // Code may read assets used in its own project or owned by the person running it.
        if (!a || !(a.projectIds.includes(owner.projectId) || a.owners.includes(owner.userId))) throw new Error(`Asset not found: ${assetId}`);
        const data = await services.blobs.get(a.id);
        if (!data) throw new Error('Asset file missing');
        return { data, mime: a.mime };
      },
      writeAsset: async (name, data, mime, kernelKey) => {
        const owner = this.ownerOf(kernelKey);
        const a = await services.assets.ingestBuffer(data, { name, ownerId: owner.userId, projectId: owner.projectId, mimeHint: mime, tags: ['code-output'], source: { kind: 'code', projectId: owner.projectId } });
        return a.id;
      },
    }, undefined, { requireFileIsolation: services.config.sandboxIsolation !== 'best-effort' });
    // Mirror code changes into git.
    services.projects.on('event', (e: ProjectEvent) => {
      if (e.type !== 'commit') return;
      void (async () => {
        const state = await services.projects.state(e.projectId).catch(() => null);
        if (!state) return;
        for (const ws of CodeHistory.affectedWorkspaces(state, e.commit)) {
          if (!this.history.hasRepo(e.projectId, ws)) {
            const session = await services.projects.session(e.projectId);
            const parent = e.commit.parentId;
            await this.history.ensureInitialized(e.projectId, ws, async () => session.stateAt(parent));
          }
          this.history.schedule(e.projectId, ws, e.commit.author, e.commit.label, () => services.projects.state(e.projectId));
        }
      })();
    });
  }

  private ownerOf(kernelKey: string): { projectId: string; userId: string } {
    const base = kernelKey.split(':').slice(0, 2).join(':');
    const o = this.kernelOwners.get(base);
    if (!o) throw new Error('Unknown sandbox kernel');
    return o;
  }

  /** Files of a workspace as a path -> content map (what code can open()). */
  workspaceFiles(state: ProjectState, workspaceId: string): Record<string, string> {
    const files: Record<string, string> = {};
    for (const n of childrenOf(state, workspaceId)) if (n.type === 'codeFile') files[(n as SceneNode<'codeFile'>).props.path] = (n as SceneNode<'codeFile'>).props.content;
    return files;
  }

  /** Convert kernel outputs into project outputs (image data becomes assets). */
  private async finalize(outputs: RawOutput[], projectId: string, userId: string): Promise<CellOutput[]> {
    const out: CellOutput[] = [];
    for (const o of outputs) {
      if (o.kind === 'image-data') {
        try {
          const a = await this.services.assets.ingestBuffer(Buffer.from(o.base64, 'base64'), { name: `output.${o.mime.split('/')[1] ?? 'png'}`, ownerId: userId, projectId, mimeHint: o.mime, tags: ['code-output'], source: { kind: 'code', projectId } });
          out.push({ kind: 'image', assetId: a.id, mime: a.mime });
        } catch (e) {
          out.push({ kind: 'error', name: 'ImageError', message: `Could not store image output: ${(e as Error).message}` });
        }
      } else out.push(o);
    }
    return out;
  }

  /**
   * Run a file, cell or snippet. `state` is the project as the caller sees it (Claude in approval
   * mode runs the code it has proposed, not what is committed); it defaults to the current state.
   */
  async run(projectId: string, target: CodeRunTarget, by: { userId: string; author: Author; via: 'ui' | 'mcp' | 'agent' | 'api'; jobId?: string; persist?: boolean; state?: ProjectState }): Promise<CodeRunResult> {
    const state = by.state ?? (await this.services.projects.state(projectId));
    const node = <T extends 'codeWorkspace' | 'cell' | 'codeFile'>(id: string, type: T, what: string) => {
      try {
        return requireNodeOfType(state, id, type);
      } catch {
        throw new ProjectError(`No ${what} with id ${id} in this project. List the workspace's files and notebooks with get_project.`, 404);
      }
    };
    const ws = node(target.workspaceId, 'codeWorkspace', 'code workspace');
    const runId = `run_${Date.now().toString(36)}_${++runSeq}`;
    let code: string;
    let language: SandboxLanguage;
    let filename: string | undefined;
    let cell: SceneNode<'cell'> | undefined;
    if (target.cellId) {
      cell = node(target.cellId, 'cell', 'notebook cell');
      if (closest(state, cell.id, 'codeWorkspace')?.id !== ws.id) throw new ProjectError('That cell is not in this workspace', 400);
      if (cell.props.cellType === 'markdown') return { ok: true, outputs: [], ms: 0, runId };
      code = cell.props.source;
      language = cell.props.language;
    } else if (target.fileId) {
      const file = node(target.fileId, 'codeFile', 'code file');
      const lang = languageOfFile(file.props.path);
      if (!lang) throw new ProjectError(`${file.props.path} is not a runnable Python, JavaScript or TypeScript file`, 400);
      code = file.props.content;
      language = lang;
      filename = file.props.path;
    } else if (target.source !== undefined) {
      code = target.source;
      language = target.language ?? 'python';
    } else throw new ProjectError('Nothing to run: pass a cellId, fileId or source', 400);

    const base = `${projectId}:${ws.id}`;
    this.kernelOwners.set(base, { projectId, userId: by.userId });
    const emit = (stream: 'stdout' | 'stderr', text: string) => this.services.projects.emit('event', { type: 'code', projectId, runId, stream, text, cellId: cell?.id ?? null } satisfies ProjectEvent);
    const result = await this.sandbox.run({
      kernelKey: base,
      language,
      code,
      ...(filename ? { filename } : {}),
      files: this.workspaceFiles(state, ws.id),
      allowNetwork: ws.props.allowNetwork,
      packages: ws.props.packages,
      onStream: emit,
    });
    const outputs = await this.finalize(result.outputs, projectId, by.userId);
    let commitId: string | undefined;
    if (cell && by.persist !== false) {
      const fresh = await this.services.projects.state(projectId);
      if (fresh.nodes[cell.id]) {
        const c = await this.services.projects.commit(
          projectId,
          { kind: 'update', id: cell.id, set: { outputs, executionCount: ((fresh.nodes[cell.id] as SceneNode<'cell'>).props.executionCount ?? 0) + 1, lastRunAt: new Date().toISOString(), lastRunMs: result.ms } },
          by.author,
          { label: `Run cell${result.ok ? '' : ' (error)'}`, via: by.via, trusted: true, ...(by.jobId ? { jobId: by.jobId } : {}) },
        );
        commitId = c.id;
      }
    }
    return { ok: result.ok, outputs, ms: result.ms, runId, ...(commitId ? { commitId } : {}) };
  }

  async runAll(projectId: string, notebookId: string, by: Parameters<CodeService['run']>[2]): Promise<CodeRunResult[]> {
    const state = await this.services.projects.state(projectId);
    const nb = requireNodeOfType(state, notebookId, 'notebook');
    const ws = closest(state, nb.id, 'codeWorkspace')!;
    const results: CodeRunResult[] = [];
    for (const c of childrenOf(state, nb.id)) {
      if (c.type !== 'cell') continue;
      const r = await this.run(projectId, { workspaceId: ws.id, cellId: c.id }, by);
      results.push(r);
      if (!r.ok) break;
    }
    return results;
  }

  restart(projectId: string, workspaceId: string): void {
    this.sandbox.restart(`${projectId}:${workspaceId}`);
  }
}

export function codeService(services: Services): CodeService {
  const s = services.ext.code as CodeService | undefined;
  if (!s) throw new Error('Code module not loaded');
  return s;
}

/** Workspace as files: code files as-is, notebooks as Jupyter JSON. */
export function workspaceArchive(state: ProjectState, workspaceId: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const n of childrenOf(state, workspaceId)) {
    if (n.type === 'codeFile') files.set((n as SceneNode<'codeFile'>).props.path.replace(/^\/+/, ''), (n as SceneNode<'codeFile'>).props.content);
    else if (n.type === 'notebook') files.set(`${fileSafe((n as SceneNode<'notebook'>).props.name)}.ipynb`, notebookJson(state, n as SceneNode<'notebook'>));
  }
  return files;
}

const fileSafe = (s: string) => s.replace(/[^\w\- .]+/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'notebook';

useModule(({ services, router }) => {
  const code = new CodeService(services);
  services.ext.code = code;
  registerToolProvider(services, () => codeTools(code));

  // Exports: the whole workspace as a ZIP, or notebooks as .ipynb.
  registerExportHandler(services, async (_s, state, node, req) => {
    if (node.type === 'codeWorkspace') {
      const ws = node as SceneNode<'codeWorkspace'>;
      const files = workspaceArchive(state, ws.id);
      if (req.format === 'ipynb') {
        const nb = childrenOf(state, ws.id).find((n) => n.type === 'notebook') as SceneNode<'notebook'> | undefined;
        if (!nb) throw new ProjectError('This workspace has no notebook to export', 400);
        return { data: Buffer.from(notebookJson(state, nb)), name: `${fileSafe(nb.props.name)}.ipynb`, mime: 'application/x-ipynb+json', notes: [] };
      }
      if (req.format !== 'zip') throw new ProjectError('Code exports as zip or ipynb', 400);
      const entries: Record<string, Uint8Array> = {};
      for (const [p, content] of files) entries[p] = strToU8(content);
      return { data: Buffer.from(zipSync(entries, { level: 6 })), name: `${fileSafe(ws.props.name)}.zip`, mime: 'application/zip', notes: files.size ? [] : ['The workspace is empty.'] };
    }
    if (node.type === 'notebook') {
      if (req.format !== 'ipynb') throw new ProjectError('Notebooks export as ipynb', 400);
      const nb = node as SceneNode<'notebook'>;
      return { data: Buffer.from(notebookJson(state, nb)), name: `${fileSafe(nb.props.name)}.ipynb`, mime: 'application/x-ipynb+json', notes: [] };
    }
    return null;
  });
  onShutdown(services, async () => {
    await code.history.flushAll();
    code.sandbox.shutdown();
  });

  router.get(
    '/code/status',
    h(async (req, res) => {
      requireUser(req);
      res.json({ sandbox: code.sandbox.status(), limits: { timeoutMs: code.sandbox.limits.timeoutMs, maxRssMb: code.sandbox.limits.maxRssMb, packageAllowlist: code.sandbox.limits.packageAllowlist, maxPackages: code.sandbox.limits.maxPackages } });
    }),
  );

  router.post(
    '/projects/:id/code/run',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      await services.projects.requireAccess(projectId, user.id, 'write');
      const body = z
        .object({ workspaceId: z.string(), cellId: z.string().optional(), fileId: z.string().optional(), notebookId: z.string().optional(), source: z.string().max(500_000).optional(), language: z.enum(['python', 'javascript', 'typescript']).optional() })
        .parse(req.body);
      const by = { userId: user.id, author: authorOf(req), via: (req.viaToken ? 'api' : 'ui') as 'ui' | 'api' };
      if (body.notebookId) {
        res.json({ results: await code.runAll(projectId, body.notebookId, by) });
        return;
      }
      res.json(await code.run(projectId, body, by));
    }),
  );

  router.post(
    '/projects/:id/code/restart',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      await services.projects.requireAccess(projectId, user.id, 'write');
      const body = z.object({ workspaceId: z.string() }).parse(req.body);
      code.restart(projectId, body.workspaceId);
      res.json({ ok: true });
    }),
  );

  router.get(
    '/projects/:id/code/:workspaceId/history',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      await services.projects.requireAccess(projectId, user.id, 'read');
      await code.history.flush(projectId, String(req.params.workspaceId));
      res.json({ commits: await code.history.log(projectId, String(req.params.workspaceId)) });
    }),
  );

  router.get(
    '/projects/:id/code/:workspaceId/history/:oid',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      await services.projects.requireAccess(projectId, user.id, 'read');
      if (!/^[0-9a-f]{40}$/.test(String(req.params.oid))) throw new ProjectError('Invalid commit id', 400);
      res.json(await code.history.show(projectId, String(req.params.workspaceId), String(req.params.oid)));
    }),
  );
});
