import type { ProjectStore } from './project.js';

/**
 * Debounced text editing: each keystroke shows immediately (as a transient override) and the
 * change is committed after a short pause, so history gets one entry per burst of typing.
 */
export function makeTextCommitter(store: ProjectStore, delay = 700) {
  const timers = new Map<string, number>();
  const labels = new Map<string, string>();
  return {
    edit(nodeId: string, prop: string, value: unknown, label: string) {
      const s = store.getState();
      s.setTransient(nodeId, { [prop]: value });
      labels.set(nodeId, label);
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
    /** Whether typing in this node is still waiting to be committed. */
    isPending(nodeId: string) {
      return timers.has(nodeId);
    },
    /** Commit one node's pending typing now (before a structural edit such as splitting a block). */
    flush(nodeId: string) {
      const timer = timers.get(nodeId);
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timers.delete(nodeId);
      const st = store.getState();
      const pending = st.transient[nodeId];
      if (!pending) return;
      st.clearTransient(nodeId);
      if (st.state?.nodes[nodeId]) st.commit({ kind: 'update', id: nodeId, set: pending }, labels.get(nodeId) ?? 'Edit text');
    },
    /** Drop one node's pending typing (its changes are being folded into another edit). */
    discard(nodeId: string) {
      const timer = timers.get(nodeId);
      if (timer !== undefined) window.clearTimeout(timer);
      timers.delete(nodeId);
      store.getState().clearTransient(nodeId);
    },
    flushAll() {
      for (const id of [...timers.keys()]) this.flush(id);
    },
  };
}
