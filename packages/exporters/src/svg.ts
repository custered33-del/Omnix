import type { LayerProps, ProjectState, SceneNode, VectorShape, Selection } from '@omnix/core';
import { childrenOf, escapeHtml, pathToSvg, requireNodeOfType } from '@omnix/core';
import { renderCanvasDocument, renderSingleLayer, type CanvasLike, type RenderHost } from '@omnix/render';
import { ellipsePoints } from '@omnix/imaging';

/**
 * SVG export. Vector and text layers stay real SVG (editable in Illustrator, Figma, Inkscape);
 * raster, fill and filtered layers are embedded as PNG images. Blend modes use CSS
 * `mix-blend-mode`. Because SVG has no adjustment layers, everything up to the last adjustment
 * layer is flattened into one embedded image so the result looks the same.
 */
export interface SvgExportOptions {
  /** Encode a canvas as base64 PNG (provided by the host: browser or server). */
  encodePng(c: CanvasLike): string;
}

const att = (v: string | number) => escapeHtml(String(v));

function shapeSvg(s: VectorShape): string {
  const paint = `fill="${s.fill ?? 'none'}" stroke="${s.stroke ?? 'none'}" stroke-width="${s.strokeWidth}" stroke-linejoin="round" stroke-linecap="round"`;
  switch (s.kind) {
    case 'rect':
      return `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}"${s.radius ? ` rx="${s.radius}"` : ''} ${paint}/>`;
    case 'ellipse':
      return `<ellipse cx="${s.x + s.width / 2}" cy="${s.y + s.height / 2}" rx="${Math.abs(s.width / 2)}" ry="${Math.abs(s.height / 2)}" ${paint}/>`;
    case 'polygon':
      return `<polygon points="${(s.points ?? []).map((p) => `${p.x},${p.y}`).join(' ')}" ${paint}/>`;
    case 'line':
      return `<polyline points="${(s.points ?? []).map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${s.stroke ?? '#000'}" stroke-width="${s.strokeWidth}" stroke-linejoin="round" stroke-linecap="round"/>`;
    case 'path':
      return s.path ? `<path d="${pathToSvg(s.path)}" ${paint}/>` : '';
  }
}

function selectionSvg(sel: Selection): string {
  switch (sel.kind) {
    case 'rect':
      return `<rect x="${sel.x}" y="${sel.y}" width="${sel.width}" height="${sel.height}" fill="#fff"/>`;
    case 'ellipse':
      return `<ellipse cx="${sel.x + sel.width / 2}" cy="${sel.y + sel.height / 2}" rx="${sel.width / 2}" ry="${sel.height / 2}" fill="#fff"/>`;
    case 'polygon':
      return `<polygon points="${sel.points.map((p) => `${p.x},${p.y}`).join(' ')}" fill="#fff"/>`;
    case 'mask':
      return '';
  }
}

function transformAttr(p: LayerProps): string {
  const parts: string[] = [];
  if (p.x || p.y) parts.push(`translate(${p.x} ${p.y})`);
  if (p.rotation) parts.push(`rotate(${p.rotation})`);
  if (p.scaleX !== 1 || p.scaleY !== 1) parts.push(`scale(${p.scaleX} ${p.scaleY})`);
  return parts.length ? ` transform="${parts.join(' ')}"` : '';
}

export function exportSvg(host: RenderHost, state: ProjectState, canvasId: string, options: SvgExportOptions): string {
  const canvas = requireNodeOfType(state, canvasId, 'canvas');
  const { width, height, background } = canvas.props;
  const defs: string[] = [];
  let maskCounter = 0;
  const top = childrenOf(state, canvasId).filter((c): c is SceneNode<'layer'> => c.type === 'layer');
  const lastAdjustment = top.map((l) => l.props.layerType === 'adjustment' && l.props.visible).lastIndexOf(true);
  const body: string[] = [];

  if (lastAdjustment >= 0) {
    // Flatten everything up to and including the last adjustment layer.
    const hidden = new Set(top.slice(lastAdjustment + 1).map((l) => l.id));
    const flat = renderCanvasDocument(host, state, canvasId, { hiddenLayers: hidden });
    body.push(`<image x="0" y="0" width="${width}" height="${height}" href="data:image/png;base64,${options.encodePng(flat)}"/>`);
  } else if (background) {
    body.push(`<rect width="${width}" height="${height}" fill="${background}"/>`);
  }

  const layerSvg = (layer: SceneNode<'layer'>): string => {
    const p = layer.props;
    if (!p.visible) return '';
    const style: string[] = [];
    if (p.blendMode !== 'normal') style.push(`mix-blend-mode:${p.blendMode}`);
    const attrs = [`id="${att(layer.id)}"`, `data-name="${att(p.name)}"`];
    if (p.opacity < 1) attrs.push(`opacity="${p.opacity}"`);
    if (style.length) attrs.push(`style="${style.join(';')}"`);
    if (p.mask?.enabled && p.mask.source.kind !== 'mask') {
      const id = `m${++maskCounter}`;
      defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">${p.mask.inverted ? `<rect width="${width}" height="${height}" fill="#fff"/>` : ''}${selectionSvg(p.mask.source).replace('fill="#fff"', `fill="${p.mask.inverted ? '#000' : '#fff'}"`)}</mask>`);
      attrs.push(`mask="url(#${id})"`);
    }
    const hasFilters = p.filters.some((f) => f.enabled);
    const raster = () => `<image x="0" y="0" width="${width}" height="${height}" href="data:image/png;base64,${options.encodePng(renderSingleLayer(host, state, layer.id, { includeMask: p.mask?.source.kind === 'mask' }))}"/>`;
    let inner = '';
    if (p.layerType === 'group') {
      inner = childrenOf(state, layer.id)
        .filter((c): c is SceneNode<'layer'> => c.type === 'layer')
        .map(layerSvg)
        .join('');
    } else if (p.layerType === 'vector' && !hasFilters) {
      inner = `<g${transformAttr(p)}>${(p.shapes ?? []).map(shapeSvg).join('')}</g>`;
    } else if (p.layerType === 'text' && !hasFilters && !p.textPath) {
      const size = p.fontSize ?? 48;
      const lh = size * (p.lineHeight ?? 1.2);
      const anchor = p.align === 'center' ? 'middle' : p.align === 'right' ? 'end' : 'start';
      const lines = (p.text ?? '').split('\n');
      inner = `<text${transformAttr(p)} font-family="${att(p.fontFamily ?? 'Inter')}, sans-serif" font-size="${size}" font-weight="${p.fontWeight ?? 400}"${p.fontStyle === 'italic' ? ' font-style="italic"' : ''} fill="${p.color ?? '#000'}" text-anchor="${anchor}"${p.letterSpacing ? ` letter-spacing="${p.letterSpacing}"` : ''}>${lines
        .map((l, i) => `<tspan x="0" y="${(i * lh + size * 0.82 + (lh - size) / 2 - (p.baselineShift ?? 0)).toFixed(2)}">${escapeHtml(l)}</tspan>`)
        .join('')}</text>`;
    } else if (p.layerType === 'fill' && !hasFilters) {
      inner = `<rect width="${width}" height="${height}" fill="${p.fillColor ?? '#fff'}"/>`;
    } else if (p.layerType === 'adjustment') {
      return '';
    } else {
      inner = raster();
    }
    return `<g ${attrs.join(' ')}>${inner}</g>`;
  };

  for (const l of top.slice(lastAdjustment + 1)) body.push(layerSvg(l));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n<title>${escapeHtml(canvas.props.name)}</title>\n${defs.length ? `<defs>${defs.join('')}</defs>\n` : ''}${body.join('\n')}\n</svg>\n`;
}

export { ellipsePoints };
