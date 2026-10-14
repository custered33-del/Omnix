import type { AnyNode, NodePropsMap, NodeType, SceneNode, LayerType, LayerProps } from './nodes.js';
import type { ToolKind } from './types.js';
import { makeNode } from './defaults.js';
import { newId } from './ids.js';

/** An immutable snapshot of a project's scene graph. Never mutate; operations return new states. */
export interface ProjectState {
  /** Project id (equals the root node id). */
  id: string;
  rootId: string;
  nodes: Readonly<Record<string, SceneNode>>;
}

export class GraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphError';
  }
}

/** Create a new project with the session-memory and comment containers and one document for the primary tool. */
export function createProjectState(
  options: { name?: string; primaryTool?: ToolKind; aiConsent?: boolean; id?: string; withPrimaryDocument?: boolean } = {},
): ProjectState {
  const { name = 'Untitled project', primaryTool = 'image', aiConsent = false, withPrimaryDocument = true } = options;
  const root = makeNode('project', { name, primaryTool, aiConsent }, options.id ?? newId('prj'));
  const notes = makeNode('notes');
  const comments = makeNode('comments');
  notes.parentId = root.id;
  comments.parentId = root.id;
  root.children = [notes.id, comments.id];
  const nodes: Record<string, SceneNode> = { [root.id]: root, [notes.id]: notes, [comments.id]: comments };
  if (withPrimaryDocument) {
    for (const n of primaryDocumentNodes(primaryTool, name)) {
      if (n.parentId === null) {
        n.parentId = root.id;
        root.children.push(n.id);
      }
      nodes[n.id] = n;
    }
  }
  return { id: root.id, rootId: root.id, nodes };
}

/** Starter nodes for a fresh document of each tool type. The first node is the subtree root. */
export function primaryDocumentNodes(tool: ToolKind, name: string): SceneNode[] {
  switch (tool) {
    case 'image': {
      const canvas = makeNode('canvas', { name });
      const bg = makeNode('layer', { name: 'Background', layerType: 'fill', fillColor: '#ffffff' });
      link(canvas, bg);
      return [canvas, bg];
    }
    case 'video': {
      const seq = makeNode('sequence', { name, purpose: 'video' });
      const v1 = makeNode('track', { name: 'Video 1', trackType: 'video' });
      const t1 = makeNode('track', { name: 'Titles', trackType: 'title' });
      const a1 = makeNode('track', { name: 'Audio 1', trackType: 'audio' });
      link(seq, t1, v1, a1);
      return [seq, t1, v1, a1];
    }
    case 'animation': {
      const seq = makeNode('sequence', {
        name,
        purpose: 'animation',
        width: 1280,
        height: 720,
        fps: 24,
        duration: 4,
        background: '#ffffff',
        playback: 'loop',
      });
      const track = makeNode('track', { name: 'Animation', trackType: 'animation' });
      const layer = makeNode('animLayer', { name: 'Layer 1', start: 0, duration: 4 });
      link(seq, track);
      link(track, layer);
      return [seq, track, layer];
    }
    case 'code': {
      const ws = makeNode('codeWorkspace', { name, entry: 'main.py' });
      const file = makeNode('codeFile', {
        path: 'main.py',
        language: 'python',
        content: '# Welcome to Code Grounds\nprint("Hello from Omnix")\n',
      });
      const nb = makeNode('notebook', { name: 'Notebook', language: 'python' });
      const cell = makeNode('cell', { language: 'python', source: 'total = sum(range(10))\ntotal' });
      link(ws, file, nb);
      link(nb, cell);
      return [ws, file, nb, cell];
    }
    case 'document': {
      const doc = makeNode('document', { name });
      const title = makeNode('block', { blockType: 'heading', level: 1, text: name });
      const p = makeNode('block', { blockType: 'paragraph', text: '' });
      link(doc, title, p);
      return [doc, title, p];
    }
    case 'slides': {
      const deck = makeNode('deck', { name });
      const slide = makeNode('slide', { name: 'Title', layout: 'title', masterId: 'master-title' });
      const title = makeNode('slideElement', {
        elementType: 'text',
        role: 'title',
        text: name,
        x: 154,
        y: 367,
        w: 1612,
        h: 194,
        fontSize: 72,
        bold: true,
        align: 'left',
      });
      const subtitle = makeNode('slideElement', {
        elementType: 'text',
        role: 'subtitle',
        text: 'Subtitle',
        x: 154,
        y: 583,
        w: 1612,
        h: 108,
        fontSize: 32,
        align: 'left',
      });
      link(deck, slide);
      link(slide, title, subtitle);
      return [deck, slide, title, subtitle];
    }
  }
}

function link(parent: SceneNode, ...children: SceneNode[]): void {
  for (const c of children) {
    c.parentId = parent.id;
    parent.children.push(c.id);
  }
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

export function getNode(state: ProjectState, id: string): SceneNode | undefined {
  return state.nodes[id];
}

export function requireNode(state: ProjectState, id: string): SceneNode {
  const n = state.nodes[id];
  if (!n) throw new GraphError(`Node not found: ${id}`);
  return n;
}

export function requireNodeOfType<T extends NodeType>(state: ProjectState, id: string, type: T | readonly T[]): SceneNode<T> {
  const n = requireNode(state, id);
  const types = (Array.isArray(type) ? type : [type]) as readonly NodeType[];
  if (!types.includes(n.type)) throw new GraphError(`Node ${id} is a ${n.type}, expected ${types.join(' or ')}`);
  return n as SceneNode<T>;
}

export function isType<T extends NodeType>(node: SceneNode | undefined, type: T): node is SceneNode<T> {
  return !!node && node.type === type;
}

export function rootNode(state: ProjectState): SceneNode<'project'> {
  return state.nodes[state.rootId] as SceneNode<'project'>;
}

export function childrenOf(state: ProjectState, id: string): SceneNode[] {
  const n = state.nodes[id];
  if (!n) return [];
  return n.children.map((c) => state.nodes[c]).filter((c): c is SceneNode => !!c);
}

export function childrenOfType<T extends NodeType>(state: ProjectState, id: string, type: T): SceneNode<T>[] {
  return childrenOf(state, id).filter((c): c is SceneNode<T> => c.type === type);
}

/** All nodes of a type, in tree (document) order. */
export function nodesOfType<T extends NodeType>(state: ProjectState, type: T): SceneNode<T>[] {
  const out: SceneNode<T>[] = [];
  walk(state, state.rootId, (n) => {
    if (n.type === type) out.push(n as SceneNode<T>);
  });
  return out;
}

/** Depth-first pre-order traversal. Return false from the visitor to skip a subtree. */
export function walk(state: ProjectState, id: string, visit: (node: SceneNode, depth: number) => void | boolean, depth = 0): void {
  const n = state.nodes[id];
  if (!n) return;
  if (visit(n, depth) === false) return;
  for (const c of n.children) walk(state, c, visit, depth + 1);
}

/** The node ids of a subtree (root first, pre-order). */
export function subtreeIds(state: ProjectState, id: string): string[] {
  const ids: string[] = [];
  walk(state, id, (n) => {
    ids.push(n.id);
  });
  return ids;
}

export function ancestors(state: ProjectState, id: string): SceneNode[] {
  const out: SceneNode[] = [];
  let cur = state.nodes[id];
  let guard = 0;
  while (cur && cur.parentId && guard++ < 10000) {
    const p = state.nodes[cur.parentId];
    if (!p) break;
    out.push(p);
    cur = p;
  }
  return out;
}

/** Find the nearest ancestor (or self) of a given type. */
export function closest<T extends NodeType>(state: ProjectState, id: string, type: T): SceneNode<T> | undefined {
  const self = state.nodes[id];
  if (self?.type === type) return self as SceneNode<T>;
  return ancestors(state, id).find((a): a is SceneNode<T> => a.type === type);
}

/** The tool a node belongs to, based on its top-level document. */
export function toolOfNode(state: ProjectState, id: string): ToolKind | null {
  const chain = [state.nodes[id], ...ancestors(state, id)].filter(Boolean) as SceneNode[];
  for (const n of chain) {
    switch (n.type) {
      case 'canvas':
        return 'image';
      case 'sequence':
        return (n as SceneNode<'sequence'>).props.purpose === 'animation' ? 'animation' : 'video';
      case 'codeWorkspace':
        return 'code';
      case 'document':
        return 'document';
      case 'deck':
        return 'slides';
    }
  }
  return null;
}

/** The containers created with every project. */
export function notesContainer(state: ProjectState): SceneNode<'notes'> {
  const n = childrenOfType(state, state.rootId, 'notes')[0];
  if (!n) throw new GraphError('Project is missing its session-memory container');
  return n;
}

export function commentsContainer(state: ProjectState): SceneNode<'comments'> {
  const n = childrenOfType(state, state.rootId, 'comments')[0];
  if (!n) throw new GraphError('Project is missing its comments container');
  return n;
}

/** Find a node by case-insensitive name match among nodes that have a `name` prop. */
export function findByName(state: ProjectState, name: string, type?: NodeType): AnyNode[] {
  const needle = name.trim().toLowerCase();
  const out: AnyNode[] = [];
  walk(state, state.rootId, (n) => {
    if (type && n.type !== type) return;
    const nm = (n.props as { name?: unknown }).name;
    if (typeof nm === 'string' && nm.toLowerCase() === needle) out.push(n as AnyNode);
  });
  return out;
}

/** Ids of every asset referenced anywhere in the project (for export bundles and GC). */
export function referencedAssets(state: ProjectState): Set<string> {
  const ids = new Set<string>();
  const scan = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) scan(x);
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'assetId' && typeof x === 'string' && x) ids.add(x);
      else scan(x);
    }
  };
  for (const n of Object.values(state.nodes)) scan(n.props);
  return ids;
}

/** Layer defaults by layer type, merged with overrides. */
export function layerProps(layerType: LayerType, overrides: Partial<LayerProps> = {}): Partial<LayerProps> {
  const base: Partial<LayerProps> = { layerType, name: overrides.name ?? defaultLayerName(layerType) };
  switch (layerType) {
    case 'raster':
      Object.assign(base, { assetId: null, strokes: [], width: undefined, height: undefined });
      break;
    case 'vector':
      Object.assign(base, { shapes: [] });
      break;
    case 'text':
      Object.assign(base, {
        text: 'Text',
        fontFamily: 'Inter',
        fontSize: 64,
        fontWeight: 600,
        fontStyle: 'normal',
        fontVariations: {},
        color: '#1d1f24',
        align: 'left',
        lineHeight: 1.2,
        letterSpacing: 0,
        baselineShift: 0,
        textPath: null,
        boxWidth: null,
      });
      break;
    case 'adjustment':
      Object.assign(base, { adjustment: { kind: 'brightnessContrast', brightness: 0, contrast: 0 } });
      break;
    case 'fill':
      Object.assign(base, { fillColor: '#ffffff' });
      break;
    case 'group':
      break;
  }
  return { ...base, ...overrides };
}

function defaultLayerName(t: LayerType): string {
  return { raster: 'Pixel layer', vector: 'Shape layer', text: 'Text', adjustment: 'Adjustment', fill: 'Fill', group: 'Group' }[t];
}

export type PropsOf<T extends NodeType> = NodePropsMap[T];
