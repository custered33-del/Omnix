import { commentLineOps, type Operation, type SceneNode } from '@omnix/core';
import type { ProjectStore } from './project.js';

/**
 * One committed edit; code edits carry their line comments along with the lines they point at.
 * The edit carries the text it was typed over, so the server merges it with anyone else's.
 */
function commitEdit(store: ProjectStore, nodeId: string, pending: Record<string, unknown>, base: Record<string, string> | undefined, label: string): void {
  const st = store.getState();
  const node = st.state?.nodes[nodeId];
  if (!node) return;
  const typedOver = Object.fromEntries(Object.entries(base ?? {}).filter(([k]) => typeof pending[k] === 'string'));
  const update: Operation = { kind: 'update', id: nodeId, set: pending, ...(Object.keys(typedOver).length ? { base: typedOver } : {}) };
  const follow = node.type === 'codeFile' && typeof pending.content === 'string' ? commentLineOps(st.state!, nodeId, (node as SceneNode<'codeFile'>).props.content, pending.content) : [];
  st.commit(follow.length ? { kind: 'batch', ops: [update, ...follow] } : update, label);
}

/**
 * Debounced text editing: each keystroke shows immediately (as a transient override) and the
 * change is committed after a short pause, so history gets one entry per burst of typing.
 */
export function makeTextCommitter(store: ProjectStore, delay = 700) {
  const timers = new Map<string, number>();
  const labels = new Map<string, string>();
  /** Commit what was typed in one node, taking it out of the live overrides. */
  const commitNode = (nodeId: string) => {
    const st = store.getState();
    const pending = st.transient[nodeId];
    if (!pending) return;
    const base = st.transientBase[nodeId];
    st.clearTransient(nodeId);
    commitEdit(store, nodeId, pending, base, labels.get(nodeId) ?? 'Edit text');
  };
  const committer = {
    edit(nodeId: string, prop: string, value: unknown, label: string) {
      const s = store.getState();
      s.setTransient(nodeId, { [prop]: value }, { text: true });
      labels.set(nodeId, label);
      const prev = timers.get(nodeId);
      if (prev) window.clearTimeout(prev);
      timers.set(
        nodeId,
        window.setTimeout(() => {
          timers.delete(nodeId);
          commitNode(nodeId);
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
      commitNode(nodeId);
    },
    /** Drop one node's pending typing (its changes are being folded into another edit). */
    discard(nodeId: string) {
      const timer = timers.get(nodeId);
      if (timer !== undefined) window.clearTimeout(timer);
      timers.delete(nodeId);
      store.getState().clearTransient(nodeId);
    },
    flushAll() {
      for (const id of [...timers.keys()]) committer.flush(id);
    },
    /**
     * While the editor is open, undo, leaving the page and the like commit held-back typing
     * first. Returns the cleanup for when the editor closes, which commits what is left.
     */
    attach() {
      const off = store.getState().registerFlusher(() => committer.flushAll());
      return () => {
        committer.flushAll();
        off();
      };
    },
  };
  return committer;
}
