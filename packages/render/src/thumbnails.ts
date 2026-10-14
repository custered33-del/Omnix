import type { ProjectState, SceneNode, ToolKind } from '@omnix/core';
import { childrenOf, clipsOf, inlineToPlain, nodesOfType, rootNode, sourceTimeAt, tracksOf, clipEnd, walk } from '@omnix/core';
import { ctxOf, drawable, fontStack, type CanvasLike, type RenderHost } from './host.js';
import { renderCanvasDocument } from './canvasDoc.js';
import { renderSequenceFrame } from './sequence.js';
import { renderSlide } from './slides.js';

/**
 * Asset needs for rendering a node: stills and, for video clips, specific frame times.
 * Hosts preload these before calling the synchronous renderers.
 */
export interface AssetNeeds {
  images: Set<string>;
  frames: { assetId: string; time: number }[];
}

export function collectAssetNeeds(state: ProjectState, rootId: string, time?: number): AssetNeeds {
  const images = new Set<string>();
  const frames: { assetId: string; time: number }[] = [];
  const scan = (v: unknown, key?: string): void => {
    if (!v || typeof v !== 'object') {
      if (key === 'assetId' && typeof v === 'string' && v) images.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) scan(x);
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) scan(x, k);
  };
  walk(state, rootId, (n) => {
    if (n.type === 'clip' && time !== undefined) {
      const p = (n as SceneNode<'clip'>).props;
      if (p.assetId) {
        const src = sourceTimeAt(p, time);
        if (src !== null) frames.push({ assetId: p.assetId, time: src });
        // Neighbouring frames are needed during transitions; hosts may treat these as hints.
      }
      for (const k of Object.keys(p)) if (k !== 'assetId') scan((p as unknown as Record<string, unknown>)[k], k);
      if (p.assetId) images.add(p.assetId);
      return;
    }
    scan(n.props);
  });
  return { images, frames };
}

/** The node that best represents a project visually (its primary tool's first document). */
export function primaryDocument(state: ProjectState): SceneNode | null {
  const root = rootNode(state);
  const tool = root.props.primaryTool;
  const typeFor: Record<ToolKind, string> = { image: 'canvas', video: 'sequence', animation: 'sequence', code: 'codeWorkspace', document: 'document', slides: 'deck' };
  const docs = childrenOf(state, root.id).filter((c) => c.type === typeFor[tool]);
  return docs[0] ?? childrenOf(state, root.id).find((c) => Object.values(typeFor).includes(c.type)) ?? null;
}

/** Render a small preview image of a project for dashboard cards. */
export function renderProjectThumbnail(host: RenderHost, state: ProjectState, width = 480, height = 300): CanvasLike {
  const out = host.createCanvas(width, height);
  const ctx = ctxOf(out);
  const doc = primaryDocument(state);
  const dark = host.scheme === 'dark';
  ctx.fillStyle = dark ? '#1f2024' : '#f4f3ef';
  ctx.fillRect(0, 0, width, height);
  if (!doc) return out;
  const fit = (w: number, h: number) => Math.min(width / w, height / h);
  const center = (c: CanvasLike) => ctx.drawImage(drawable(c), (width - c.width) / 2, (height - c.height) / 2);
  switch (doc.type) {
    case 'canvas': {
      const p = (doc as SceneNode<'canvas'>).props;
      center(renderCanvasDocument(host, state, doc.id, { scale: fit(p.width, p.height) }));
      break;
    }
    case 'sequence': {
      const p = (doc as SceneNode<'sequence'>).props;
      // Use the middle of the first visual clip so thumbnails are not black title cards.
      let t = 0;
      for (const track of tracksOf(state, doc.id)) {
        const first = clipsOf(state, track.id).find((c) => c.props.assetId);
        if (first) {
          t = (first.props.start + clipEnd(first.props)) / 2;
          break;
        }
      }
      center(renderSequenceFrame(host, state, doc.id, t, { scale: fit(p.width, p.height), draft: true }));
      break;
    }
    case 'deck': {
      const first = childrenOf(state, doc.id).find((s) => s.type === 'slide');
      if (first) {
        const p = (doc as SceneNode<'deck'>).props;
        center(renderSlide(host, state, first.id, { scale: fit(p.width, p.height) }));
      }
      break;
    }
    case 'document': {
      ctx.fillStyle = dark ? '#2a2b30' : '#ffffff';
      const pad = width * 0.1;
      ctx.fillRect(pad, height * 0.08, width - pad * 2, height);
      let y = height * 0.08 + 24;
      for (const b of childrenOf(state, doc.id)) {
        if (b.type !== 'block' || y > height) continue;
        const p = (b as SceneNode<'block'>).props;
        const heading = p.blockType === 'heading';
        const size = heading ? Math.max(12, 22 - (p.level ?? 1) * 3) : 10;
        ctx.font = `${heading ? 700 : 400} ${size}px ${fontStack(host, 'Inter')}`;
        ctx.fillStyle = dark ? '#e7e6e3' : '#1d1f24';
        const text = inlineToPlain(p.text || (p.blockType === 'image' ? '[image]' : p.blockType === 'embed' ? '[live chart]' : ''));
        if (!text) continue;
        ctx.fillText(text.slice(0, 60), pad + 16, y);
        y += size * 1.7;
      }
      break;
    }
    case 'codeWorkspace': {
      const files = nodesOfType(state, 'codeFile');
      const file = files[0];
      ctx.fillStyle = '#16171b';
      ctx.fillRect(0, 0, width, height);
      ctx.font = `400 11px ${fontStack(host, 'JetBrains Mono')}`;
      if (file) {
        ctx.fillStyle = '#7d8590';
        ctx.fillText(file.props.path, 14, 20);
        file.props.content
          .split('\n')
          .slice(0, Math.floor((height - 40) / 15))
          .forEach((line, i) => {
            ctx.fillStyle = /^\s*(#|\/\/)/.test(line) ? '#6a9955' : '#d4d4d4';
            ctx.fillText(line.slice(0, 70), 14, 44 + i * 15);
          });
      }
      break;
    }
  }
  return out;
}
