import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import git from 'isomorphic-git';
import { createTwoFilesPatch } from 'diff';
import type { Author, Commit, ProjectState, SceneNode } from '@omnix/core';
import { childrenOf, touchedIds, closest } from '@omnix/core';
import { safeName } from '../storage/fileStore.js';

/**
 * Git-backed history for Code Grounds. Every change to a workspace's files (by a person or
 * by Claude) becomes a real git commit with the right author, so code review tools work and
 * the history can be cloned out. Changes from one author in quick succession are batched.
 */
export interface CodeCommitInfo {
  oid: string;
  message: string;
  author: { name: string; email: string };
  timestamp: number;
  aiAuthored: boolean;
}

export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  patch: string;
}

function emailFor(a: Author): string {
  if (a.type === 'ai') return `${safeName(a.name).toLowerCase()}@ai.omnix.local`;
  return `${safeName(a.id)}@users.omnix.local`;
}

export class CodeHistory {
  private timers = new Map<string, NodeJS.Timeout>();
  private pending = new Map<string, { author: Author; labels: string[]; state: () => Promise<ProjectState> }>();
  private chains = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  repoDir(projectId: string, workspaceId: string): string {
    return path.join(this.root, safeName(projectId), safeName(workspaceId));
  }

  /** Workspaces whose files a commit touched (deletions are found through the inverse op's parent). */
  static affectedWorkspaces(after: ProjectState, commit: Commit): string[] {
    const out = new Set<string>();
    for (const id of new Set([...touchedIds(commit.op), ...touchedIds(commit.inverse)])) {
      if (!after.nodes[id]) continue;
      const ws = closest(after, id, 'codeWorkspace');
      if (ws) out.add(ws.id);
    }
    return [...out];
  }

  hasRepo(projectId: string, workspaceId: string): boolean {
    return fs.existsSync(path.join(this.repoDir(projectId, workspaceId), '.git'));
  }

  /** Create the repository with an "Initial version" commit of the state before the first tracked change. */
  async ensureInitialized(projectId: string, workspaceId: string, before: () => Promise<ProjectState>): Promise<void> {
    const key = `${projectId}/${workspaceId}`;
    await this.serial(key, async () => {
      if (this.hasRepo(projectId, workspaceId)) return;
      await this.commitWorkspace(projectId, workspaceId, await before(), { type: 'system', id: 'system', name: 'Omnix' }, ['Initial version']);
    });
  }

  /** Queue a sync for a workspace; flushes early when the author changes. */
  schedule(projectId: string, workspaceId: string, author: Author, label: string, state: () => Promise<ProjectState>): void {
    const key = `${projectId}/${workspaceId}`;
    const existing = this.pending.get(key);
    if (existing && existing.author.id !== author.id) void this.flush(projectId, workspaceId);
    const p = this.pending.get(key) ?? { author, labels: [], state };
    p.labels.push(label);
    p.state = state;
    this.pending.set(key, p);
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.set(
      key,
      setTimeout(() => void this.flush(projectId, workspaceId), 1200),
    );
  }

  private serial(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(key, next.catch(() => {}));
    return next;
  }

  async flush(projectId: string, workspaceId: string): Promise<string | null> {
    const key = `${projectId}/${workspaceId}`;
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
    const p = this.pending.get(key);
    if (!p) return null;
    this.pending.delete(key);
    let oid: string | null = null;
    await this.serial(key, async () => {
      oid = await this.commitWorkspace(projectId, workspaceId, await p.state(), p.author, p.labels);
    });
    return oid;
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((k) => {
      const [projectId, workspaceId] = k.split('/') as [string, string];
      return this.flush(projectId, workspaceId);
    }));
  }

  /** Write the workspace files to the repo and commit if anything changed. */
  async commitWorkspace(projectId: string, workspaceId: string, state: ProjectState, author: Author, labels: string[]): Promise<string | null> {
    const dir = this.repoDir(projectId, workspaceId);
    await fsp.mkdir(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, '.git'))) await git.init({ fs, dir, defaultBranch: 'main' });
    const ws = state.nodes[workspaceId];
    const files = new Map<string, string>();
    if (ws && ws.type === 'codeWorkspace') {
      for (const n of childrenOf(state, workspaceId)) {
        if (n.type === 'codeFile') {
          const f = n as SceneNode<'codeFile'>;
          files.set(f.props.path, f.props.content);
        } else if (n.type === 'notebook') {
          // Notebooks are stored as Jupyter-compatible JSON so diffs stay readable.
          const nb = n as SceneNode<'notebook'>;
          files.set(`${safeName(nb.props.name)}.ipynb`, notebookJson(state, nb));
        }
      }
    }
    // Remove files that no longer exist.
    const tracked = await git.listFiles({ fs, dir }).catch(() => [] as string[]);
    for (const f of tracked) {
      if (!files.has(f)) {
        await fsp.rm(path.join(dir, f), { force: true });
        await git.remove({ fs, dir, filepath: f });
      }
    }
    for (const [p, content] of files) {
      const full = path.join(dir, p);
      if (!full.startsWith(dir + path.sep)) continue;
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, content);
      await git.add({ fs, dir, filepath: p });
    }
    const matrix = await git.statusMatrix({ fs, dir });
    const changed = matrix.some(([, head, work, stage]) => !(head === 1 && work === 1 && stage === 1));
    if (!changed && tracked.length) return null;
    const unique = [...new Set(labels)];
    const subject = unique.length === 1 ? unique[0]! : `${unique.length} changes: ${unique.slice(0, 3).join('; ')}${unique.length > 3 ? '...' : ''}`;
    const message = `${subject}\n\n${author.type === 'ai' ? `Changed by ${author.name} (AI) in Omnix.` : `Changed by ${author.name} in Omnix.`}\n`;
    return git.commit({ fs, dir, message, author: { name: author.name, email: emailFor(author) } });
  }

  async log(projectId: string, workspaceId: string, depth = 100): Promise<CodeCommitInfo[]> {
    const dir = this.repoDir(projectId, workspaceId);
    if (!fs.existsSync(path.join(dir, '.git'))) return [];
    const entries = await git.log({ fs, dir, depth }).catch(() => []);
    return entries.map((e) => ({ oid: e.oid, message: e.commit.message, author: { name: e.commit.author.name, email: e.commit.author.email }, timestamp: e.commit.author.timestamp * 1000, aiAuthored: e.commit.author.email.endsWith('@ai.omnix.local') }));
  }

  /** Unified diffs of one commit against its parent. */
  async show(projectId: string, workspaceId: string, oid: string): Promise<{ commit: CodeCommitInfo; files: FileDiff[] }> {
    const dir = this.repoDir(projectId, workspaceId);
    const c = await git.readCommit({ fs, dir, oid });
    const parent = c.commit.parent[0];
    const read = async (commitOid: string | undefined) => {
      const map = new Map<string, string>();
      if (!commitOid) return map;
      for (const f of await git.listFiles({ fs, dir, ref: commitOid })) {
        const { blob } = await git.readBlob({ fs, dir, oid: commitOid, filepath: f });
        map.set(f, Buffer.from(blob).toString('utf8'));
      }
      return map;
    };
    const [before, after] = await Promise.all([read(parent), read(oid)]);
    const files: FileDiff[] = [];
    for (const p of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(p);
      const b = after.get(p);
      if (a === b) continue;
      files.push({ path: p, status: a === undefined ? 'added' : b === undefined ? 'deleted' : 'modified', patch: createTwoFilesPatch(`a/${p}`, `b/${p}`, a ?? '', b ?? '', '', '', { context: 3 }) });
    }
    return { commit: { oid, message: c.commit.message, author: { name: c.commit.author.name, email: c.commit.author.email }, timestamp: c.commit.author.timestamp * 1000, aiAuthored: c.commit.author.email.endsWith('@ai.omnix.local') }, files };
  }
}

/** Serialize a notebook as nbformat 4 JSON (outputs summarized). */
export function notebookJson(state: ProjectState, nb: SceneNode<'notebook'>): string {
  const cells = childrenOf(state, nb.id)
    .filter((c): c is SceneNode<'cell'> => c.type === 'cell')
    .map((c) => {
      const lines = c.props.source.split('\n').map((l, i, arr) => (i < arr.length - 1 ? `${l}\n` : l));
      if (c.props.cellType === 'markdown') return { cell_type: 'markdown', metadata: {}, source: lines };
      return {
        cell_type: 'code',
        execution_count: c.props.executionCount || null,
        metadata: { omnix_id: c.id, language: c.props.language },
        source: lines,
        outputs: c.props.outputs.map((o) => {
          switch (o.kind) {
            case 'stdout':
            case 'stderr':
              return { output_type: 'stream', name: o.kind, text: o.text };
            case 'error':
              return { output_type: 'error', ename: o.name, evalue: o.message, traceback: (o.traceback ?? '').split('\n') };
            case 'result':
              return { output_type: 'execute_result', execution_count: c.props.executionCount || null, data: { 'text/plain': o.text }, metadata: {} };
            case 'chart':
              return { output_type: 'display_data', data: { 'application/vnd.omnix.chart+json': o.spec, 'text/plain': `Chart: ${o.spec.title ?? o.spec.type}` }, metadata: {} };
            case 'table':
              return { output_type: 'display_data', data: { 'application/json': { columns: o.columns, rows: o.rows }, 'text/plain': `Table (${o.rows.length} rows)` }, metadata: {} };
            case 'image':
              return { output_type: 'display_data', data: { 'text/plain': `Image asset ${o.assetId}` }, metadata: { omnix_asset: o.assetId } };
          }
        }),
      };
    });
  return JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: nb.props.language, display_name: nb.props.language } }, cells }, null, 1) + '\n';
}
