import type { CellOutput, EmbedRef, ProjectState, SceneNode } from '@omnix/core';
import { drawable, drawFitted, type Ctx2D, type RenderHost } from './host.js';
import { renderCanvasDocument } from './canvasDoc.js';
import { renderSequenceFrame } from './sequence.js';
import { drawChart } from './chart.js';

/**
 * Live links: documents and slides embed outputs from elsewhere in the project.
 * Embeds are resolved at render time from the current state, so a report or a slide
 * updates the moment its source (a code cell, canvas or clip) changes.
 */
export interface EmbedContext {
  host: RenderHost;
  state: ProjectState;
  scheme?: 'light' | 'dark';
  fontScale?: number;
  /** Prevent infinite recursion (slide embedding a slide embedding...). */
  depth?: number;
  /** Optional slide renderer (injected to avoid a module cycle). */
  renderSlide?: (slideId: string, w: number, h: number) => { width: number; height: number } | null;
}

/** The most displayable output of a code cell: chart > image > table > result/stdout. */
export function primaryOutput(outputs: readonly CellOutput[]): CellOutput | null {
  const order: CellOutput['kind'][] = ['chart', 'image', 'table', 'result', 'stdout', 'error'];
  for (const kind of order) {
    const found = [...outputs].reverse().find((o) => o.kind === kind);
    if (found) return found;
  }
  return null;
}

export function describeEmbed(state: ProjectState, embed: EmbedRef): string {
  const node = state.nodes[embed.ref];
  switch (embed.kind) {
    case 'cell-output':
      return node ? `Output of cell ${embed.ref}` : `Missing cell ${embed.ref}`;
    case 'canvas':
      return node ? `Canvas "${(node as SceneNode<'canvas'>).props.name}"` : 'Missing canvas';
    case 'sequence-frame':
      return node ? `Frame at ${embed.time ?? 0}s of "${(node as SceneNode<'sequence'>).props.name}"` : 'Missing sequence';
    case 'slide':
      return node ? `Slide "${(node as SceneNode<'slide'>).props.name}"` : 'Missing slide';
    case 'asset':
      return `Asset ${embed.ref}`;
    case 'chart':
      return 'Chart';
  }
}

/** Draw an embed into a rectangle. Returns false when the source no longer exists. */
export function drawEmbed(ctx: Ctx2D, embed: EmbedRef, x: number, y: number, w: number, h: number, ec: EmbedContext): boolean {
  const { host, state } = ec;
  const depth = ec.depth ?? 0;
  if (depth > 2) return false;
  switch (embed.kind) {
    case 'asset': {
      const img = host.image(embed.ref);
      if (!img) return false;
      drawFitted(ctx, img, x, y, w, h, 'contain');
      return true;
    }
    case 'canvas': {
      const node = state.nodes[embed.ref];
      if (node?.type !== 'canvas') return false;
      const cp = (node as SceneNode<'canvas'>).props;
      const scale = Math.min(w / cp.width, h / cp.height);
      const c = renderCanvasDocument(host, state, embed.ref, { scale });
      ctx.drawImage(drawable(c), x + (w - c.width) / 2, y + (h - c.height) / 2);
      return true;
    }
    case 'sequence-frame': {
      const node = state.nodes[embed.ref];
      if (node?.type !== 'sequence') return false;
      const sp = (node as SceneNode<'sequence'>).props;
      const scale = Math.min(w / sp.width, h / sp.height);
      const c = renderSequenceFrame(host, state, embed.ref, embed.time ?? 0, { scale, draft: true });
      ctx.drawImage(drawable(c), x + (w - c.width) / 2, y + (h - c.height) / 2);
      return true;
    }
    case 'slide': {
      const node = state.nodes[embed.ref];
      if (node?.type !== 'slide' || !ec.renderSlide) return false;
      const c = ec.renderSlide(embed.ref, w, h);
      if (!c) return false;
      ctx.drawImage(drawable(c), x + (w - c.width) / 2, y + (h - c.height) / 2);
      return true;
    }
    case 'chart':
    case 'cell-output': {
      const node = state.nodes[embed.ref];
      if (node?.type !== 'cell') return false;
      const out = primaryOutput((node as SceneNode<'cell'>).props.outputs);
      if (!out) return false;
      return drawCellOutput(ctx, out, x, y, w, h, ec);
    }
  }
}

export function drawCellOutput(ctx: Ctx2D, out: CellOutput, x: number, y: number, w: number, h: number, ec: EmbedContext): boolean {
  const scheme = ec.scheme ?? 'light';
  const fs = 14 * (ec.fontScale ?? 1);
  switch (out.kind) {
    case 'chart':
      drawChart(ctx, out.spec, x, y, w, h, { scheme, fontScale: ec.fontScale ?? 1 });
      return true;
    case 'image': {
      const img = ec.host.image(out.assetId);
      if (!img) return false;
      drawFitted(ctx, img, x, y, w, h, 'contain');
      return true;
    }
    case 'table': {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      const rowH = fs * 1.8;
      const colW = w / Math.max(1, out.columns.length);
      ctx.font = `600 ${fs}px Inter, sans-serif`;
      ctx.fillStyle = scheme === 'dark' ? '#f0efec' : '#0b0b0b';
      ctx.textBaseline = 'middle';
      out.columns.forEach((c, i) => ctx.fillText(c, x + i * colW + fs * 0.5, y + rowH / 2));
      ctx.font = `400 ${fs}px Inter, sans-serif`;
      ctx.fillStyle = scheme === 'dark' ? '#c3c2b7' : '#52514e';
      out.rows.forEach((row, ri) => {
        const yy = y + rowH * (ri + 1.5);
        if (yy > y + h) return;
        ctx.fillRect(x, y + rowH * (ri + 1), w, 1);
        row.forEach((cell, ci) => ctx.fillText(cell === null ? '' : String(cell), x + ci * colW + fs * 0.5, yy));
      });
      ctx.restore();
      return true;
    }
    case 'result':
    case 'stdout':
    case 'stderr':
    case 'error': {
      const text = out.kind === 'error' ? `${out.name}: ${out.message}` : out.text;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.font = `400 ${fs}px "JetBrains Mono", monospace`;
      ctx.fillStyle = out.kind === 'error' || out.kind === 'stderr' ? '#d03b3b' : scheme === 'dark' ? '#f0efec' : '#1d1f24';
      ctx.textBaseline = 'top';
      text.split('\n').forEach((line, i) => ctx.fillText(line, x + fs * 0.5, y + fs * 0.5 + i * fs * 1.45));
      ctx.restore();
      return true;
    }
  }
}
