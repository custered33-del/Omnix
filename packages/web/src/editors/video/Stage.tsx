import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { Point, SceneNode } from '@omnix/core';
import { renderSequenceFrame } from '@omnix/render';
import { useProject } from '../../state/project.js';
import { PinLayer, useAnchoredComments } from '../../components/CommentPins.js';
import { t } from '../../i18n/index.js';
import { useHostVersion, useRenderHost } from '../../render/context.js';
import type { TimelineCtx } from './timelineOps.js';

export interface StageGeometry {
  /** Displayed scale: screen px per sequence px. */
  k: number;
  ox: number;
  oy: number;
}

export interface StageHandlers {
  onDown?: (p: Point, e: React.PointerEvent) => void;
  onMove?: (p: Point, e: React.PointerEvent) => void;
  onUp?: (p: Point, e: React.PointerEvent) => void;
  /** Draw editor overlays in sequence coordinates (the context is pre-transformed). */
  overlay?: (g: CanvasRenderingContext2D, geo: StageGeometry) => void;
  cursor?: string;
}

/**
 * The preview stage shared by the video editor and the animation maker: renders the frame at
 * the playhead with the shared renderer and maps pointer input into sequence coordinates.
 */
export function Stage({ ctx, handlers, editor, label, children }: { ctx: TimelineCtx; handlers?: StageHandlers; editor?: { onionSkin?: boolean; showBones?: boolean }; label: string; children?: ReactNode }) {
  const host = useRenderHost();
  const hostVersion = useHostVersion();
  const state = useProject((s) => s.state)!;
  const time = useStore(ctx.ed, (s) => s.time);
  const playing = useStore(ctx.ed, (s) => s.playing);
  const seq = state.nodes[ctx.sequenceId] as SceneNode<'sequence'>;
  const sp = seq.props;
  const commentMode = useProject((s) => s.commentMode);
  const presence = useProject((s) => s.presence);
  const lastReport = useRef(0);
  const [composer, setComposer] = useState<{ x: number; y: number; time: number } | null>(null);
  // Comments pinned on the frame show around the moment they were made.
  const pinComments = useAnchoredComments([ctx.sequenceId], (a) => a.x !== undefined && a.y !== undefined && (a.time === undefined || Math.abs(a.time - time) <= 0.5));
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const slowFrames = useRef(0);

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const k = box.w && box.h ? Math.min((box.w - 24) / sp.width, (box.h - 24) / sp.height) : 0;
  const dispW = Math.max(1, Math.round(sp.width * k));
  const dispH = Math.max(1, Math.round(sp.height * k));
  const geo: StageGeometry = { k, ox: (box.w - dispW) / 2, oy: (box.h - dispH) / 2 };

  useEffect(() => {
    if (!k) return;
    const raf = requestAnimationFrame(() => {
      const c = canvasRef.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const scale = Math.min(1, (dispW * dpr) / sp.width);
      const t0 = performance.now();
      // Drop expensive effects while playing on slow machines to hold the frame rate.
      const draft = playing && slowFrames.current > 3;
      const out = renderSequenceFrame(host, state, ctx.sequenceId, time, { scale, draft, ...(editor ? { editor } : {}) });
      const took = performance.now() - t0;
      slowFrames.current = took > 28 ? slowFrames.current + 1 : Math.max(0, slowFrames.current - 1);
      if (c.width !== out.width || c.height !== out.height) {
        c.width = out.width;
        c.height = out.height;
      }
      const g = c.getContext('2d')!;
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(out as unknown as CanvasImageSource, 0, 0);
      drawOverlay();
    });
    return () => cancelAnimationFrame(raf);
  });

  const drawOverlay = () => {
    const o = overlayRef.current;
    if (!o || !handlers?.overlay) return;
    const dpr = window.devicePixelRatio || 1;
    if (o.width !== box.w * dpr || o.height !== box.h * dpr) {
      o.width = box.w * dpr;
      o.height = box.h * dpr;
    }
    const g = o.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, o.width, o.height);
    g.setTransform(dpr * k, 0, 0, dpr * k, dpr * geo.ox, dpr * geo.oy);
    handlers.overlay(g, geo);
  };
  void hostVersion;

  const toSeq = (e: { clientX: number; clientY: number }): Point => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - geo.ox) / k, y: (e.clientY - r.top - geo.oy) / k };
  };

  return (
    <div
      ref={wrapRef}
      className="tl-stage"
      role="img"
      aria-label={label}
      style={{ cursor: commentMode ? 'copy' : (handlers?.cursor ?? 'default') }}
      onPointerDown={(e) => {
        if (commentMode && e.button === 0) {
          if ((e.target as HTMLElement).closest('.pin-layer')) return;
          const p = toSeq(e);
          if (p.x >= 0 && p.y >= 0 && p.x <= sp.width && p.y <= sp.height) setComposer({ x: Math.round(p.x), y: Math.round(p.y), time: Math.round(time * 100) / 100 });
          return;
        }
        if (!handlers?.onDown || e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        handlers.onDown(toSeq(e), e);
        drawOverlay();
      }}
      onPointerMove={(e) => {
        const p = toSeq(e);
        handlers?.onMove?.(p, e);
        drawOverlay();
        // Share the pointer with collaborators (a few times a second is plenty).
        const now = performance.now();
        if (now - lastReport.current > 80 && p.x >= 0 && p.y >= 0 && p.x <= sp.width && p.y <= sp.height) {
          lastReport.current = now;
          ctx.store.getState().reportLocation({ tool: sp.purpose === 'animation' ? 'animation' : 'video', nodeId: ctx.sequenceId, x: Math.round(p.x), y: Math.round(p.y), time: Math.round(time * 100) / 100 });
        }
      }}
      onPointerUp={(e) => {
        handlers?.onUp?.(toSeq(e), e);
        drawOverlay();
      }}
    >
      <canvas ref={canvasRef} className="frame" style={{ width: dispW, height: dispH, position: 'absolute', left: geo.ox, top: geo.oy, background: 'transparent' }} aria-hidden="true" />
      <canvas ref={overlayRef} className="overlay" style={{ width: box.w, height: box.h }} aria-hidden="true" />
      {Object.values(presence)
        .filter((o) => o.location?.nodeId === ctx.sequenceId && o.location.x !== undefined && o.location.y !== undefined)
        .map((o) => (
          <div key={o.clientId} className="cursor-badge" style={{ left: geo.ox + o.location!.x! * k, top: geo.oy + o.location!.y! * k, background: o.color }}>
            {o.author.name}
          </div>
        ))}
      <PinLayer
        label={t('comments.title')}
        pins={pinComments.map((c) => ({ comment: c, x: geo.ox + c.props.anchor.x! * k, y: geo.oy + c.props.anchor.y! * k }))}
        composer={composer ? { x: geo.ox + composer.x * k, y: geo.oy + composer.y * k, anchor: { tool: sp.purpose === 'animation' ? 'animation' : 'video', nodeId: ctx.sequenceId, x: composer.x, y: composer.y, time: composer.time } } : null}
        onCompose={() => setComposer(null)}
        onCancelCompose={() => setComposer(null)}
      />
      {children}
    </div>
  );
}
