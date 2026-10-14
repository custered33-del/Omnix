import type { ProjectState, SceneNode } from '@omnix/core';
import { childrenOf, closest } from '@omnix/core';
import { renderCanvasDocument, renderProjectThumbnail, renderSequenceFrame, renderSlide, BUILT, type CanvasLike } from '@omnix/render';
import type { Services } from '../services.js';
import { encodeCanvas } from './serverHost.js';
import { ProjectError } from '../projects/service.js';

export interface RenderRequest {
  nodeId?: string | null;
  time?: number;
  /** Longest edge of the output in pixels. */
  maxSize?: number;
  format?: 'png' | 'webp' | 'jpeg';
  scheme?: 'light' | 'dark';
  /** Slide build step (presenter); defaults to fully built. */
  step?: number;
}

/**
 * Render any visual node to an image: a canvas, a single layer, a sequence frame,
 * a slide, a deck (first slide) or the project thumbnail when no node is given.
 */
export async function renderNode(services: Services, state: ProjectState, req: RenderRequest): Promise<{ data: Buffer; mime: string; width: number; height: number }> {
  const host = services.renderHost();
  host.scheme = req.scheme ?? 'light';
  const max = Math.min(4096, Math.max(16, req.maxSize ?? 1024));
  const node = req.nodeId ? state.nodes[req.nodeId] : undefined;
  if (req.nodeId && !node) throw new ProjectError(`Node not found: ${req.nodeId}`, 404);
  let canvas: CanvasLike;
  const time = req.time ?? 0;
  const scaleFor = (w: number, h: number) => Math.min(1, max / Math.max(w, h));

  if (!node) {
    await host.prepare(state, state.rootId, 0);
    canvas = renderProjectThumbnail(host, state, Math.min(max, 960), Math.round(Math.min(max, 960) * 0.625));
  } else {
    switch (node.type) {
      case 'canvas': {
        const p = (node as SceneNode<'canvas'>).props;
        await host.prepare(state, node.id);
        canvas = renderCanvasDocument(host, state, node.id, { scale: scaleFor(p.width, p.height) });
        break;
      }
      case 'layer': {
        const cnv = closest(state, node.id, 'canvas');
        if (!cnv) throw new ProjectError('Layer is not inside a canvas', 400);
        await host.prepare(state, cnv.id);
        canvas = renderCanvasDocument(host, state, cnv.id, { scale: scaleFor(cnv.props.width, cnv.props.height), onlyLayer: node.id });
        break;
      }
      case 'sequence':
      case 'track':
      case 'clip':
      case 'animLayer': {
        const seq = closest(state, node.id, 'sequence')!;
        const t = node.type === 'clip' && req.time === undefined ? (node as SceneNode<'clip'>).props.start : time;
        await host.prepare(state, seq.id, t);
        canvas = renderSequenceFrame(host, state, seq.id, t, { scale: scaleFor(seq.props.width, seq.props.height) });
        break;
      }
      case 'slide':
      case 'slideElement': {
        const slide = closest(state, node.id, 'slide')!;
        const deck = closest(state, slide.id, 'deck')!;
        await host.prepare(state, slide.id, 0);
        canvas = renderSlide(host, state, slide.id, { scale: scaleFor(deck.props.width, deck.props.height), playhead: req.step !== undefined ? { step: req.step, t: 99 } : BUILT });
        break;
      }
      case 'deck': {
        const first = childrenOf(state, node.id).find((s) => s.type === 'slide');
        if (!first) throw new ProjectError('This deck has no slides yet', 400);
        const p = (node as SceneNode<'deck'>).props;
        await host.prepare(state, first.id, 0);
        canvas = renderSlide(host, state, first.id, { scale: scaleFor(p.width, p.height) });
        break;
      }
      default: {
        await host.prepare(state, state.rootId, 0);
        canvas = renderProjectThumbnail(host, state, Math.min(max, 960), Math.round(Math.min(max, 960) * 0.625));
      }
    }
  }
  const format = req.format ?? 'png';
  const data = await encodeCanvas(canvas, format, { quality: 85 });
  return { data, mime: `image/${format}`, width: canvas.width, height: canvas.height };
}
