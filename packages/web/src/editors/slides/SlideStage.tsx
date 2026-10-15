import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { SceneNode, SlideElementProps } from '@omnix/core';
import { makeNode, slideElements } from '@omnix/core';
import { BUILT, defaultFontSize, renderSlide } from '@omnix/render';
import { useProject } from '../../state/project.js';
import { PinLayer, useAnchoredComments } from '../../components/CommentPins.js';
import { t } from '../../i18n/index.js';
import { useHostVersion, useRenderHost } from '../../render/context.js';
import type { ProjectStore } from '../../state/project.js';
import type { SlidesEditorStore } from './slidesState.js';
import type { AssetSummary } from '../../lib/api.js';

export interface SlidesCtx {
  store: ProjectStore;
  ed: SlidesEditorStore;
  deckId: string;
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rot';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

interface Drag {
  kind: 'move' | 'resize' | 'rotate';
  handle?: Handle;
  startX: number;
  startY: number;
  orig: Record<string, Pick<SlideElementProps, 'x' | 'y' | 'w' | 'h' | 'rotation'>>;
  moved: boolean;
}

export const ASSET_DRAG = 'application/x-omnix-asset';

/** Add an element from an asset (image or video), fitted inside the slide. */
export function addAssetElement(ctx: SlidesCtx, a: AssetSummary, at?: { x: number; y: number }): string | null {
  const s = ctx.store.getState();
  const deck = s.state!.nodes[ctx.deckId] as SceneNode<'deck'>;
  const slideId = ctx.ed.getState().slideId;
  if (!slideId) return null;
  const W = deck.props.width;
  const H = deck.props.height;
  const aw = a.width ?? W / 2;
  const ah = a.height ?? H / 2;
  const fit = Math.min((W * 0.6) / aw, (H * 0.6) / ah, 1);
  const w = Math.round(aw * fit);
  const h = Math.round(ah * fit);
  const node = makeNode('slideElement', { elementType: a.kind === 'video' ? 'video' : 'image', role: null, assetId: a.id, w, h, x: Math.round((at?.x ?? W / 2) - w / 2), y: Math.round((at?.y ?? H / 2) - h / 2) });
  if (!s.commit({ kind: 'create', parentId: slideId, nodes: [node] }, a.kind === 'video' ? 'Add video' : 'Add image')) return null;
  ctx.ed.getState().set({ selected: [node.id], inspectorTab: 'element' });
  return node.id;
}

export function SlideStage({ ctx }: { ctx: SlidesCtx }) {
  const host = useRenderHost();
  const hv = useHostVersion();
  const state = useProject((s) => s.state)!;
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  const slideId = useStore(ctx.ed, (s) => s.slideId);
  const selected = useStore(ctx.ed, (s) => s.selected);
  const editingText = useStore(ctx.ed, (s) => s.editingText);
  const preview = useStore(ctx.ed, (s) => s.preview);
  const commentMode = useProject((s) => s.commentMode);
  const presence = useProject((s) => s.presence);
  const [composer, setComposer] = useState<{ x: number; y: number } | null>(null);
  const pinComments = useAnchoredComments(slideId ? [slideId] : [], (a) => a.x !== undefined && a.y !== undefined);
  const lastReport = useRef(0);
  const wrap = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const drag = useRef<Drag | null>(null);
  const deck = state.nodes[ctx.deckId] as SceneNode<'deck'>;
  const slide = slideId ? (state.nodes[slideId] as SceneNode<'slide'> | undefined) : undefined;
  const W = deck.props.width;
  const H = deck.props.height;
  const k = box.w ? Math.min((box.w - 48) / W, (box.h - 48) / H) : 0;
  const ox = (box.w - W * k) / 2;
  const oy = (box.h - H * k) / 2;
  const els = slide ? slideElements(state, slide.id) : [];

  useLayoutEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Render (and keep rendering while a build preview plays).
  useEffect(() => {
    if (!slide || !k) return;
    let raf = 0;
    const draw = () => {
      const c = canvasRef.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const playhead = preview ? { step: preview.step, t: (performance.now() - preview.startedAt) / 1000 } : BUILT;
      const out = renderSlide(host, state, slide.id, { scale: k * dpr, playhead, ...(editingText ? { skipElements: new Set([editingText]) } : {}) });
      if (c.width !== out.width || c.height !== out.height) {
        c.width = out.width;
        c.height = out.height;
      }
      c.getContext('2d')!.drawImage(out as unknown as CanvasImageSource, 0, 0);
      if (preview && performance.now() - preview.startedAt < 8000) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [state, slide?.id, k, hv, preview, editingText, host]);

  const toSlide = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - ox) / k, y: (e.clientY - r.top - oy) / k };
  };

  const select = (id: string, additive: boolean) => {
    const cur = ctx.ed.getState().selected;
    ctx.ed.getState().set({ selected: additive ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : cur.includes(id) ? cur : [id], inspectorTab: 'element' });
  };

  const begin = (e: React.PointerEvent, id: string, kind: Drag['kind'], handle?: Handle) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    if (kind === 'move') select(id, e.shiftKey);
    if (!canEdit) return;
    const ids = kind === 'move' ? (ctx.ed.getState().selected.includes(id) ? ctx.ed.getState().selected : [id]) : [id];
    const orig: Drag['orig'] = {};
    for (const x of ids) {
      const p = (state.nodes[x] as SceneNode<'slideElement'>).props;
      orig[x] = { x: p.x, y: p.y, w: p.w, h: p.h, rotation: p.rotation };
    }
    drag.current = { kind, ...(handle ? { handle } : {}), startX: e.clientX, startY: e.clientY, orig, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  /** Snap a box edge/centre to the slide's edges and centre and to other elements. */
  const snapTargets = (exclude: Set<string>) => {
    const xs = [0, W / 2, W];
    const ys = [0, H / 2, H];
    for (const el of els) {
      if (exclude.has(el.id)) continue;
      const p = el.props;
      xs.push(p.x, p.x + p.w / 2, p.x + p.w);
      ys.push(p.y, p.y + p.h / 2, p.y + p.h);
    }
    return { xs, ys };
  };
  const snap1 = (vals: number[], targets: number[]) => {
    const tol = 6 / k;
    let best: { d: number; delta: number; at: number } | null = null;
    for (const v of vals) for (const t of targets) if (Math.abs(t - v) < tol && (!best || Math.abs(t - v) < Math.abs(best.d))) best = { d: t - v, delta: t - v, at: t };
    return best;
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / k;
    const dy = (e.clientY - d.startY) / k;
    if (!d.moved && Math.hypot(dx * k, dy * k) < 3) return;
    d.moved = true;
    const s = ctx.store.getState();
    const ids = Object.keys(d.orig);
    if (d.kind === 'move') {
      // Snap using the bounding box of the moving elements.
      const bx = Math.min(...ids.map((i) => d.orig[i]!.x)) + dx;
      const by = Math.min(...ids.map((i) => d.orig[i]!.y)) + dy;
      const bw = Math.max(...ids.map((i) => d.orig[i]!.x + d.orig[i]!.w)) + dx - bx;
      const bh = Math.max(...ids.map((i) => d.orig[i]!.y + d.orig[i]!.h)) + dy - by;
      const t = snapTargets(new Set(ids));
      const sx = e.altKey ? null : snap1([bx, bx + bw / 2, bx + bw], t.xs);
      const sy = e.altKey ? null : snap1([by, by + bh / 2, by + bh], t.ys);
      setGuides({ x: sx ? [sx.at] : [], y: sy ? [sy.at] : [] });
      for (const i of ids) s.setTransient(i, { x: Math.round(d.orig[i]!.x + dx + (sx?.delta ?? 0)), y: Math.round(d.orig[i]!.y + dy + (sy?.delta ?? 0)) });
      return;
    }
    const id = ids[0]!;
    const o = d.orig[id]!;
    if (d.kind === 'rotate') {
      const p = toSlide(e);
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      let deg = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      s.setTransient(id, { rotation: Math.round(((deg + 540) % 360) - 180) });
      return;
    }
    const h = d.handle!;
    let { x, y, w, h: hh } = o;
    if (h.includes('e')) w = Math.max(10, o.w + dx);
    if (h.includes('s')) hh = Math.max(10, o.h + dy);
    if (h.includes('w')) {
      w = Math.max(10, o.w - dx);
      x = o.x + o.w - w;
    }
    if (h.includes('n')) {
      hh = Math.max(10, o.h - dy);
      y = o.y + o.h - hh;
    }
    if (e.shiftKey && h.length === 2) {
      // Keep proportions from the corner.
      const ratio = o.w / o.h;
      if (w / hh > ratio) w = hh * ratio;
      else hh = w / ratio;
      if (h.includes('w')) x = o.x + o.w - w;
      if (h.includes('n')) y = o.y + o.h - hh;
    }
    s.setTransient(id, { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(hh) });
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    setGuides({ x: [], y: [] });
    if (!d) return;
    const s = ctx.store.getState();
    if (!d.moved) {
      s.clearTransient();
      return;
    }
    s.commitTransient(d.kind === 'move' ? 'Move element' : d.kind === 'rotate' ? 'Rotate element' : 'Resize element');
  };

  if (!slide) return <div ref={wrap} className="slide-stage empty">No slide selected.</div>;
  const editing = editingText ? (state.nodes[editingText] as SceneNode<'slideElement'> | undefined) : undefined;
  return (
    <div
      ref={wrap}
      className={`slide-stage${commentMode ? ' commenting' : ''}`}
      onPointerDownCapture={(e) => {
        if (!commentMode || e.button !== 0 || (e.target as HTMLElement).closest('.pin-layer')) return;
        e.stopPropagation();
        e.preventDefault();
        const p = toSlide(e);
        if (p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H) setComposer({ x: Math.round(p.x), y: Math.round(p.y) });
      }}
      onPointerDown={() => ctx.ed.getState().set({ selected: [], editingText: null })}
      onPointerMove={(e) => {
        // Collaborators see where you point on this slide.
        const now = performance.now();
        if (now - lastReport.current > 80) {
          lastReport.current = now;
          const p = toSlide(e);
          if (p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H) ctx.store.getState().reportLocation({ tool: 'slides', nodeId: slide.id, x: Math.round(p.x), y: Math.round(p.y) });
        }
        onMove(e);
      }}
      onPointerUp={onUp}
      onDragOver={(e) => e.dataTransfer.types.includes(ASSET_DRAG) && e.preventDefault()}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData(ASSET_DRAG);
        if (!raw || !canEdit) return;
        e.preventDefault();
        addAssetElement(ctx, JSON.parse(raw) as AssetSummary, toSlide(e));
      }}
    >
      <canvas ref={canvasRef} className="slide-canvas" style={{ left: ox, top: oy, width: W * k, height: H * k }} role="img" aria-label={`Slide ${slide.props.name}`} />
      <div className="slide-overlay" style={{ left: ox, top: oy, width: W * k, height: H * k }}>
        {els.map((el) => {
          const p = el.props;
          const sel = selected.includes(el.id);
          const label = p.elementType === 'text' ? (p.text ?? '').split('\n')[0]!.slice(0, 40) || 'Text' : p.elementType;
          return (
            <div
              key={el.id}
              className={`el-box${sel ? ' selected' : ''}`}
              style={{ left: p.x * k, top: p.y * k, width: p.w * k, height: p.h * k, transform: p.rotation ? `rotate(${p.rotation}deg)` : undefined }}
              role="button"
              tabIndex={0}
              aria-label={`${p.role ?? p.elementType} element: ${label}`}
              aria-pressed={sel}
              onPointerDown={(e) => begin(e, el.id, 'move')}
              onDoubleClick={() => canEdit && p.elementType === 'text' && ctx.ed.getState().set({ editingText: el.id, selected: [el.id] })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && p.elementType === 'text' && canEdit) {
                  e.preventDefault();
                  ctx.ed.getState().set({ editingText: el.id, selected: [el.id] });
                }
              }}
              onFocus={() => !sel && select(el.id, false)}
            >
              {sel && selected.length === 1 && canEdit && editingText !== el.id && (
                <>
                  {HANDLES.map((h) => (
                    <span key={h} className={`el-handle h-${h}`} onPointerDown={(e) => begin(e, el.id, 'resize', h)} aria-hidden="true" />
                  ))}
                  <span className="el-handle h-rot" onPointerDown={(e) => begin(e, el.id, 'rotate', 'rot')} aria-hidden="true" />
                </>
              )}
            </div>
          );
        })}
        {guides.x.map((x, i) => (
          <div key={`gx${i}`} className="snap-guide v" style={{ left: x * k }} />
        ))}
        {guides.y.map((y, i) => (
          <div key={`gy${i}`} className="snap-guide h" style={{ top: y * k }} />
        ))}
        {editing && <TextEditor ctx={ctx} el={editing} k={k} deck={deck} />}
        {Object.values(presence)
          .filter((o) => o.location?.tool === 'slides' && o.location.nodeId === slide.id && o.location.x !== undefined)
          .map((o) => (
            <div key={o.clientId} className="cursor-badge" style={{ left: o.location!.x! * k, top: o.location!.y! * k, background: o.color }}>
              {o.author.name}
            </div>
          ))}
        <PinLayer
          label={t('comments.title')}
          pins={pinComments.map((c) => ({ comment: c, x: c.props.anchor.x! * k, y: c.props.anchor.y! * k }))}
          composer={composer ? { x: composer.x * k, y: composer.y * k, anchor: { tool: 'slides', nodeId: slide.id, x: composer.x, y: composer.y } } : null}
          onCompose={() => setComposer(null)}
          onCancelCompose={() => setComposer(null)}
        />
      </div>
    </div>
  );
}

/** Edit a text element in place: a textarea matching the element's font, size and colour. */
function TextEditor({ ctx, el, k, deck }: { ctx: SlidesCtx; el: SceneNode<'slideElement'>; k: number; deck: SceneNode<'deck'> }) {
  const p = el.props;
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const t = ref.current!;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, []);
  const heading = p.role === 'title' || p.role === 'subtitle';
  const theme = deck.props.theme;
  const size = defaultFontSize(p, deck.props) * k;
  const done = () => {
    ctx.store.getState().commitTransient('Edit text');
    ctx.ed.getState().set({ editingText: null });
  };
  return (
    <textarea
      ref={ref}
      className="el-text-editor"
      aria-label="Slide text. Markdown works: - for bullets, ** for bold."
      defaultValue={p.text ?? ''}
      style={{
        left: p.x * k,
        top: p.y * k,
        width: p.w * k,
        height: Math.max(p.h * k, size * 1.6),
        transform: p.rotation ? `rotate(${p.rotation}deg)` : undefined,
        fontFamily: `"${p.fontFamily ?? (heading ? theme.fonts.heading : theme.fonts.body)}", Inter, sans-serif`,
        fontSize: size,
        fontWeight: p.bold || p.role === 'title' ? 700 : 400,
        lineHeight: heading ? 1.15 : 1.4,
        textAlign: p.align ?? 'left',
        color: p.color ?? theme.colors.text,
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => ctx.store.getState().setTransient(el.id, { text: e.target.value })}
      onBlur={done}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) (e.target as HTMLTextAreaElement).blur();
      }}
    />
  );
}
