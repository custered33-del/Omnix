import { ALLOWED_CHILDREN, type NodeType, type SceneNode } from './nodes.js';
import { GraphError, type ProjectState } from './state.js';
import { mergeText } from './textDiff.js';

/**
 * Operations are the only way state changes in Omnix. Human edits, AI edits,
 * undo, redo, collaboration and proposals all produce operations, and every
 * operation has an exact inverse so any change can be reversed.
 */
export type Operation =
  | CreateOp
  | DeleteOp
  | UpdateOp
  | MoveOp
  | ListInsertOp
  | ListRemoveOp
  | ListUpdateOp
  | BatchOp;

/** Insert a subtree. `nodes[0]` is the subtree root; the rest are its descendants with intact child lists. */
export interface CreateOp {
  kind: 'create';
  parentId: string;
  index?: number;
  nodes: SceneNode[];
}

export interface DeleteOp {
  kind: 'delete';
  id: string;
}

/** Shallow-merge props. Keys in `unset` are removed. */
export interface UpdateOp {
  kind: 'update';
  id: string;
  set: Record<string, unknown>;
  unset?: string[];
  /**
   * The text values `set` was written over. When a text prop has changed since (someone else
   * typed in it), the two edits are merged instead of the later one replacing the other.
   */
  base?: Record<string, string>;
}

export interface MoveOp {
  kind: 'move';
  id: string;
  parentId: string;
  index?: number;
}

/** Insert items into an array-valued prop (strokes, keyframes, frames, outputs...). */
export interface ListInsertOp {
  kind: 'listInsert';
  id: string;
  prop: string;
  index?: number;
  items: unknown[];
}

export interface ListRemoveOp {
  kind: 'listRemove';
  id: string;
  prop: string;
  index: number;
  count: number;
  /**
   * The items meant, so a removal never takes whatever happens to sit at `index` now: an undo after
   * collaborators changed the list, or a proposal accepted later. Items with an `id` are named by
   * it, others by their exact content. If they moved, they are found; if they are gone, it fails.
   */
  expect?: unknown[];
}

/** Shallow-merge into one item of an array-valued prop, located by its `id` field. */
export interface ListUpdateOp {
  kind: 'listUpdate';
  id: string;
  prop: string;
  itemId: string;
  set: Record<string, unknown>;
  /** Fields to remove from the item (how an update that added a field is undone). */
  unset?: string[];
}

/** An atomic group of operations. Either all apply or none do. */
export interface BatchOp {
  kind: 'batch';
  ops: Operation[];
}

export class OpError extends GraphError {
  constructor(message: string) {
    super(message);
    this.name = 'OpError';
  }
}

export interface ApplyResult {
  state: ProjectState;
  inverse: Operation;
}

/** Apply an operation, returning the new state and the operation that exactly reverses it. */
export function applyOp(state: ProjectState, op: Operation): ApplyResult {
  const draft = new Draft(state);
  const inverse = applyInto(draft, op);
  return { state: draft.finish(), inverse };
}

/** Apply a sequence of operations atomically. */
export function applyOps(state: ProjectState, ops: Operation[]): ApplyResult {
  return applyOp(state, { kind: 'batch', ops });
}

/** Check whether an operation would apply cleanly without committing it. */
export function canApply(state: ProjectState, op: Operation): { ok: true } | { ok: false; error: string } {
  try {
    applyOp(state, op);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Copy-on-write working copy. Nodes are cloned the first time they are touched,
 * so untouched nodes are shared structurally with the previous state.
 */
class Draft {
  nodes: Record<string, SceneNode>;
  private touched = new Set<string>();
  constructor(private base: ProjectState) {
    this.nodes = { ...base.nodes };
  }
  get(id: string): SceneNode | undefined {
    return this.nodes[id];
  }
  require(id: string): SceneNode {
    const n = this.nodes[id];
    if (!n) throw new OpError(`Node not found: ${id}`);
    return n;
  }
  /** A mutable clone of the node (cloned once per draft). */
  mut(id: string): SceneNode {
    const n = this.require(id);
    if (!this.touched.has(id)) {
      const copy: SceneNode = { ...n, children: [...n.children], props: { ...(n.props as object) } as SceneNode['props'] };
      this.nodes[id] = copy;
      this.touched.add(id);
      return copy;
    }
    return n;
  }
  put(node: SceneNode): void {
    this.nodes[node.id] = node;
    this.touched.add(node.id);
  }
  remove(id: string): void {
    delete this.nodes[id];
    this.touched.delete(id);
  }
  finish(): ProjectState {
    return { id: this.base.id, rootId: this.base.rootId, nodes: this.nodes };
  }
  get rootId(): string {
    return this.base.rootId;
  }
}

function assertChildAllowed(parent: SceneNode, childType: NodeType): void {
  const allowed = ALLOWED_CHILDREN[parent.type];
  if (!allowed.includes(childType)) {
    throw new OpError(`A ${childType} cannot be placed inside a ${parent.type}`);
  }
}

function clampIndex(index: number | undefined, length: number): number {
  if (index === undefined || index < 0 || index > length) return length;
  return Math.floor(index);
}

function applyInto(d: Draft, op: Operation): Operation {
  switch (op.kind) {
    case 'create':
      return applyCreate(d, op);
    case 'delete':
      return applyDelete(d, op);
    case 'update':
      return applyUpdate(d, op);
    case 'move':
      return applyMove(d, op);
    case 'listInsert':
      return applyListInsert(d, op);
    case 'listRemove':
      return applyListRemove(d, op);
    case 'listUpdate':
      return applyListUpdate(d, op);
    case 'batch': {
      const inverses: Operation[] = [];
      for (const sub of op.ops) inverses.push(applyInto(d, sub));
      return { kind: 'batch', ops: inverses.reverse() };
    }
    default: {
      const k = (op as { kind?: unknown }).kind;
      throw new OpError(`Unknown operation kind: ${String(k)}`);
    }
  }
}

function applyCreate(d: Draft, op: CreateOp): Operation {
  if (!op.nodes || op.nodes.length === 0) throw new OpError('create requires at least one node');
  const parent = d.require(op.parentId);
  const root = op.nodes[0]!;
  assertChildAllowed(parent, root.type);
  const incoming = new Map(op.nodes.map((n) => [n.id, n]));
  if (incoming.size !== op.nodes.length) throw new OpError('create contains duplicate node ids');
  for (const n of op.nodes) {
    if (d.get(n.id)) throw new OpError(`Node id already exists: ${n.id}`);
    if (typeof n.id !== 'string' || !n.id) throw new OpError('Node ids must be non-empty strings');
    if (!(n.type in ALLOWED_CHILDREN)) throw new OpError(`Unknown node type: ${String(n.type)}`);
  }
  // Validate the subtree is self-consistent: every non-root node's parent is in the subtree and lists it.
  for (const n of op.nodes.slice(1)) {
    const p = n.parentId ? incoming.get(n.parentId) : undefined;
    if (!p || !p.children.includes(n.id)) throw new OpError(`Subtree node ${n.id} is not linked to a parent inside the subtree`);
    assertChildAllowed(p, n.type);
  }
  // It must be a real tree: from the root, every node is reached exactly once, by way of the parent
  // it names. A loop or a node listed twice would later make deleting it fail for good.
  const seen = new Set<string>();
  const walk = (id: string, parentId: string | null) => {
    if (seen.has(id)) throw new OpError(`Subtree node ${id} appears more than once`);
    seen.add(id);
    const n = incoming.get(id);
    if (!n) throw new OpError(`Subtree references missing child ${id}`);
    if (parentId !== null && n.parentId !== parentId) throw new OpError(`Subtree node ${id} names ${String(n.parentId)} as its parent, but is a child of ${parentId}`);
    for (const c of n.children) walk(c, id);
  };
  walk(root.id, null);
  if (seen.size !== op.nodes.length) throw new OpError('Subtree has nodes that are not reachable from its root');
  for (const n of op.nodes) {
    for (const c of n.children) if (!incoming.has(c)) throw new OpError(`Subtree node ${n.id} references missing child ${c}`);
    const copy: SceneNode = {
      id: n.id,
      type: n.type,
      parentId: n === root ? op.parentId : n.parentId,
      children: [...n.children],
      props: structuredClone(n.props),
    };
    d.put(copy);
  }
  const p = d.mut(op.parentId);
  const idx = clampIndex(op.index, p.children.length);
  p.children.splice(idx, 0, root.id);
  return { kind: 'delete', id: root.id };
}

function collectSubtree(d: Draft, id: string): SceneNode[] {
  const out: SceneNode[] = [];
  const visit = (nid: string) => {
    const n = d.require(nid);
    out.push(n);
    for (const c of n.children) visit(c);
  };
  visit(id);
  return out;
}

function applyDelete(d: Draft, op: DeleteOp): Operation {
  if (op.id === d.rootId) throw new OpError('The project root cannot be deleted');
  const node = d.require(op.id);
  if (!node.parentId) throw new OpError(`Node ${op.id} has no parent`);
  const subtree = collectSubtree(d, op.id).map((n) => ({ ...n, children: [...n.children], props: structuredClone(n.props) }));
  const parent = d.mut(node.parentId);
  const index = parent.children.indexOf(op.id);
  if (index >= 0) parent.children.splice(index, 1);
  for (const n of subtree) d.remove(n.id);
  return { kind: 'create', parentId: node.parentId, index, nodes: subtree };
}

function applyUpdate(d: Draft, op: UpdateOp): Operation {
  const node = d.mut(op.id);
  const props = node.props as unknown as Record<string, unknown>;
  const prevSet: Record<string, unknown> = {};
  const prevUnset: string[] = [];
  const record = (k: string) => {
    if (k in prevSet || prevUnset.includes(k)) return;
    if (Object.prototype.hasOwnProperty.call(props, k)) prevSet[k] = props[k];
    else prevUnset.push(k);
  };
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(op.set ?? {})) {
    if (k === '__proto__' || k === 'constructor') throw new OpError(`Illegal prop name: ${k}`);
    record(k);
    const was = op.base?.[k];
    const cur = props[k];
    if (typeof was === 'string' && typeof v === 'string' && typeof cur === 'string' && cur !== was) props[k] = mergeText(was, v, cur);
    else props[k] = v === undefined ? v : structuredClone(v);
    if (typeof props[k] === 'string' && typeof prevSet[k] === 'string') merged[k] = props[k] as string;
  }
  for (const k of op.unset ?? []) {
    record(k);
    delete props[k];
  }
  const inv: UpdateOp = { kind: 'update', id: op.id, set: prevSet };
  if (prevUnset.length) inv.unset = prevUnset;
  // Undoing typing later merges too, so it takes back only this edit's characters.
  if (op.base && Object.keys(merged).length) inv.base = merged;
  return inv;
}

function applyMove(d: Draft, op: MoveOp): Operation {
  if (op.id === d.rootId) throw new OpError('The project root cannot be moved');
  const node = d.require(op.id);
  const newParent = d.require(op.parentId);
  assertChildAllowed(newParent, node.type);
  // Prevent cycles: the new parent may not be inside the moved subtree.
  let cur: SceneNode | undefined = newParent;
  while (cur) {
    if (cur.id === op.id) throw new OpError('Cannot move a node inside itself');
    cur = cur.parentId ? d.get(cur.parentId) : undefined;
  }
  const oldParentId = node.parentId!;
  const oldParent = d.mut(oldParentId);
  const oldIndex = oldParent.children.indexOf(op.id);
  oldParent.children.splice(oldIndex, 1);
  const target = d.mut(op.parentId);
  const idx = clampIndex(op.index, target.children.length);
  target.children.splice(idx, 0, op.id);
  const moved = d.mut(op.id);
  moved.parentId = op.parentId;
  return { kind: 'move', id: op.id, parentId: oldParentId, index: oldIndex };
}

function listProp(d: Draft, id: string, prop: string): unknown[] {
  const node = d.mut(id);
  const props = node.props as unknown as Record<string, unknown>;
  const cur = props[prop];
  if (cur === undefined || cur === null) {
    props[prop] = [];
  } else if (!Array.isArray(cur)) {
    throw new OpError(`Prop ${prop} on ${id} is not a list`);
  } else {
    props[prop] = [...cur];
  }
  return props[prop] as unknown[];
}

function applyListInsert(d: Draft, op: ListInsertOp): Operation {
  const list = listProp(d, op.id, op.prop);
  const idx = clampIndex(op.index, list.length);
  const items = structuredClone(op.items);
  list.splice(idx, 0, ...items);
  // Items with an id are recognised by it alone, so undo does not keep a second copy of, say, a long brush stroke.
  const expect = items.map((x) => (x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string' ? { id: (x as { id: string }).id } : structuredClone(x)));
  return { kind: 'listRemove', id: op.id, prop: op.prop, index: idx, count: op.items.length, expect };
}

/** How a list item is recognised: its id when it has one, otherwise its content. */
function itemKey(x: unknown): string {
  const id = x && typeof x === 'object' ? (x as { id?: unknown }).id : undefined;
  return typeof id === 'string' ? `id:${id}` : `json:${JSON.stringify(x)}`;
}

function applyListRemove(d: Draft, op: ListRemoveOp): Operation {
  const list = listProp(d, op.id, op.prop);
  let index = op.index;
  if (op.expect) {
    if (op.expect.length !== op.count) throw new OpError(`listRemove on ${op.id}.${op.prop}: expect must list ${op.count} item(s)`);
    const want = op.expect.map(itemKey);
    const at = (i: number) => want.every((k, j) => i + j < list.length && itemKey(list[i + j]) === k);
    if (!at(index)) {
      // The items moved (others were added or removed around them): find them where they are now.
      const found = list.findIndex((_, i) => at(i));
      if (found < 0) throw new OpError(`The items to remove from ${op.id}.${op.prop} are no longer there`);
      index = found;
    }
  } else if (index < 0 || index + op.count > list.length) {
    throw new OpError(`listRemove out of range on ${op.id}.${op.prop}`);
  }
  const removed = list.splice(index, op.count);
  return { kind: 'listInsert', id: op.id, prop: op.prop, index, items: removed };
}

function applyListUpdate(d: Draft, op: ListUpdateOp): Operation {
  const list = listProp(d, op.id, op.prop);
  const i = list.findIndex((x) => !!x && typeof x === 'object' && (x as { id?: unknown }).id === op.itemId);
  if (i < 0) throw new OpError(`Item ${op.itemId} not found in ${op.id}.${op.prop}`);
  const item = { ...(list[i] as Record<string, unknown>) };
  const prev: Record<string, unknown> = {};
  const added: string[] = [];
  const remember = (k: string) => {
    if (k in prev || added.includes(k)) return;
    if (Object.prototype.hasOwnProperty.call(item, k)) prev[k] = item[k];
    else added.push(k);
  };
  for (const [k, v] of Object.entries(op.set)) {
    if (k === '__proto__' || k === 'constructor') throw new OpError(`Illegal prop name: ${k}`);
    remember(k);
    item[k] = structuredClone(v);
  }
  for (const k of op.unset ?? []) {
    remember(k);
    delete item[k];
  }
  list[i] = item;
  // A field the update added is removed on undo; "set it to undefined" would not survive saving.
  return { kind: 'listUpdate', id: op.id, prop: op.prop, itemId: op.itemId, set: prev, ...(added.length ? { unset: added } : {}) };
}

/** Node ids an operation touches (for conflict detection, activity feeds and highlighting). */
export function touchedIds(op: Operation): string[] {
  const out = new Set<string>();
  const visit = (o: Operation) => {
    switch (o.kind) {
      case 'create':
        out.add(o.parentId);
        for (const n of o.nodes) out.add(n.id);
        break;
      case 'move':
        out.add(o.id);
        out.add(o.parentId);
        break;
      case 'batch':
        o.ops.forEach(visit);
        break;
      default:
        out.add(o.id);
    }
  };
  visit(op);
  return [...out];
}

/** Count leaf operations (a batch counts its children). */
export function opCount(op: Operation): number {
  return op.kind === 'batch' ? op.ops.reduce((a, o) => a + opCount(o), 0) : 1;
}

/** A short, human readable description of an operation, for history and activity feeds. */
export function describeOp(op: Operation, state?: ProjectState): string {
  const name = (id: string) => {
    const n = state?.nodes[id];
    const nm = n && (n.props as { name?: unknown }).name;
    return typeof nm === 'string' ? `"${nm}"` : n ? n.type : id;
  };
  switch (op.kind) {
    case 'create': {
      const root = op.nodes[0];
      const nm = root && (root.props as { name?: unknown }).name;
      return `Add ${root?.type ?? 'node'}${typeof nm === 'string' ? ` "${nm}"` : ''}`;
    }
    case 'delete':
      return `Delete ${name(op.id)}`;
    case 'update':
      return `Change ${Object.keys(op.set).concat(op.unset ?? []).join(', ')} on ${name(op.id)}`;
    case 'move':
      return `Move ${name(op.id)}`;
    case 'listInsert':
      return `Add ${op.items.length} ${op.prop} to ${name(op.id)}`;
    case 'listRemove':
      return `Remove ${op.count} ${op.prop} from ${name(op.id)}`;
    case 'listUpdate':
      return `Edit ${op.prop} item on ${name(op.id)}`;
    case 'batch':
      return op.ops.length === 1 ? describeOp(op.ops[0]!, state) : `${op.ops.length} changes`;
  }
}
