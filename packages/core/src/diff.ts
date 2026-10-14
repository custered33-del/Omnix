import type { NodeType, SceneNode } from './nodes.js';
import type { ProjectState } from './state.js';

export interface NodeRef {
  id: string;
  type: NodeType;
  name: string;
}

export interface NodeChange extends NodeRef {
  /** Prop keys whose values differ. */
  props: string[];
  /** Before and after values for each changed prop (deep-cloned, safe to display). */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  moved: boolean;
  reordered: boolean;
}

export interface StateDiff {
  added: NodeRef[];
  removed: NodeRef[];
  changed: NodeChange[];
  /** True when nothing differs. */
  empty: boolean;
}

export function nodeLabel(n: SceneNode): string {
  const p = n.props as Record<string, unknown>;
  for (const k of ['name', 'path', 'text', 'source']) {
    const v = p[k];
    if (typeof v === 'string' && v.trim()) return v.length > 48 ? v.slice(0, 45) + '...' : v;
  }
  return n.type;
}

function ref(n: SceneNode): NodeRef {
  return { id: n.id, type: n.type, name: nodeLabel(n) };
}

/** Structural equality for JSON-like values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

/** Node-level structural diff between two states of the same project. */
export function diffStates(a: ProjectState, b: ProjectState): StateDiff {
  const added: NodeRef[] = [];
  const removed: NodeRef[] = [];
  const changed: NodeChange[] = [];
  for (const [id, nb] of Object.entries(b.nodes)) {
    const na = a.nodes[id];
    if (!na) {
      added.push(ref(nb));
      continue;
    }
    if (na === nb) continue;
    const pa = na.props as Record<string, unknown>;
    const pb = nb.props as Record<string, unknown>;
    const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
    const props: string[] = [];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of keys) {
      if (!deepEqual(pa[k], pb[k])) {
        props.push(k);
        before[k] = pa[k] === undefined ? undefined : structuredClone(pa[k]);
        after[k] = pb[k] === undefined ? undefined : structuredClone(pb[k]);
      }
    }
    const moved = na.parentId !== nb.parentId;
    let reordered = false;
    if (!moved && na.parentId) {
      const parentA = a.nodes[na.parentId];
      const parentB = b.nodes[nb.parentId!];
      if (parentA && parentB) reordered = parentA.children.indexOf(id) !== parentB.children.indexOf(id);
    }
    if (props.length || moved || reordered) changed.push({ ...ref(nb), props, before, after, moved, reordered });
  }
  for (const [id, na] of Object.entries(a.nodes)) if (!b.nodes[id]) removed.push(ref(na));
  return { added, removed, changed, empty: !added.length && !removed.length && !changed.length };
}

/** One-line summary of a diff, e.g. "2 added, 1 removed, 3 changed". */
export function summarizeDiff(d: StateDiff): string {
  if (d.empty) return 'No changes';
  const parts: string[] = [];
  if (d.added.length) parts.push(`${d.added.length} added`);
  if (d.removed.length) parts.push(`${d.removed.length} removed`);
  if (d.changed.length) parts.push(`${d.changed.length} changed`);
  return parts.join(', ');
}
