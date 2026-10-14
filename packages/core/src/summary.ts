import type { SceneNode } from './nodes.js';
import { childrenOf, rootNode, toolOfNode, walk, type ProjectState } from './state.js';
import { clipDuration, clipsOf, contentDuration, tracksOf } from './timeline.js';
import { inlineToPlain } from './markdown.js';
import type { ToolKind } from './types.js';

/**
 * A compact, cross-tool description of a project. This is what Claude reads first:
 * it can see every document in every tool at once and then drill into node ids.
 */
export interface ProjectOutline {
  id: string;
  name: string;
  primaryTool: ToolKind;
  aiConsent: boolean;
  documents: DocumentOutline[];
  notes: { id: string; kind: string; text: string; author: string; createdAt: string }[];
  openComments: number;
}

export type DocumentOutline =
  | { tool: 'image'; id: string; name: string; width: number; height: number; layers: LayerOutline[] }
  | {
      tool: 'video' | 'animation';
      id: string;
      name: string;
      width: number;
      height: number;
      fps: number;
      duration: number;
      contentDuration: number;
      tracks: { id: string; name: string; type: string; items: { id: string; name: string; start: number; end: number; assetId?: string | null; text?: string }[] }[];
    }
  | { tool: 'code'; id: string; name: string; files: { id: string; path: string; language: string; lines: number }[]; notebooks: { id: string; name: string; cells: { id: string; language: string; firstLine: string; outputs: number }[] }[] }
  | { tool: 'document'; id: string; name: string; blocks: number; outline: { id: string; level: number; text: string }[]; openSuggestions: number }
  | { tool: 'slides'; id: string; name: string; slides: { id: string; name: string; title: string; elements: number; notes: boolean }[] };

export interface LayerOutline {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  opacity: number;
  blendMode: string;
  text?: string;
  children?: LayerOutline[];
}

function layerOutline(state: ProjectState, n: SceneNode<'layer'>): LayerOutline {
  const p = n.props;
  const o: LayerOutline = { id: n.id, name: p.name, type: p.layerType, visible: p.visible, opacity: p.opacity, blendMode: p.blendMode };
  if (p.layerType === 'text' && p.text) o.text = p.text.slice(0, 80);
  const kids = childrenOf(state, n.id).filter((c): c is SceneNode<'layer'> => c.type === 'layer');
  if (kids.length) o.children = kids.map((k) => layerOutline(state, k));
  return o;
}

export function outlineDocument(state: ProjectState, node: SceneNode): DocumentOutline | null {
  switch (node.type) {
    case 'canvas': {
      const p = (node as SceneNode<'canvas'>).props;
      return {
        tool: 'image',
        id: node.id,
        name: p.name,
        width: p.width,
        height: p.height,
        layers: childrenOf(state, node.id)
          .filter((c): c is SceneNode<'layer'> => c.type === 'layer')
          .map((l) => layerOutline(state, l)),
      };
    }
    case 'sequence': {
      const p = (node as SceneNode<'sequence'>).props;
      return {
        tool: p.purpose,
        id: node.id,
        name: p.name,
        width: p.width,
        height: p.height,
        fps: p.fps,
        duration: p.duration,
        contentDuration: contentDuration(state, node.id),
        tracks: tracksOf(state, node.id).map((t) => ({
          id: t.id,
          name: t.props.name,
          type: t.props.trackType,
          items: [
            ...clipsOf(state, t.id).map((c) => ({
              id: c.id,
              name: c.props.name,
              start: c.props.start,
              end: c.props.start + clipDuration(c.props),
              assetId: c.props.assetId,
              ...(c.props.title ? { text: c.props.title.text } : {}),
            })),
            ...childrenOf(state, t.id)
              .filter((a): a is SceneNode<'animLayer'> => a.type === 'animLayer')
              .map((a) => ({ id: a.id, name: a.props.name, start: a.props.start, end: a.props.start + a.props.duration })),
          ],
        })),
      };
    }
    case 'codeWorkspace': {
      const kids = childrenOf(state, node.id);
      return {
        tool: 'code',
        id: node.id,
        name: (node as SceneNode<'codeWorkspace'>).props.name,
        files: kids
          .filter((k): k is SceneNode<'codeFile'> => k.type === 'codeFile')
          .map((f) => ({ id: f.id, path: f.props.path, language: f.props.language, lines: f.props.content.split('\n').length })),
        notebooks: kids
          .filter((k): k is SceneNode<'notebook'> => k.type === 'notebook')
          .map((nb) => ({
            id: nb.id,
            name: nb.props.name,
            cells: childrenOf(state, nb.id)
              .filter((c): c is SceneNode<'cell'> => c.type === 'cell')
              .map((c) => ({ id: c.id, language: c.props.language, firstLine: c.props.source.split('\n')[0]!.slice(0, 80), outputs: c.props.outputs.length })),
          })),
      };
    }
    case 'document': {
      const blocks = childrenOf(state, node.id).filter((b): b is SceneNode<'block'> => b.type === 'block');
      const suggestions = childrenOf(state, node.id).filter((b): b is SceneNode<'suggestion'> => b.type === 'suggestion');
      return {
        tool: 'document',
        id: node.id,
        name: (node as SceneNode<'document'>).props.name,
        blocks: blocks.length,
        outline: blocks
          .filter((b) => b.props.blockType === 'heading')
          .map((b) => ({ id: b.id, level: b.props.level ?? 1, text: inlineToPlain(b.props.text) })),
        openSuggestions: suggestions.filter((s) => s.props.status === 'open').length,
      };
    }
    case 'deck': {
      return {
        tool: 'slides',
        id: node.id,
        name: (node as SceneNode<'deck'>).props.name,
        slides: childrenOf(state, node.id)
          .filter((s): s is SceneNode<'slide'> => s.type === 'slide')
          .map((s) => {
            const els = childrenOf(state, s.id).filter((e): e is SceneNode<'slideElement'> => e.type === 'slideElement');
            const title = els.find((e) => e.props.role === 'title')?.props.text ?? '';
            return { id: s.id, name: s.props.name, title: inlineToPlain(title), elements: els.length, notes: !!s.props.notes.trim() };
          }),
      };
    }
    default:
      return null;
  }
}

export function outlineProject(state: ProjectState): ProjectOutline {
  const root = rootNode(state);
  const documents: DocumentOutline[] = [];
  const notes: ProjectOutline['notes'] = [];
  let openComments = 0;
  for (const child of childrenOf(state, root.id)) {
    const d = outlineDocument(state, child);
    if (d) documents.push(d);
    if (child.type === 'notes') {
      for (const n of childrenOf(state, child.id)) {
        if (n.type !== 'note') continue;
        const p = (n as SceneNode<'note'>).props;
        notes.push({ id: n.id, kind: p.kind, text: p.text, author: p.author.name, createdAt: p.createdAt });
      }
    }
    if (child.type === 'comments') {
      openComments = childrenOf(state, child.id).filter((c) => c.type === 'comment' && !(c as SceneNode<'comment'>).props.resolved).length;
    }
  }
  return { id: root.id, name: root.props.name, primaryTool: root.props.primaryTool, aiConsent: root.props.aiConsent, documents, notes, openComments };
}

/** Plain-text tree of the project, compact enough to fit in a prompt. */
export function projectTreeText(state: ProjectState, maxNodes = 400): string {
  const lines: string[] = [];
  walk(state, state.rootId, (n, depth) => {
    if (lines.length >= maxNodes) return false;
    const p = n.props as Record<string, unknown>;
    const label = (['name', 'path', 'text', 'source'] as const).map((k) => p[k]).find((v) => typeof v === 'string' && v.trim()) as string | undefined;
    const extra = n.type === 'layer' ? ` [${String(p.layerType)}]` : n.type === 'block' ? ` [${String(p.blockType)}]` : n.type === 'slideElement' ? ` [${String(p.elementType)}]` : '';
    lines.push(`${'  '.repeat(depth)}${n.type}${extra} ${n.id}${label ? ` "${label.split('\n')[0]!.slice(0, 60)}"` : ''}`);
    return undefined;
  });
  return lines.join('\n');
}

export { toolOfNode };
