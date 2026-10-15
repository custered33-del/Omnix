import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { createContext, useContext, useEffect } from 'react';
import { applyCommitMarks, applyOp, newId, type AiMark, type Operation, type ProjectState, type Proposal, type Snapshot, type ToolKind, type Commit, type SceneNode } from '@omnix/core';
import { api, post, ApiError } from '../lib/api.js';
import { realtime } from './realtime.js';
import { toast } from '../ui/toast.js';
import { plural } from '../i18n/index.js';

export interface ProjectMeta {
  id: string;
  name: string;
  primaryTool: ToolKind;
  ownerId: string;
  members: { userId: string; role: 'owner' | 'editor' | 'viewer' }[];
  role: 'owner' | 'editor' | 'viewer';
  aiConsent: boolean;
  archived: boolean;
  updatedAt: string;
  createdAt: string;
  thumbnailVersion: number;
  description?: string;
}

export interface PresenceInfo {
  clientId: string;
  author: { type: 'human' | 'ai' | 'system'; id: string; name: string };
  color: string;
  projectId: string;
  location: { tool: string; nodeId?: string; x?: number; y?: number; time?: number; line?: number; blockId?: string } | null;
  selection: string[];
  updatedAt: number;
}

interface PendingOp {
  clientOpId: string;
  op: Operation;
  label?: string;
  sentAt: number;
}

export interface CodeStream {
  runId: string;
  cellId: string | null;
  text: string;
  stderr: string;
}

export interface ProjectStoreState {
  projectId: string;
  status: 'loading' | 'ready' | 'error' | 'notFound';
  error: string | null;
  meta: ProjectMeta | null;
  /** Server-confirmed state at `head`. */
  confirmed: ProjectState | null;
  head: string | null;
  pending: PendingOp[];
  /** Uncommitted live overrides (dragging, scrubbing sliders). */
  transient: Record<string, Record<string, unknown>>;
  /** What the UI renders: confirmed + pending + transient (or a proposal preview). */
  state: ProjectState | null;
  proposals: Proposal[];
  snapshots: Snapshot[];
  presence: Record<string, PresenceInfo>;
  selection: string[];
  activeDocId: string | null;
  preview: { proposalId: string; state: ProjectState } | null;
  codeStreams: Record<string, CodeStream>;
  /** Monotonic counter bumped on every state change (cheap change detection for canvases). */
  version: number;
  /** Nodes last changed by an AI collaborator (cleared when a person edits them). */
  aiMarks: Record<string, AiMark>;
  /** Where the person is inside the open editor (current slide, playhead), for commands and Claude. */
  editorContext: { slideId: string | null; time: number | null };
  setEditorContext(patch: Partial<ProjectStoreState['editorContext']>): void;
  /** Clicking in an editor pins a comment there instead of editing. */
  commentMode: boolean;
  setCommentMode(on: boolean): void;
  /** A request to show something in its editor (from the comments panel, search or a link). Editors consume it. */
  focusRequest: FocusRequest | null;
  requestFocus(r: Omit<FocusRequest, 'seq' | 'at'>): void;

  load(): Promise<void>;
  commit(op: Operation, label?: string): string | null;
  setTransient(nodeId: string, props: Record<string, unknown>): void;
  clearTransient(nodeId?: string): void;
  /** Turn transient overrides into one committed update. */
  commitTransient(label?: string): void;
  undo(): Promise<void>;
  redo(): Promise<void>;
  select(ids: string[]): void;
  setActiveDoc(id: string): void;
  reportLocation(location: PresenceInfo['location']): void;
  acceptProposal(id: string, ops?: Operation[]): Promise<void>;
  rejectProposal(id: string, reason?: string): Promise<void>;
  previewProposal(id: string | null): Promise<void>;
  checkout(commitId: string | null): Promise<void>;
  snapshot(name: string): Promise<void>;
  updateMeta(patch: Partial<Pick<ProjectMeta, 'name' | 'archived' | 'aiConsent' | 'description'>>): Promise<void>;
  canEdit(): boolean;
  /** Forget a finished code run's streamed output. */
  dropCodeStream(runId: string): void;
  /** Resolve once every local edit has been confirmed by the server (or after a timeout). */
  flushed(timeoutMs?: number): Promise<boolean>;
  dispose(): void;
}

export type ProjectStore = StoreApi<ProjectStoreState>;

export interface FocusRequest {
  /** Increments so the same place can be requested twice. */
  seq: number;
  /** When it was requested (an editor opened much later does not jump). */
  at: number;
  documentId: string;
  nodeId?: string;
  time?: number;
  line?: number;
  commentId?: string;
}

const pendingKey = (projectId: string) => `omnix.pending.${projectId}`;

function savePending(projectId: string, pending: PendingOp[]): void {
  try {
    if (pending.length) localStorage.setItem(pendingKey(projectId), JSON.stringify(pending));
    else localStorage.removeItem(pendingKey(projectId));
  } catch {
    // storage full or unavailable: edits still go to the server
  }
}

function loadPending(projectId: string): PendingOp[] {
  try {
    const raw = localStorage.getItem(pendingKey(projectId));
    return raw ? (JSON.parse(raw) as PendingOp[]) : [];
  } catch {
    return [];
  }
}

/** Apply pending ops and transient overrides to the confirmed state. */
function derive(confirmed: ProjectState | null, pending: PendingOp[], transient: Record<string, Record<string, unknown>>): ProjectState | null {
  if (!confirmed) return null;
  let s = confirmed;
  for (const p of pending) {
    try {
      s = applyOp(s, p.op).state;
    } catch {
      // An op that no longer applies is dropped when the server rejects it.
    }
  }
  const ids = Object.keys(transient);
  if (ids.length) {
    const nodes = { ...s.nodes };
    for (const id of ids) {
      const n = nodes[id];
      if (n) nodes[id] = { ...n, props: { ...(n.props as object), ...transient[id] } } as SceneNode;
    }
    s = { ...s, nodes };
  }
  return s;
}

export function createProjectStore(projectId: string): ProjectStore {
  const unsubs: (() => void)[] = [];
  const store = createStore<ProjectStoreState>((set, get) => {
    const recompute = (patch: Partial<ProjectStoreState>) => {
      const next = { ...get(), ...patch };
      const state = next.preview ? next.preview.state : derive(next.confirmed, next.pending, next.transient);
      set({ ...patch, state, version: get().version + 1 });
    };

    const sendPending = (p: PendingOp) => {
      realtime.send({ type: 'commit', projectId, clientOpId: p.clientOpId, op: p.op, ...(p.label ? { label: p.label } : {}) });
    };

    return {
      projectId,
      status: 'loading',
      error: null,
      meta: null,
      confirmed: null,
      head: null,
      pending: [],
      transient: {},
      state: null,
      proposals: [],
      snapshots: [],
      presence: {},
      selection: [],
      activeDocId: null,
      preview: null,
      codeStreams: {},
      version: 0,
      aiMarks: {},
      editorContext: { slideId: null, time: null },
      commentMode: false,
      focusRequest: null,

      setCommentMode(on) {
        set({ commentMode: on });
      },

      requestFocus(r) {
        const seq = (get().focusRequest?.seq ?? 0) + 1;
        if (get().activeDocId !== r.documentId && get().state?.nodes[r.documentId]) set({ activeDocId: r.documentId, selection: [], editorContext: { slideId: null, time: null } });
        set({ focusRequest: { ...r, seq, at: Date.now() } });
      },

      setEditorContext(patch) {
        const cur = get().editorContext;
        if (Object.entries(patch).every(([k, v]) => cur[k as keyof typeof cur] === v)) return;
        set({ editorContext: { ...cur, ...patch } });
      },

      async load() {
        try {
          const r = await api<{ project: ProjectMeta; state: ProjectState; head: string | null; proposals: Proposal[]; snapshots: Snapshot[]; aiMarks?: Record<string, AiMark> }>(`/api/projects/${projectId}`);
          const recovered = loadPending(projectId).filter((p) => !get().pending.some((q) => q.clientOpId === p.clientOpId));
          const pending = [...get().pending, ...recovered];
          const current = get().activeDocId;
          const docs = r.state.nodes[r.state.rootId]!.children.filter((id) => !['notes', 'comments'].includes(r.state.nodes[id]!.type));
          const activeDocId = current && r.state.nodes[current] ? current : docs[0] ?? null;
          recompute({ status: 'ready', error: null, meta: r.project, confirmed: r.state, head: r.head, proposals: r.proposals, snapshots: r.snapshots, pending, activeDocId, aiMarks: r.aiMarks ?? {} });
          if (recovered.length) {
            toast.info(plural('app.unsavedRecovered', recovered.length));
            for (const p of recovered) sendPending(p);
          }
        } catch (e) {
          if (e instanceof ApiError && (e.status === 404 || e.status === 403)) set({ status: 'notFound', error: e.message });
          else set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
        }
      },

      commit(op, label) {
        const s = get();
        if (!s.confirmed || !s.canEdit()) return null;
        // Validate locally first so the UI never shows an edit that cannot apply.
        try {
          applyOp(s.state!, op);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : String(e));
          return null;
        }
        const p: PendingOp = { clientOpId: newId('op'), op, ...(label ? { label } : {}), sentAt: Date.now() };
        const pending = [...s.pending, p];
        savePending(projectId, pending);
        recompute({ pending });
        sendPending(p);
        return p.clientOpId;
      },

      setTransient(nodeId, props) {
        const transient = { ...get().transient, [nodeId]: { ...(get().transient[nodeId] ?? {}), ...props } };
        recompute({ transient });
      },

      clearTransient(nodeId) {
        if (!nodeId) recompute({ transient: {} });
        else {
          const transient = { ...get().transient };
          delete transient[nodeId];
          recompute({ transient });
        }
      },

      commitTransient(label) {
        const s = get();
        const entries = Object.entries(s.transient);
        if (!entries.length) return;
        const ops: Operation[] = entries.filter(([id]) => s.confirmed?.nodes[id]).map(([id, set]) => ({ kind: 'update', id, set }));
        // Clear transient and add the pending op in one recompute (no flicker).
        const p: PendingOp | null = ops.length ? { clientOpId: newId('op'), op: ops.length === 1 ? ops[0]! : { kind: 'batch', ops }, ...(label ? { label } : {}), sentAt: Date.now() } : null;
        const pending = p ? [...s.pending, p] : s.pending;
        savePending(projectId, pending);
        recompute({ transient: {}, pending });
        if (p) sendPending(p);
      },

      async undo() {
        try {
          const r = await post<{ commit: Commit | null }>(`/api/projects/${projectId}/undo`);
          if (!r.commit) toast.info('Nothing of yours to undo');
        } catch (e) {
          toast.error(e instanceof Error ? e.message : String(e));
        }
      },

      async redo() {
        try {
          const r = await post<{ commit: Commit | null }>(`/api/projects/${projectId}/redo`);
          if (!r.commit) toast.info('Nothing to redo');
        } catch (e) {
          toast.error(e instanceof Error ? e.message : String(e));
        }
      },

      select(ids) {
        set({ selection: ids });
        realtime.send({ type: 'presence', projectId, selection: ids });
      },

      setActiveDoc(id) {
        set({ activeDocId: id, selection: [], editorContext: { slideId: null, time: null } });
      },

      reportLocation(location) {
        realtime.send({ type: 'presence', projectId, location });
      },

      async acceptProposal(id, ops) {
        await post(`/api/projects/${projectId}/proposals/${id}/accept`, ops ? { ops } : {});
        if (get().preview?.proposalId === id) recompute({ preview: null });
      },

      async rejectProposal(id, reason) {
        await post(`/api/projects/${projectId}/proposals/${id}/reject`, reason ? { reason } : {});
        if (get().preview?.proposalId === id) recompute({ preview: null });
      },

      async previewProposal(id) {
        if (!id) {
          recompute({ preview: null });
          return;
        }
        const r = await api<{ state: ProjectState }>(`/api/projects/${projectId}/proposals/${id}/preview`);
        recompute({ preview: { proposalId: id, state: r.state } });
      },

      async checkout(commitId) {
        await post(`/api/projects/${projectId}/checkout`, { commitId });
        await get().load();
      },

      async snapshot(name) {
        const r = await post<{ snapshot: Snapshot }>(`/api/projects/${projectId}/snapshots`, { name });
        set({ snapshots: [...get().snapshots.filter((x) => x.id !== r.snapshot.id), r.snapshot] });
      },

      async updateMeta(patch) {
        const r = await api<{ project: ProjectMeta }>(`/api/projects/${projectId}`, { method: 'PATCH', json: patch });
        set({ meta: { ...get().meta!, ...r.project } });
      },

      canEdit() {
        const m = get().meta;
        return !!m && m.role !== 'viewer' && !get().preview;
      },

      dropCodeStream(runId) {
        if (!get().codeStreams[runId]) return;
        const codeStreams = { ...get().codeStreams };
        delete codeStreams[runId];
        set({ codeStreams });
      },

      flushed(timeoutMs = 8000) {
        if (!get().pending.length) return Promise.resolve(true);
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            unsub();
            resolve(false);
          }, timeoutMs);
          const unsub = store.subscribe((st) => {
            if (st.pending.length) return;
            clearTimeout(timer);
            unsub();
            resolve(true);
          });
        });
      },

      dispose() {
        for (const u of unsubs) u();
        realtime.leave(projectId);
      },
    };
  });

  const s = () => store.getState();
  const recomputeFromOutside = (patch: Partial<ProjectStoreState>) => {
    const next = { ...s(), ...patch };
    store.setState({ ...patch, state: next.preview ? next.preview.state : derive(next.confirmed, next.pending, next.transient), version: s().version + 1 });
  };

  unsubs.push(
    realtime.on('commit', (msg) => {
      if (msg.projectId !== projectId) return;
      const st = s();
      if (!st.confirmed) return;
      if (msg.commit.parentId !== st.head) {
        void st.load();
        return;
      }
      let confirmed = st.confirmed;
      try {
        confirmed = applyOp(confirmed, msg.commit.op).state;
      } catch {
        void st.load();
        return;
      }
      const pending = msg.clientOpId ? st.pending.filter((p) => p.clientOpId !== msg.clientOpId) : st.pending;
      if (pending.length !== st.pending.length) savePending(projectId, pending);
      recomputeFromOutside({ confirmed, head: msg.commit.id, pending, aiMarks: applyCommitMarks(st.aiMarks, msg.commit) });
    }),
    realtime.on('ack', (msg) => {
      const st = s();
      if (!st.pending.some((p) => p.clientOpId === msg.clientOpId)) return;
      // The commit broadcast normally arrives first; if it did not (duplicate send), resync.
      const pending = st.pending.filter((p) => p.clientOpId !== msg.clientOpId);
      savePending(projectId, pending);
      if (msg.duplicate) void st.load();
      recomputeFromOutside({ pending });
    }),
    realtime.on('nack', (msg) => {
      const st = s();
      if (!st.pending.some((p) => p.clientOpId === msg.clientOpId)) return;
      const pending = st.pending.filter((p) => p.clientOpId !== msg.clientOpId);
      savePending(projectId, pending);
      recomputeFromOutside({ pending });
      toast.error(msg.error);
    }),
    realtime.on('checkout', (msg) => {
      if (msg.projectId === projectId) void s().load();
    }),
    realtime.on('proposal', (msg) => {
      if (msg.projectId !== projectId) return;
      const p = msg.proposal as Proposal;
      const proposals = [...s().proposals.filter((x) => x.id !== p.id), ...(p.status === 'open' ? [p] : [])];
      store.setState({ proposals });
    }),
    realtime.on('snapshot', (msg) => {
      if (msg.projectId !== projectId) return;
      store.setState({ snapshots: [...s().snapshots.filter((x) => x.id !== msg.snapshot.id), msg.snapshot] });
    }),
    realtime.on('presence', (msg) => {
      const p = msg.state as PresenceInfo;
      if (p.projectId !== projectId || p.clientId === realtime.clientId) return;
      store.setState({ presence: { ...s().presence, [p.clientId]: p } });
    }),
    realtime.on('presence-leave', (msg) => {
      if (!s().presence[msg.clientId]) return;
      const presence = { ...s().presence };
      delete presence[msg.clientId];
      store.setState({ presence });
    }),
    realtime.on('joined', (msg) => {
      if (msg.projectId !== projectId) return;
      const presence: Record<string, PresenceInfo> = {};
      for (const p of msg.presence as PresenceInfo[]) if (p.clientId !== realtime.clientId) presence[p.clientId] = p;
      store.setState({ presence });
      if (s().confirmed && msg.head !== s().head) void s().load();
    }),
    realtime.on('meta', (msg) => {
      if (msg.projectId === projectId && s().meta) store.setState({ meta: { ...s().meta!, ...msg.meta } });
    }),
    realtime.on('deleted', (msg) => {
      if (msg.projectId === projectId) store.setState({ status: 'notFound', error: 'This project was deleted.' });
    }),
    realtime.on('code', (msg) => {
      if (msg.projectId !== projectId) return;
      const prev = s().codeStreams[msg.runId] ?? { runId: msg.runId, cellId: msg.cellId, text: '', stderr: '' };
      const next = { ...prev, ...(msg.stream === 'stderr' ? { stderr: prev.stderr + msg.text } : { text: prev.text + msg.text }) };
      store.setState({ codeStreams: { ...s().codeStreams, [msg.runId]: next } });
    }),
    realtime.on('reconnected', () => {
      // Catch up after a disconnect; pending edits are re-sent by load().
      if (s().status === 'ready') {
        void s()
          .load()
          .then(() => {
            for (const p of s().pending) realtime.send({ type: 'commit', projectId, clientOpId: p.clientOpId, op: p.op, ...(p.label ? { label: p.label } : {}) });
          });
      }
    }),
  );
  realtime.join(projectId);
  return store;
}

export const ProjectContext = createContext<ProjectStore | null>(null);

export function useProjectStore(): ProjectStore {
  const s = useContext(ProjectContext);
  if (!s) throw new Error('useProject must be used inside a project');
  return s;
}

export function useProject<T>(selector: (s: ProjectStoreState) => T): T {
  return useStore(useProjectStore(), selector);
}

/** A focus request still worth acting on (editors may mount a moment after it is made). */
export function freshFocus(r: FocusRequest | null): r is FocusRequest {
  return !!r && Date.now() - r.at < 10_000;
}

/**
 * Run `fn` when something asks to show a place in this document: on mount (the request
 * may have opened the editor) and on every later request.
 */
export function useFocusRequest(documentId: string, fn: (r: FocusRequest) => void): void {
  const r = useProject((s) => s.focusRequest);
  useEffect(() => {
    if (freshFocus(r) && r.documentId === documentId) fn(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r?.seq, documentId]);
}
