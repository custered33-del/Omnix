import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { LayerProps, Point, ProjectState, SceneNode, Selection, Stroke, VectorShape } from '@omnix/core';
import { childrenOf, layerProps as defaultLayerProps, makeNode, newId, parseColor, toHex } from '@omnix/core';
import { combineMasks, invertMask } from '@omnix/imaging';
import { layerBounds, renderCanvasDocument, strokeDabs, type LayerCache } from '@omnix/render';
import { useProject, useProjectStore } from '../../state/project.js';
import { useAuth } from '../../state/auth.js';
import { useRenderHost, useHostVersion } from '../../render/context.js';
import { toast } from '../../ui/toast.js';
import { emptyLive, isEmptySelection, type ImageEditorStore, type LivePreview } from './editorState.js';
import { compositeRaster, layerRaster, runImaging, selectionToMask, uploadRaster } from '../shared/pixels.js';
import { t } from '../../i18n/index.js';
import type { Mask } from '@omnix/imaging';

const HANDLE = 8;

export function docToLayer(p: Point, l: LayerProps): Point {
  let x = p.x - l.x;
  let y = p.y - l.y;
  if (l.rotation) {
    const a = (-l.rotation * Math.PI) / 180;
    const rx = x * Math.cos(a) - y * Math.sin(a);
    const ry = x * Math.sin(a) + y * Math.cos(a);
    x = rx;
    y = ry;
  }
  return { x: x / (l.scaleX || 1), y: y / (l.scaleY || 1) };
}

function simplify<P extends Point>(points: P[], tolerance: number): P[] {
  if (points.length < 3) return points;
  const out: P[] = [points[0]!];
  for (const p of points.slice(1)) {
    const last = out[out.length - 1]!;
    if (Math.hypot(p.x - last.x, p.y - last.y) >= tolerance) out.push(p);
  }
  return out;
}

/** Pressure with the user's curve applied (gamma > 1 needs a firmer touch). */
function curvedPressure(e: PointerEvent, gamma: number): number {
  const raw = e.pointerType === 'pen' ? e.pressure : 1;
  return Math.pow(Math.min(1, Math.max(0.01, raw)), gamma);
}

export function Viewport({ canvasId, ed }: { canvasId: string; ed: ImageEditorStore }) {
  const store = useProjectStore();
  const state = useProject((s) => s.state)!;
  const presence = useProject((s) => s.presence);
  const host = useRenderHost();
  const hostVersion = useHostVersion();
  const pressureGamma = useAuth((s) => s.user?.preferences.pressureGamma ?? 1);
  const tool = useStore(ed, (s) => s.springTool ?? s.tool);
  const zoom = useStore(ed, (s) => s.zoom);
  const pan = useStore(ed, (s) => s.pan);
  const selectedLayerId = useStore(ed, (s) => s.selectedLayerId);
  const editingText = useStore(ed, (s) => s.editingTextLayer);
  const containerRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const cache = useRef<LayerCache>(new Map());
  const live = useRef<LivePreview>(emptyLive());
  const drag = useRef<null | { kind: string; start: Point; last: Point; layerId?: string; orig?: Partial<LayerProps>; handle?: string; bounds?: { x: number; y: number; width: number; height: number } }>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const canvas = state.nodes[canvasId] as SceneNode<'canvas'>;
  const cp = canvas.props;
  const layer = selectedLayerId ? (state.nodes[selectedLayerId] as SceneNode<'layer'> | undefined) : undefined;

  /* ---------------- sizing and fit ---------------- */
  useEffect(() => {
    const el = containerRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !size.w) return;
    fitted.current = true;
    const z = Math.min((size.w - 80) / cp.width, (size.h - 80) / cp.height, 1);
    ed.getState().set({ zoom: z, pan: { x: (size.w - cp.width * z) / 2, y: (size.h - cp.height * z) / 2 } });
  }, [size, cp.width, cp.height, ed]);

  /* ---------------- document rendering ---------------- */
  useEffect(() => {
    let raf = requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1;
      const renderScale = Math.min(zoom * dpr, dpr, 4096 / Math.max(cp.width, cp.height));
      const out = renderCanvasDocument(host, state, canvasId, { scale: renderScale, cache: cache.current, hostVersion });
      const c = docRef.current;
      if (!c) return;
      if (c.width !== out.width || c.height !== out.height) {
        c.width = out.width;
        c.height = out.height;
      }
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(out as unknown as CanvasImageSource, 0, 0);
    });
    return () => cancelAnimationFrame(raf);
  }, [state, hostVersion, zoom, canvasId, host, cp.width, cp.height]);

  /* ---------------- overlay ---------------- */
  const maskOverlay = useRef<{ assetId: string; canvas: HTMLCanvasElement } | null>(null);
  const drawOverlay = useCallback(
    (dash: number) => {
      const c = overlayRef.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== size.w * dpr || c.height !== size.h * dpr) {
        c.width = size.w * dpr;
        c.height = size.h * dpr;
      }
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.w, size.h);
      const { zoom: z, pan: p } = ed.getState();
      const toScreen = (x: number, y: number) => ({ x: p.x + x * z, y: p.y + y * z });
      const ants = (path: () => void) => {
        ctx.save();
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = '#ffffff';
        path();
        ctx.stroke();
        ctx.strokeStyle = '#000000';
        ctx.lineDashOffset = dash;
        path();
        ctx.stroke();
        ctx.restore();
      };
      const selPath = (sel: Selection) => () => {
        ctx.beginPath();
        if (sel.kind === 'rect') {
          const a = toScreen(sel.x, sel.y);
          ctx.rect(a.x + 0.5, a.y + 0.5, sel.width * z, sel.height * z);
        } else if (sel.kind === 'ellipse') {
          const a = toScreen(sel.x + sel.width / 2, sel.y + sel.height / 2);
          ctx.ellipse(a.x, a.y, Math.abs((sel.width * z) / 2), Math.abs((sel.height * z) / 2), 0, 0, Math.PI * 2);
        } else if (sel.kind === 'polygon') {
          sel.points.forEach((pt, i) => {
            const s = toScreen(pt.x, pt.y);
            if (i) ctx.lineTo(s.x, s.y);
            else ctx.moveTo(s.x, s.y);
          });
          ctx.closePath();
        }
      };
      const sel = cp.selection;
      if (sel) {
        if (sel.kind === 'mask') {
          // Dim everything outside a pixel selection ("quick mask" style).
          if (maskOverlay.current?.assetId !== sel.assetId) {
            const m = host.mask(sel.assetId);
            if (m) {
              const mc = document.createElement('canvas');
              mc.width = m.width;
              mc.height = m.height;
              const mctx = mc.getContext('2d')!;
              const img = mctx.createImageData(m.width, m.height);
              for (let i = 0; i < m.data.length; i++) {
                img.data[i * 4] = 40;
                img.data[i * 4 + 1] = 80;
                img.data[i * 4 + 2] = 220;
                img.data[i * 4 + 3] = (255 - m.data[i]!) * 0.45;
              }
              mctx.putImageData(img, 0, 0);
              maskOverlay.current = { assetId: sel.assetId, canvas: mc };
            }
          }
          if (maskOverlay.current?.assetId === sel.assetId) {
            const a = toScreen(0, 0);
            ctx.drawImage(maskOverlay.current.canvas, a.x, a.y, cp.width * z, cp.height * z);
          }
        } else ants(selPath(sel));
      }
      const L = live.current;
      if (L.rect) {
        const a = toScreen(Math.min(L.rect.x, L.rect.x + L.rect.width), Math.min(L.rect.y, L.rect.y + L.rect.height));
        const w = Math.abs(L.rect.width) * z;
        const h = Math.abs(L.rect.height) * z;
        if (L.rect.kind === 'shape') {
          ctx.save();
          ctx.strokeStyle = '#3b5bdb';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(a.x, a.y, w, h);
          ctx.restore();
        } else
          ants(() => {
            ctx.beginPath();
            if (L.rect!.kind === 'ellipse') ctx.ellipse(a.x + w / 2, a.y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
            else ctx.rect(a.x + 0.5, a.y + 0.5, w, h);
          });
      }
      if (L.lasso && L.lasso.length > 1)
        ants(() => {
          ctx.beginPath();
          L.lasso!.forEach((pt, i) => {
            const s = toScreen(pt.x, pt.y);
            if (i) ctx.lineTo(s.x, s.y);
            else ctx.moveTo(s.x, s.y);
          });
        });
      if (L.quick) {
        ctx.save();
        ctx.fillStyle = 'rgba(59, 91, 219, 0.35)';
        const r = 10 * z;
        for (const pt of L.quick) {
          const s = toScreen(pt.x, pt.y);
          ctx.beginPath();
          ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      if (L.stroke && L.stroke.points.length) {
        ctx.save();
        const st = L.stroke;
        const dabs = strokeDabs({ points: st.points, size: st.size, spacing: 0.15 });
        ctx.globalAlpha = st.tool === 'eraser' ? 0.5 : st.opacity;
        ctx.fillStyle = st.tool === 'eraser' ? '#ffffff' : st.tool === 'clone' || st.tool === 'heal' ? 'rgba(59,91,219,0.5)' : st.color;
        for (const d of dabs) {
          const s = toScreen(d.x, d.y);
          ctx.beginPath();
          ctx.arc(s.x, s.y, Math.max(0.5, d.radius * z), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      // Transform box for the selected layer (move tool).
      const st = ed.getState();
      const tl = st.selectedLayerId ? (state.nodes[st.selectedLayerId] as SceneNode<'layer'> | undefined) : undefined;
      if (tl && (st.springTool ?? st.tool) === 'move' && tl.props.layerType !== 'adjustment' && tl.props.layerType !== 'fill' && tl.props.layerType !== 'group') {
        const b = layerBounds(host, state, tl.id);
        const a = toScreen(b.x, b.y);
        ctx.save();
        ctx.strokeStyle = '#3b5bdb';
        ctx.lineWidth = 1;
        ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.width * z, b.height * z);
        ctx.fillStyle = '#ffffff';
        for (const [hx, hy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ]) {
          ctx.fillRect(a.x + hx! * b.width * z - HANDLE / 2, a.y + hy! * b.height * z - HANDLE / 2, HANDLE, HANDLE);
          ctx.strokeRect(a.x + hx! * b.width * z - HANDLE / 2 + 0.5, a.y + hy! * b.height * z - HANDLE / 2 + 0.5, HANDLE, HANDLE);
        }
        ctx.restore();
      }
      // Brush cursor.
      const tool2 = st.springTool ?? st.tool;
      if (L.cursor && ['brush', 'eraser', 'clone', 'heal'].includes(tool2)) {
        const settings = tool2 === 'eraser' ? st.eraser : tool2 === 'brush' ? st.brush : st.clone;
        const s = toScreen(L.cursor.x, L.cursor.y);
        ctx.save();
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.beginPath();
        ctx.arc(s.x, s.y, Math.max(2, (settings.size / 2) * z), 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.beginPath();
        ctx.arc(s.x, s.y, Math.max(2, (settings.size / 2) * z) + 1, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        if (tool2 === 'clone' || tool2 === 'heal') {
          const src = st.clone.source;
          if (src) {
            const ss = toScreen(src.x, src.y);
            ctx.save();
            ctx.strokeStyle = '#e8590c';
            ctx.beginPath();
            ctx.moveTo(ss.x - 6, ss.y);
            ctx.lineTo(ss.x + 6, ss.y);
            ctx.moveTo(ss.x, ss.y - 6);
            ctx.lineTo(ss.x, ss.y + 6);
            ctx.stroke();
            ctx.restore();
          }
        }
      }
    },
    [size, ed, cp.selection, cp.width, cp.height, host, state],
  );

  useEffect(() => {
    const reduced = document.documentElement.getAttribute('data-motion') === 'reduced' || (document.documentElement.getAttribute('data-motion') !== 'full' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    let raf = 0;
    let dash = 0;
    const loop = () => {
      dash = (dash + 0.4) % 9;
      drawOverlay(reduced ? 0 : dash);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [drawOverlay]);

  /* ---------------- helpers ---------------- */
  const toDoc = (e: { clientX: number; clientY: number }): Point => {
    const r = containerRef.current!.getBoundingClientRect();
    const { zoom: z, pan: p } = ed.getState();
    return { x: (e.clientX - r.left - p.x) / z, y: (e.clientY - r.top - p.y) / z };
  };

  const api = store.getState();
  const projectId = api.projectId;
  const canEdit = api.canEdit();

  const setSelection = (sel: Selection | null, label = sel ? 'Select' : 'Deselect') => {
    api.commit({ kind: 'update', id: canvasId, set: { selection: sel } }, label);
  };

  const applySelection = async (next: Selection | null) => {
    const mode = ed.getState().select.mode;
    const feather = ed.getState().select.feather;
    if (next && feather && next.kind !== 'mask') next = { ...next, feather } as Selection;
    if (!next || isEmptySelection(next)) {
      if (mode === 'replace') setSelection(null);
      return;
    }
    const cur = cp.selection;
    if (mode === 'replace' || !cur) {
      setSelection(next);
      return;
    }
    const a = selectionToMask(host, cur, cp.width, cp.height);
    const b = selectionToMask(host, next, cp.width, cp.height);
    const m = combineMasks(a, b, mode === 'add' ? 'add' : 'subtract');
    const id = await uploadRaster(host, m, 'selection.png', projectId, true);
    setSelection({ kind: 'mask', assetId: id });
  };

  const maskSelection = async (m: Mask, label: string) => {
    ed.getState().set({ busy: label });
    try {
      const id = await uploadRaster(host, m, 'selection.png', projectId, true);
      await applySelection({ kind: 'mask', assetId: id });
    } finally {
      ed.getState().set({ busy: null });
    }
  };

  const samplingRaster = () => {
    const st = ed.getState();
    if (!st.wand.sampleAll && layer) return layerRaster(host, state, layer.id);
    return compositeRaster(host, state, canvasId);
  };

  /** The raster layer strokes go into; creates one above the selection if needed. */
  const targetRasterLayer = (): { id: string; createOps: import('@omnix/core').Operation[] } => {
    if (layer && layer.props.layerType === 'raster' && !layer.props.locked) return { id: layer.id, createOps: [] };
    const node = makeNode('layer', defaultLayerProps('raster', { name: t('image.layerTypes.raster'), width: cp.width, height: cp.height, strokes: [] }));
    const parentId = layer?.parentId && state.nodes[layer.parentId]?.type === 'layer' ? layer.parentId : canvasId;
    const siblings = state.nodes[parentId]!.children;
    const index = layer ? siblings.indexOf(layer.id) + 1 : siblings.length;
    return { id: node.id, createOps: [{ kind: 'create', parentId, index, nodes: [node] }] };
  };

  const hitHandle = (p: Point): string | null => {
    if (!layer) return null;
    const b = layerBounds(host, state, layer.id);
    const z = ed.getState().zoom;
    const tol = (HANDLE + 4) / z;
    for (const [name, hx, hy] of [
      ['nw', 0, 0],
      ['ne', 1, 0],
      ['sw', 0, 1],
      ['se', 1, 1],
    ] as const) {
      if (Math.abs(p.x - (b.x + hx * b.width)) < tol && Math.abs(p.y - (b.y + hy * b.height)) < tol) return name;
    }
    return null;
  };

  const topLayerAt = (p: Point): string | null => {
    const walkTop = (parent: string): string | null => {
      const kids = childrenOf(state, parent).filter((n): n is SceneNode<'layer'> => n.type === 'layer');
      for (let i = kids.length - 1; i >= 0; i--) {
        const l = kids[i]!;
        if (!l.props.visible || l.props.locked || l.props.layerType === 'adjustment' || l.props.layerType === 'fill') continue;
        if (l.props.layerType === 'group') {
          const inner = walkTop(l.id);
          if (inner) return inner;
          continue;
        }
        const b = layerBounds(host, state, l.id);
        if (p.x >= b.x && p.y >= b.y && p.x <= b.x + b.width && p.y <= b.y + b.height) return l.id;
      }
      return null;
    };
    return walkTop(canvasId);
  };

  /* ---------------- pointer handling ---------------- */
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || (e.button === 0 && tool === 'hand')) {
      drag.current = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, last: { x: e.clientX, y: e.clientY } };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const p = toDoc(e);
    const st = ed.getState();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    containerRef.current?.focus();
    switch (tool) {
      case 'zoom': {
        const factor = e.altKey ? 1 / 1.5 : 1.5;
        zoomAt(e.clientX, e.clientY, st.zoom * factor);
        return;
      }
      case 'eyedropper': {
        const r = compositeRaster(host, state, canvasId);
        const x = Math.min(r.width - 1, Math.max(0, Math.round(p.x)));
        const y = Math.min(r.height - 1, Math.max(0, Math.round(p.y)));
        const i = (y * r.width + x) * 4;
        st.set({ color: toHex({ r: r.data[i]!, g: r.data[i + 1]!, b: r.data[i + 2]!, a: 1 }) });
        return;
      }
      case 'move': {
        if (!canEdit) return;
        const handle = hitHandle(p);
        let id = st.selectedLayerId;
        if (!handle) {
          const hit = topLayerAt(p);
          if (hit && hit !== id && !e.shiftKey) {
            id = hit;
            st.set({ selectedLayerId: hit });
            api.select([hit]);
          }
        }
        if (!id) return;
        const l = state.nodes[id] as SceneNode<'layer'>;
        if (l.props.locked) return;
        drag.current = { kind: handle ? 'scale' : 'move', start: p, last: p, layerId: id, orig: { x: l.props.x, y: l.props.y, scaleX: l.props.scaleX, scaleY: l.props.scaleY }, ...(handle ? { handle, bounds: layerBounds(host, state, id) } : {}) };
        return;
      }
      case 'marquee':
      case 'ellipse':
      case 'object':
        live.current.rect = { x: p.x, y: p.y, width: 0, height: 0, kind: tool === 'ellipse' ? 'ellipse' : tool === 'object' ? 'object' : 'rect' };
        drag.current = { kind: 'rect', start: p, last: p };
        return;
      case 'shape':
        if (!canEdit) return;
        live.current.rect = { x: p.x, y: p.y, width: 0, height: 0, kind: 'shape' };
        drag.current = { kind: 'shape', start: p, last: p };
        return;
      case 'lasso':
        live.current.lasso = [p];
        drag.current = { kind: 'lasso', start: p, last: p };
        return;
      case 'quick':
        live.current.quick = [p];
        drag.current = { kind: 'quick', start: p, last: p };
        return;
      case 'wand': {
        void (async () => {
          st.set({ busy: t('image.working') });
          try {
            const m = await runImaging<Mask>('magicWand', { raster: samplingRaster(), x: p.x, y: p.y, tolerance: st.wand.tolerance, contiguous: st.wand.contiguous });
            await maskSelection(m, t('image.working'));
          } catch (err) {
            toast.error((err as Error).message);
          } finally {
            st.set({ busy: null });
          }
        })();
        return;
      }
      case 'text': {
        if (!canEdit) return;
        // Keep the browser from moving focus to the viewport after the text box opens.
        e.preventDefault();
        const hit = topLayerAt(p);
        if (hit && (state.nodes[hit] as SceneNode<'layer'>).props.layerType === 'text') {
          st.set({ selectedLayerId: hit, editingTextLayer: hit });
          return;
        }
        const node = makeNode('layer', defaultLayerProps('text', { text: 'Text', x: Math.round(p.x), y: Math.round(p.y), fontFamily: st.text.fontFamily, fontSize: st.text.fontSize, fontWeight: st.text.fontWeight, color: st.color }));
        if (api.commit({ kind: 'create', parentId: canvasId, nodes: [node] }, 'Add text')) {
          st.set({ selectedLayerId: node.id, editingTextLayer: node.id, tool: 'move' });
          api.select([node.id]);
        }
        return;
      }
      case 'brush':
      case 'eraser':
      case 'clone':
      case 'heal': {
        if (!canEdit) return;
        if ((tool === 'clone' || tool === 'heal') && e.altKey) {
          st.set({ clone: { ...st.clone, source: p } });
          return;
        }
        if ((tool === 'clone' || tool === 'heal') && !st.clone.source) {
          toast.info(t('image.sourceHint'));
          return;
        }
        const settings = tool === 'eraser' ? st.eraser : tool === 'brush' ? st.brush : st.clone;
        live.current.stroke = { points: [{ ...p, pressure: curvedPressure(e.nativeEvent, pressureGamma) }], tool, size: settings.size, color: st.color, opacity: settings.opacity, hardness: settings.hardness };
        drag.current = { kind: 'stroke', start: p, last: p };
        return;
      }
    }
  };

  const zoomAt = (clientX: number, clientY: number, nextZoom: number) => {
    const st = ed.getState();
    const z = Math.min(32, Math.max(0.02, nextZoom));
    const r = containerRef.current!.getBoundingClientRect();
    const cx = clientX - r.left;
    const cy = clientY - r.top;
    const docX = (cx - st.pan.x) / st.zoom;
    const docY = (cy - st.pan.y) / st.zoom;
    st.set({ zoom: z, pan: { x: cx - docX * z, y: cy - docY * z } });
  };

  const lastPresence = useRef(0);
  const onPointerMove = (e: React.PointerEvent) => {
    const p = toDoc(e);
    live.current.cursor = p;
    const now = performance.now();
    if (now - lastPresence.current > 80) {
      lastPresence.current = now;
      api.reportLocation({ tool: 'image', nodeId: canvasId, x: Math.round(p.x), y: Math.round(p.y) });
    }
    const d = drag.current;
    if (!d) return;
    const st = ed.getState();
    switch (d.kind) {
      case 'pan': {
        st.set({ pan: { x: st.pan.x + e.clientX - d.last.x, y: st.pan.y + e.clientY - d.last.y } });
        d.last = { x: e.clientX, y: e.clientY };
        return;
      }
      case 'move': {
        const dx = p.x - d.start.x;
        const dy = p.y - d.start.y;
        api.setTransient(d.layerId!, { x: Math.round((d.orig!.x ?? 0) + dx), y: Math.round((d.orig!.y ?? 0) + dy) });
        return;
      }
      case 'scale': {
        const b = d.bounds!;
        const ax = d.handle!.includes('w') ? b.x + b.width : b.x;
        const ay = d.handle!.includes('n') ? b.y + b.height : b.y;
        let sx = Math.abs(p.x - ax) / Math.max(1, b.width);
        let sy = Math.abs(p.y - ay) / Math.max(1, b.height);
        if (e.shiftKey) sx = sy = Math.max(sx, sy);
        const nsx = (d.orig!.scaleX ?? 1) * sx;
        const nsy = (d.orig!.scaleY ?? 1) * sy;
        const nx = d.handle!.includes('w') ? ax - b.width * sx : ax;
        const ny = d.handle!.includes('n') ? ay - b.height * sy : ay;
        const l = state.nodes[d.layerId!] as SceneNode<'layer'>;
        // Keep the layer's own origin offset relative to its bounds.
        const ox = (d.orig!.x ?? 0) - b.x;
        const oy = (d.orig!.y ?? 0) - b.y;
        api.setTransient(d.layerId!, { scaleX: Math.max(0.01, nsx), scaleY: Math.max(0.01, nsy), x: Math.round(nx + ox * sx), y: Math.round(ny + oy * sy) });
        void l;
        return;
      }
      case 'rect':
      case 'shape': {
        let w = p.x - d.start.x;
        let h = p.y - d.start.y;
        if (e.shiftKey) {
          const m = Math.max(Math.abs(w), Math.abs(h));
          w = Math.sign(w || 1) * m;
          h = Math.sign(h || 1) * m;
        }
        live.current.rect = { ...live.current.rect!, width: w, height: h };
        return;
      }
      case 'lasso':
        live.current.lasso!.push(p);
        return;
      case 'quick':
        live.current.quick!.push(p);
        return;
      case 'stroke': {
        const s = live.current.stroke!;
        const settings = st.brush;
        const last = s.points[s.points.length - 1]!;
        // Stabilizer: the stroke follows the pointer with some lag, smoothing jitter.
        const k = 1 - Math.min(0.95, (s.tool === 'brush' ? settings.stabilizer : 0.1) * 0.9);
        const pressure = curvedPressure(e.nativeEvent, pressureGamma);
        const events = (e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]).map((ev) => toDoc(ev));
        let prev = last;
        for (const q of events) {
          const sp = { x: prev.x + (q.x - prev.x) * k, y: prev.y + (q.y - prev.y) * k, pressure };
          s.points.push(sp);
          prev = sp;
        }
        return;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const st = ed.getState();
    const p = toDoc(e);
    switch (d.kind) {
      case 'move':
        if (Math.hypot(p.x - d.start.x, p.y - d.start.y) > 0.5) api.commitTransient('Move layer');
        else api.clearTransient(d.layerId);
        return;
      case 'scale':
        api.commitTransient('Resize layer');
        return;
      case 'rect': {
        const r = live.current.rect!;
        live.current.rect = null;
        const x = Math.min(r.x, r.x + r.width);
        const y = Math.min(r.y, r.y + r.height);
        const w = Math.abs(r.width);
        const h = Math.abs(r.height);
        if (r.kind === 'object') {
          if (w < 4 || h < 4) return;
          void (async () => {
            st.set({ busy: t('image.working') });
            try {
              const m = await runImaging<Mask>('objectSelect', { raster: samplingRaster(), box: { x, y, width: w, height: h } });
              await maskSelection(m, t('image.working'));
            } catch (err) {
              toast.error((err as Error).message);
            } finally {
              st.set({ busy: null });
            }
          })();
          return;
        }
        if (w < 1 || h < 1) {
          if (st.select.mode === 'replace') setSelection(null);
          return;
        }
        void applySelection({ kind: r.kind === 'ellipse' ? 'ellipse' : 'rect', x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
        return;
      }
      case 'shape': {
        const r = live.current.rect!;
        live.current.rect = null;
        const x = Math.min(r.x, r.x + r.width);
        const y = Math.min(r.y, r.y + r.height);
        const w = Math.max(2, Math.abs(r.width));
        const h = Math.max(2, Math.abs(r.height));
        const sh = st.shape;
        const shape: VectorShape =
          sh.kind === 'line'
            ? { id: newId('shp'), kind: 'line', x: 0, y: 0, width: w, height: h, points: [{ x: r.width < 0 ? w : 0, y: r.height < 0 ? h : 0 }, { x: r.width < 0 ? 0 : w, y: r.height < 0 ? 0 : h }], fill: null, stroke: sh.stroke ?? st.color, strokeWidth: Math.max(1, sh.strokeWidth) }
            : { id: newId('shp'), kind: sh.kind, x: 0, y: 0, width: w, height: h, ...(sh.radius ? { radius: sh.radius } : {}), fill: sh.fill, stroke: sh.stroke, strokeWidth: sh.strokeWidth };
        const node = makeNode('layer', defaultLayerProps('vector', { name: t(`image.shapeKinds.${sh.kind === 'path' ? 'polygon' : sh.kind}` as 'image.shapeKinds.rect'), x: Math.round(x), y: Math.round(y), shapes: [shape] }));
        if (api.commit({ kind: 'create', parentId: canvasId, nodes: [node] }, 'Add shape')) {
          st.set({ selectedLayerId: node.id });
          api.select([node.id]);
        }
        return;
      }
      case 'lasso': {
        const pts = simplify(live.current.lasso!, 1.5 / st.zoom);
        live.current.lasso = null;
        if (pts.length < 3) {
          if (st.select.mode === 'replace') setSelection(null);
          return;
        }
        void applySelection({ kind: 'polygon', points: pts.map((q) => ({ x: Math.round(q.x * 10) / 10, y: Math.round(q.y * 10) / 10 })) });
        return;
      }
      case 'quick': {
        const pts = live.current.quick!;
        live.current.quick = null;
        void (async () => {
          st.set({ busy: t('image.working') });
          try {
            const m = await runImaging<Mask>('quickSelect', { raster: samplingRaster(), points: pts, radius: 10, tolerance: st.wand.tolerance + 8 });
            await maskSelection(m, t('image.working'));
          } catch (err) {
            toast.error((err as Error).message);
          } finally {
            st.set({ busy: null });
          }
        })();
        return;
      }
      case 'stroke': {
        const s = live.current.stroke!;
        live.current.stroke = null;
        const settings = s.tool === 'eraser' ? st.eraser : s.tool === 'brush' ? st.brush : st.clone;
        const target = targetRasterLayer();
        const tl = target.createOps.length ? (target.createOps[0] as { nodes: SceneNode<'layer'>[] }).nodes[0]!.props : (state.nodes[target.id] as SceneNode<'layer'>).props;
        const pts = simplify(s.points, 0.35).map((q) => {
          const lp = docToLayer(q, tl);
          return { x: Math.round(lp.x * 100) / 100, y: Math.round(lp.y * 100) / 100, pressure: Math.round(q.pressure * 1000) / 1000 };
        });
        const stroke: Stroke = {
          id: newId('st'),
          tool: s.tool as Stroke['tool'],
          color: s.tool === 'eraser' ? '#000000' : st.color,
          size: settings.size,
          hardness: settings.hardness,
          opacity: settings.opacity,
          tip: settings.tip,
          spacing: settings.spacing,
          points: pts,
          ...(cp.selection ? { clip: cp.selection } : {}),
          ...(s.tool === 'clone' || s.tool === 'heal' ? { sourceOffset: (() => { const src = docToLayer(st.clone.source!, tl); const first = pts[0]!; return { x: Math.round(src.x - first.x), y: Math.round(src.y - first.y) }; })() } : {}),
        };
        const op = { kind: 'listInsert' as const, id: target.id, prop: 'strokes', items: [stroke] };
        const ok = api.commit(target.createOps.length ? { kind: 'batch', ops: [...target.createOps, op] } : op, s.tool === 'eraser' ? 'Erase' : s.tool === 'brush' ? 'Paint' : s.tool === 'clone' ? 'Clone stamp' : 'Heal');
        if (ok && target.createOps.length) {
          st.set({ selectedLayerId: target.id });
          api.select([target.id]);
        }
        return;
      }
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const st = ed.getState();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, st.zoom * Math.exp(-e.deltaY * 0.0025));
    } else {
      st.set({ pan: { x: st.pan.x - (e.shiftKey ? e.deltaY : e.deltaX), y: st.pan.y - (e.shiftKey ? 0 : e.deltaY) } });
    }
  };

  const cursor = tool === 'hand' ? (drag.current?.kind === 'pan' ? 'grabbing' : 'grab') : tool === 'zoom' ? 'zoom-in' : tool === 'move' ? 'default' : tool === 'text' ? 'text' : ['brush', 'eraser', 'clone', 'heal'].includes(tool) ? 'none' : 'crosshair';
  const others = Object.values(presence).filter((p) => p.location?.tool === 'image' && p.location.nodeId === canvasId && p.location.x !== undefined);
  const textLayer = editingText ? (state.nodes[editingText] as SceneNode<'layer'> | undefined) : undefined;

  return (
    <div
      ref={containerRef}
      className="viewport"
      tabIndex={0}
      role="application"
      aria-label={`${cp.name}, ${cp.width} by ${cp.height} pixels. ${t(`image.tools.${tool}`)} tool.`}
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        live.current.cursor = null;
      }}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas
        ref={docRef}
        className="doc"
        style={{
          left: pan.x,
          top: pan.y,
          width: cp.width * zoom,
          height: cp.height * zoom,
          imageRendering: zoom >= 3 ? 'pixelated' : 'auto',
          background: cp.background ? undefined : 'repeating-conic-gradient(var(--checker-b) 0 25%, var(--checker-a) 0 50%) 0 0 / 16px 16px',
        }}
        aria-hidden="true"
      />
      <canvas ref={overlayRef} className="overlay" style={{ width: size.w, height: size.h }} aria-hidden="true" />
      {others.map((o) => (
        <div key={o.clientId} className="cursor-badge" style={{ left: pan.x + o.location!.x! * zoom, top: pan.y + o.location!.y! * zoom, background: o.color }}>
          {o.author.name}
        </div>
      ))}
      {textLayer && textLayer.props.layerType === 'text' && (
        <TextEditOverlay layer={textLayer} zoom={zoom} pan={pan} onDone={() => ed.getState().set({ editingTextLayer: null })} />
      )}
    </div>
  );
}

function TextEditOverlay({ layer, zoom, pan, onDone }: { layer: SceneNode<'layer'>; zoom: number; pan: Point; onDone: () => void }) {
  const store = useProjectStore();
  const p = layer.props;
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    // Focus after the pointer events that opened the editor have finished.
    const id = requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, []);
  const size = (p.fontSize ?? 48) * zoom * p.scaleY;
  return (
    <textarea
      ref={ref}
      aria-label="Edit text"
      defaultValue={p.text}
      style={{
        position: 'absolute',
        left: pan.x + p.x * zoom,
        top: pan.y + p.y * zoom,
        minWidth: 80,
        width: p.boxWidth ? p.boxWidth * zoom : undefined,
        font: `${p.fontWeight ?? 400} ${size}px ${p.fontFamily ?? 'Inter'}, sans-serif`,
        lineHeight: p.lineHeight ?? 1.2,
        color: p.color,
        background: 'rgba(255,255,255,0.05)',
        border: '1px dashed #3b5bdb',
        outline: 'none',
        resize: 'both',
        padding: 0,
        margin: 0,
        overflow: 'hidden',
        whiteSpace: 'pre',
        zIndex: 6,
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => store.getState().setTransient(layer.id, { text: e.target.value })}
      onBlur={() => {
        store.getState().commitTransient('Edit text');
        onDone();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) (e.target as HTMLTextAreaElement).blur();
      }}
    />
  );
}

export function selectionOf(state: ProjectState, canvasId: string): Selection | null {
  return (state.nodes[canvasId] as SceneNode<'canvas'>).props.selection;
}

export { invertMask, parseColor };
