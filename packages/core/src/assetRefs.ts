import type { Operation } from './ops.js';
import type { ProjectState } from './state.js';

/** Asset ids are SHA-256 content hashes. */
export const ASSET_ID = /^[0-9a-f]{64}$/;

function visit(value: unknown, fn: (s: string) => void): void {
  if (typeof value === 'string') {
    if (value.length === 64 && ASSET_ID.test(value)) fn(value);
  } else if (Array.isArray(value)) for (const v of value) visit(v, fn);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) visit(v, fn);
}

/** Every asset id that appears anywhere in a value (a state, an operation, a proposal). */
export function assetIdsIn(value: unknown, into = new Set<string>()): Set<string> {
  visit(value, (id) => into.add(id));
  return into;
}

/** Every asset a project uses, with the nodes that use it (layers, clips, slide elements, LUTs, masks, embeds...). */
export function assetRefs(state: ProjectState): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const n of Object.values(state.nodes)) {
    visit(n.props, (id) => {
      const list = out.get(id);
      if (!list) out.set(id, [n.id]);
      else if (list[list.length - 1] !== n.id) list.push(n.id);
    });
  }
  return out;
}

function replaceDeep(value: unknown, from: string, to: string): unknown {
  if (value === from) return to;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => {
      const r = replaceDeep(v, from, to);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? next : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = replaceDeep(v, from, to);
      if (r !== v) changed = true;
      next[k] = r;
    }
    return changed ? next : value;
  }
  return value;
}

/** Operations that point every use of asset `from` at asset `to` instead. */
export function replaceAssetOps(state: ProjectState, from: string, to: string): Operation[] {
  const ops: Operation[] = [];
  for (const id of assetRefs(state).get(from) ?? []) {
    const n = state.nodes[id]!;
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n.props as Record<string, unknown>)) {
      const r = replaceDeep(v, from, to);
      if (r !== v) set[k] = r;
    }
    if (Object.keys(set).length) ops.push({ kind: 'update', id, set });
  }
  return ops;
}
