import type { CellOutput } from '@omnix/core';
import { post } from '../../lib/api.js';
import type { ProjectStore } from '../../state/project.js';

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

/**
 * Debounced text editing: each keystroke shows immediately (as a transient override) and the
 * change is committed after a short pause, so history gets one entry per burst of typing.
 */
export function makeTextCommitter(store: ProjectStore, delay = 700) {
  const timers = new Map<string, number>();
  return {
    edit(nodeId: string, prop: string, value: string, label: string) {
      const s = store.getState();
      s.setTransient(nodeId, { [prop]: value });
      const prev = timers.get(nodeId);
      if (prev) window.clearTimeout(prev);
      timers.set(
        nodeId,
        window.setTimeout(() => {
          timers.delete(nodeId);
          const st = store.getState();
          const pending = st.transient[nodeId];
          if (!pending) return;
          st.clearTransient(nodeId);
          if (st.state?.nodes[nodeId]) st.commit({ kind: 'update', id: nodeId, set: pending }, label);
        }, delay),
      );
    },
    flushAll() {
      for (const [id, timer] of timers) {
        window.clearTimeout(timer);
        timers.delete(id);
        const st = store.getState();
        const pending = st.transient[id];
        if (!pending) continue;
        st.clearTransient(id);
        if (st.state?.nodes[id]) st.commit({ kind: 'update', id, set: pending }, 'Edit code');
      }
    },
  };
}
