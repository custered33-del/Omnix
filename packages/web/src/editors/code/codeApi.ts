import type { CellOutput } from '@omnix/core';
import { post } from '../../lib/api.js';
import type { ProjectStore } from '../../state/project.js';
import type { makeTextCommitter } from '../../state/textCommitter.js';

export interface RunResult {
  ok: boolean;
  outputs: CellOutput[];
  ms: number;
  runId: string;
  commitId?: string;
}

export interface CodeCtx {
  store: ProjectStore;
  workspaceId: string;
  text: ReturnType<typeof makeTextCommitter>;
}

/** Commit any typing that is still being debounced, then wait for the server to have it. */
export async function syncEdits(ctx: CodeCtx): Promise<void> {
  ctx.text.flushAll();
  await ctx.store.getState().flushed();
}

export async function runTarget(ctx: CodeCtx, target: { cellId?: string; fileId?: string; notebookId?: string; source?: string; language?: 'python' | 'javascript' | 'typescript' }): Promise<RunResult | { results: RunResult[] }> {
  await syncEdits(ctx);
  return post(`/api/projects/${ctx.store.getState().projectId}/code/run`, { workspaceId: ctx.workspaceId, ...target });
}

export async function restartKernel(ctx: CodeCtx): Promise<void> {
  await post(`/api/projects/${ctx.store.getState().projectId}/code/restart`, { workspaceId: ctx.workspaceId });
}

export { makeTextCommitter } from '../../state/textCommitter.js';
