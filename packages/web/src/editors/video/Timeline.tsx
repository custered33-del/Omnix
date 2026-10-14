import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Eye, EyeOff, Lock, LockOpen, Volume2, VolumeX, Headphones, Plus, Film, Music, Type, Sparkles, Shapes, MoreHorizontal } from 'lucide-react';
import type { Operation, ProjectState, SceneNode, TrackType } from '@omnix/core';
import { childrenOf, clipDuration, clipEnd, clipsOf, moveClipOp, rippleTrimOp, rollEditOp, slideEditOp, slipEditOp, splitClipOp, trimOp, tracksOf } from '@omnix/core';
import { useProject } from '../../state/project.js';
import { useRenderHost } from '../../render/context.js';
import { thumbUrl, type AssetSummary } from '../../lib/api.js';
import { Menu, MenuButton, type MenuItemDef } from '../../ui/primitives.js';
import { t } from '../../i18n/index.js';
import { toFrame } from './timelineState.js';
import { addAssetClip, addTrack, commitOp, deleteSelected, duplicateSelected, previewOp, snap, snapPoints, splitAtPlayhead, TRACK_COLORS, TRACK_HEIGHT, tryOp, type TimelineCtx } from './timelineOps.js';

const RULER = 26;
export const ASSET_MIME = 'application/x-omnix-asset';

const TRACK_ICON: Record<TrackType, typeof Film> = { video: Film, audio: Music, title: Type, effect: Sparkles, animation: Shapes };

interface DragState {
  kind: 'move' | 'trim-l' | 'trim-r' | 'slip' | 'slide' | 'roll' | 'layer-move' | 'layer-l' | 'layer-r' | 'scrub';
  id: string;
  startX: number;
  startY: number;
  base: ProjectState;
  /** Other selected clips that move along. */
  group: string[];
  neighbour?: string;
  moved: boolean;
  targetTrack?: string;
}

/** Choose a tick spacing that keeps labels about 80px apart. */
function tickStep(pps: number, fps: number): { major: number; minor: number } {
  const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const major = steps.find((s) => s * pps >= 80) ?? 600;
  const minor = steps.slice().reverse().find((s) => s < major && s * pps >= 10) ?? major;
  return { major, minor };
}

function fmtRuler(t: number, step: number, fps: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  if (step < 1) return `${m}:${String(s).padStart(2, '0')}:${String(Math.round((t % 1) * fps)).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function Timeline({ ctx }: { ctx: TimelineCtx }) {
  const { ed, store, sequenceId } = ctx;
  const state = useProject((s) => s.state)!;
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  const seq = state.nodes[sequenceId] as SceneNode<'sequence'>;
  const fps = seq.props.fps;
  const pps = useStore(ed, (s) => s.pxPerSec);
  const time = useStore(ed, (s) => s.time);
  const selected = useStore(ed, (s) => s.selectedClips);
  const selectedTrack = useStore(ed, (s) => s.selectedTrack);
  const mode = useStore(ed, (s) => s.mode);
  const snapping = useStore(ed, (s) => s.snapping);
  const solo = useStore(ed, (s) => s.soloTracks);
  const host = useRenderHost();
  const lanesRef = useRef<HTMLDivElement>(null);
  const headsRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<DragState | null>(null);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [dropTrack, setDropTrack] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItemDef[] } | null>(null);
  const [viewW, setViewW] = useState(800);
  const [scrollX, setScrollX] = useState(0);

  const tracks = tracksOf(state, sequenceId);
  const contentEnd = Math.max(seq.props.duration, ...tracks.flatMap((tr) => childrenOf(state, tr.id).map((n) => (n.type === 'clip' ? clipEnd((n as SceneNode<'clip'>).props) : n.type === 'animLayer' ? (n as SceneNode<'animLayer'>).props.start + (n as SceneNode<'animLayer'>).props.duration : 0))));
  const totalW = Math.max(viewW, (contentEnd + (seq.props.purpose === 'video' ? 20 : 2)) * pps);
  const xOf = (t: number) => t * pps;
  const timeAt = (clientX: number) => {
    const r = lanesRef.current!.getBoundingClientRect();
    return Math.max(0, (clientX - r.left + lanesRef.current!.scrollLeft) / pps);
  };

  useLayoutEffect(() => {
    const el = lanesRef.current!;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ruler
  useEffect(() => {
    const c = rulerRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = viewW * dpr;
    c.height = RULER * dpr;
    c.style.width = `${viewW}px`;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, viewW, RULER);
    const styles = getComputedStyle(c);
    g.strokeStyle = styles.getPropertyValue('--border-strong') || '#999';
    g.fillStyle = styles.getPropertyValue('--muted') || '#777';
    g.font = '11px Inter, sans-serif';
    const { major, minor } = tickStep(pps, fps);
    const t0 = Math.floor(scrollX / pps / minor) * minor;
    for (let tt = t0; tt * pps - scrollX < viewW; tt += minor) {
      const x = Math.round(tt * pps - scrollX) + 0.5;
      const isMajor = Math.abs(tt / major - Math.round(tt / major)) < 1e-6;
      g.beginPath();
      g.moveTo(x, isMajor ? 10 : 18);
      g.lineTo(x, RULER);
      g.stroke();
      if (isMajor) g.fillText(fmtRuler(tt, major, fps), x + 3, 10);
    }
  }, [pps, scrollX, viewW, fps]);

  // Keep the playhead visible while playing.
  const playing = useStore(ed, (s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    const el = lanesRef.current!;
    const x = xOf(time);
    if (x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - 80;
  }, [time, playing]);

  const select = (id: string, additive: boolean) => {
    const cur = ed.getState().selectedClips;
    ed.getState().set({ selectedClips: additive ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id], inspectorTab: 'clip' });
  };

  /* ---------------- pointer interactions ---------------- */
  const beginClip = (e: React.PointerEvent, clip: SceneNode<'clip'>, part: 'body' | 'l' | 'r') => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const track = state.nodes[clip.parentId!] as SceneNode<'track'>;
    if (!e.shiftKey && !selected.includes(clip.id)) select(clip.id, false);
    else if (e.shiftKey) select(clip.id, true);
    if (!canEdit || track.props.locked) return;
    const st = ed.getState();
    if (st.mode === 'razor' && part === 'body') {
      const tt = toFrame(timeAt(e.clientX), fps);
      const op = tryOp(() => splitClipOp(state, clip.id, tt));
      if (op) store.getState().commit(op, 'Split clip');
      return;
    }
    let kind: DragState['kind'] = 'move';
    let neighbour: string | undefined;
    if (part !== 'body') {
      kind = part === 'l' ? 'trim-l' : 'trim-r';
      if (st.mode === 'roll') {
        const clips = clipsOf(state, track.id);
        const i = clips.findIndex((x) => x.id === clip.id);
        const other = part === 'l' ? clips[i - 1] : clips[i + 1];
        const adjacent = other && (part === 'l' ? Math.abs(clipEnd(other.props) - clip.props.start) < 1e-3 : Math.abs(clipEnd(clip.props) - other.props.start) < 1e-3);
        if (adjacent) {
          kind = 'roll';
          neighbour = other!.id;
        }
      }
    } else if (st.mode === 'slip') kind = 'slip';
    else if (st.mode === 'slide') kind = 'slide';
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind, id: clip.id, startX: e.clientX, startY: e.clientY, base: state, group: st.selectedClips.includes(clip.id) ? st.selectedClips : [clip.id], moved: false, ...(neighbour ? { neighbour } : {}) };
  };

  const beginLayer = (e: React.PointerEvent, layer: SceneNode<'animLayer'>, part: 'body' | 'l' | 'r') => {
    e.stopPropagation();
    if (e.button !== 0) return;
    ed.getState().set({ selectedClips: [layer.id], inspectorTab: 'clip' });
    if (!canEdit) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind: part === 'body' ? 'layer-move' : part === 'l' ? 'layer-l' : 'layer-r', id: layer.id, startX: e.clientX, startY: e.clientY, base: state, group: [layer.id], moved: false };
  };

  const buildOp = (d: DragState, e: { clientX: number; clientY: number }): { op: Operation | null; snapTo: number | null } => {
    const st = ed.getState();
    let dt = (e.clientX - d.startX) / pps;
    const node = d.base.nodes[d.id]!;
    const pts = st.snapping ? snapPoints(d.base, sequenceId, st.time, new Set(d.group)) : [];
    const snapEdge = (edgeTime: number) => {
      if (!st.snapping) return { dt: toFrame(edgeTime + dt, fps) - edgeTime, to: null };
      const s = snap(edgeTime + dt, pts, pps);
      return { dt: (s.to !== null ? s.t : toFrame(edgeTime + dt, fps)) - edgeTime, to: s.to };
    };
    try {
      if (node.type === 'animLayer') {
        const p = (node as SceneNode<'animLayer'>).props;
        if (d.kind === 'layer-move') {
          const a = snapEdge(p.start);
          return { op: { kind: 'update', id: d.id, set: { start: Math.max(0, p.start + a.dt) } }, snapTo: a.to };
        }
        if (d.kind === 'layer-r') {
          const a = snapEdge(p.start + p.duration);
          return { op: { kind: 'update', id: d.id, set: { duration: Math.max(1 / fps, p.duration + a.dt) } }, snapTo: a.to };
        }
        const a = snapEdge(p.start);
        const ndt = Math.min(a.dt, p.duration - 1 / fps);
        return { op: { kind: 'update', id: d.id, set: { start: Math.max(0, p.start + ndt), duration: p.duration - ndt } }, snapTo: a.to };
      }
      const p = (node as SceneNode<'clip'>).props;
      switch (d.kind) {
        case 'move': {
          const a = snapEdge(p.start);
          const b = st.snapping ? snapEdge(clipEnd(p)) : a;
          const use = b.to !== null && (a.to === null || Math.abs(b.dt - dt) < Math.abs(a.dt - dt)) ? b : a;
          dt = use.dt;
          const ops: Operation[] = [];
          for (const id of d.group) {
            const n = d.base.nodes[id];
            if (!n || n.type !== 'clip') continue;
            const cp = (n as SceneNode<'clip'>).props;
            ops.push(moveClipOp(d.base, id, Math.max(0, cp.start + dt), id === d.id && d.targetTrack && d.group.length === 1 ? d.targetTrack : undefined));
          }
          return { op: ops.length === 1 ? ops[0]! : { kind: 'batch', ops }, snapTo: use.to };
        }
        case 'trim-l': {
          const a = snapEdge(p.start);
          return { op: st.mode === 'ripple' ? rippleTrimOp(d.base, d.id, 'in', a.dt) : trimOp(d.base, d.id, 'in', a.dt), snapTo: a.to };
        }
        case 'trim-r': {
          const a = snapEdge(clipEnd(p));
          return { op: st.mode === 'ripple' ? rippleTrimOp(d.base, d.id, 'out', a.dt) : trimOp(d.base, d.id, 'out', a.dt), snapTo: a.to };
        }
        case 'roll': {
          const other = (d.base.nodes[d.neighbour!] as SceneNode<'clip'>).props;
          const isRight = other.start < p.start;
          const a = snapEdge(isRight ? p.start : clipEnd(p));
          return { op: isRight ? rollEditOp(d.base, d.neighbour!, d.id, a.dt) : rollEditOp(d.base, d.id, d.neighbour!, a.dt), snapTo: a.to };
        }
        case 'slip':
          return { op: slipEditOp(d.base, d.id, -toFrame(dt, fps)), snapTo: null };
        case 'slide': {
          const a = snapEdge(p.start);
          return { op: slideEditOp(d.base, d.id, a.dt), snapTo: a.to };
        }
        default:
          return { op: null, snapTo: null };
      }
    } catch {
      return { op: null, snapTo: null };
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'scrub') {
      ed.getState().set({ time: toFrame(timeAt(e.clientX), fps) });
      return;
    }
    if (!d.moved && Math.abs(e.clientX - d.startX) < 3 && Math.abs(e.clientY - d.startY) < 3) return;
    d.moved = true;
    if (d.kind === 'move') {
      // Find the lane under the pointer for cross-track moves (same kind of track only).
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-track]') as HTMLElement | null;
      const tid = el?.dataset.track;
      const from = d.base.nodes[d.base.nodes[d.id]!.parentId!] as SceneNode<'track'>;
      const to = tid ? (d.base.nodes[tid] as SceneNode<'track'> | undefined) : undefined;
      const compatible = to && !to.props.locked && (to.props.trackType === 'audio') === (from.props.trackType === 'audio') && to.props.trackType !== 'animation';
      d.targetTrack = compatible ? tid : undefined;
      setDropTrack(compatible && tid !== from.id ? tid! : null);
    }
    const { op, snapTo } = buildOp(d, e);
    // Cross-track moves cannot be previewed as prop overrides; the lane highlight shows the target.
    previewOp(ctx, op);
    setSnapLine(snapTo);
  };

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setSnapLine(null);
    setDropTrack(null);
    if (!d) return;
    if (d.kind === 'scrub') return;
    if (!d.moved) {
      store.getState().clearTransient();
      return;
    }
    const { op } = buildOp(d, e);
    const labels: Record<DragState['kind'], string> = { move: 'Move clip', 'trim-l': mode === 'ripple' ? 'Ripple trim' : 'Trim clip', 'trim-r': mode === 'ripple' ? 'Ripple trim' : 'Trim clip', roll: 'Roll edit', slip: 'Slip edit', slide: 'Slide edit', 'layer-move': 'Move layer', 'layer-l': 'Trim layer', 'layer-r': 'Trim layer', scrub: '' };
    commitOp(ctx, op, labels[d.kind]);
  };

  const onLaneDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    ed.getState().set({ selectedClips: [], time: toFrame(timeAt(e.clientX), fps) });
    drag.current = { kind: 'scrub', id: '', startX: e.clientX, startY: e.clientY, base: state, group: [], moved: true };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const clipMenu = (e: React.MouseEvent, clip: SceneNode<'clip'>) => {
    e.preventDefault();
    if (!selected.includes(clip.id)) select(clip.id, false);
    const p = clip.props;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: t('video.split'), shortcut: 'S', onSelect: () => splitAtPlayhead(ctx), disabled: !canEdit },
        { label: t('app.duplicate'), onSelect: () => duplicateSelected(ctx), disabled: !canEdit },
        { label: t('video.rippleDelete'), shortcut: 'Shift+Del', onSelect: () => deleteSelected(ctx, true), disabled: !canEdit },
        { label: t('app.delete'), shortcut: 'Del', onSelect: () => deleteSelected(ctx, false), danger: true, disabled: !canEdit },
        { separator: true, label: '' },
        { label: p.transitionIn ? 'Remove fade in' : 'Crossfade in', onSelect: () => store.getState().commit({ kind: 'update', id: clip.id, set: { transitionIn: p.transitionIn ? null : { kind: 'crossfade', duration: 0.5, easing: 'ease-in-out' } } }, 'Transition'), disabled: !canEdit },
        { label: p.transitionOut ? 'Remove fade out' : 'Crossfade out', onSelect: () => store.getState().commit({ kind: 'update', id: clip.id, set: { transitionOut: p.transitionOut ? null : { kind: 'crossfade', duration: 0.5, easing: 'ease-in-out' } } }, 'Transition'), disabled: !canEdit },
        { label: t('video.reverse'), onSelect: () => store.getState().commit({ kind: 'update', id: clip.id, set: { reverse: !p.reverse } }, 'Reverse clip'), disabled: !canEdit || !p.assetId },
        { label: 'Jump to clip start', onSelect: () => ed.getState().set({ time: p.start }) },
      ],
    });
  };

  const trackMenu = (track: SceneNode<'track'>): MenuItemDef[] => {
    const i = tracks.findIndex((x) => x.id === track.id);
    return [
      { label: 'Move up', disabled: i === 0 || !canEdit, onSelect: () => store.getState().commit({ kind: 'move', id: track.id, parentId: sequenceId, index: i - 1 }, 'Reorder tracks') },
      { label: 'Move down', disabled: i === tracks.length - 1 || !canEdit, onSelect: () => store.getState().commit({ kind: 'move', id: track.id, parentId: sequenceId, index: i + 1 }, 'Reorder tracks') },
      { separator: true, label: '' },
      { label: 'Delete track', danger: true, disabled: !canEdit, onSelect: () => store.getState().commit({ kind: 'delete', id: track.id }, `Delete ${track.props.name}`) },
    ];
  };

  const onDrop = (e: React.DragEvent, track: SceneNode<'track'>) => {
    e.preventDefault();
    setDropTrack(null);
    const raw = e.dataTransfer.getData(ASSET_MIME);
    if (!raw || !canEdit) return;
    const a = JSON.parse(raw) as AssetSummary;
    const wantsAudio = a.kind === 'audio';
    if ((track.props.trackType === 'audio') !== wantsAudio || track.props.trackType === 'animation' || track.props.trackType === 'title') return;
    const pts = snapping ? snapPoints(state, sequenceId, ed.getState().time, new Set()) : [];
    const at = snapping ? snap(timeAt(e.clientX), pts, pps).t : toFrame(timeAt(e.clientX), fps);
    addAssetClip(ctx, a, track.id, at);
  };

  // Zoom keeps the time under the anchor (pointer for wheel zoom, otherwise the view centre) in place.
  const zoomAnchor = useRef<number | null>(null);
  const prevPps = useRef(pps);
  useLayoutEffect(() => {
    const el = lanesRef.current;
    if (!el || prevPps.current === pps) return;
    const ax = zoomAnchor.current ?? el.clientWidth / 2;
    const tAt = (el.scrollLeft + ax) / prevPps.current;
    prevPps.current = pps;
    zoomAnchor.current = null;
    el.scrollLeft = tAt * pps - ax;
  }, [pps]);
  const zoomTo = (next: number, anchorClientX: number) => {
    zoomAnchor.current = anchorClientX - lanesRef.current!.getBoundingClientRect().left;
    ed.getState().set({ pxPerSec: Math.min(2000, Math.max(2, next)) });
  };

  return (
    <div className="tl-body">
      <div className="tl-heads" ref={headsRef}>
        <div className="tl-ruler-spacer row" style={{ padding: '0 6px', gap: 4 }}>
          {canEdit && (
            <MenuButton
              className="btn btn-sm btn-ghost"
              label={t('video.addTrack')}
              items={(['video', 'audio', 'title', 'effect', ...(seq.props.purpose === 'animation' ? (['animation'] as TrackType[]) : [])] as TrackType[]).map((k) => ({ label: t(`video.trackTypes.${k}`), onSelect: () => addTrack(ctx, k) }))}
            >
              <Plus /> {t('video.addTrack')}
            </MenuButton>
          )}
        </div>
        {tracks.map((track) => {
          const tp = track.props;
          const Icon = TRACK_ICON[tp.trackType];
          const upd = (set: Record<string, unknown>, label: string) => store.getState().commit({ kind: 'update', id: track.id, set }, label);
          return (
            <div key={track.id} className="tl-head" style={{ height: TRACK_HEIGHT[tp.trackType] }} aria-selected={selectedTrack === track.id} onClick={() => ed.getState().set({ selectedTrack: track.id, inspectorTab: 'track' })}>
              <Icon size={14} style={{ color: TRACK_COLORS[tp.trackType], flex: 'none' }} aria-hidden="true" />
              <span className="name truncate" title={tp.name}>
                {tp.name}
              </span>
              {(tp.trackType === 'audio' || tp.trackType === 'video') && (
                <>
                  <button className="icon-btn xs" aria-pressed={tp.muted} aria-label={`${tp.muted ? 'Unmute' : t('video.mute')} ${tp.name}`} title={t('video.mute')} disabled={!canEdit} onClick={(e) => (e.stopPropagation(), upd({ muted: !tp.muted }, tp.muted ? 'Unmute track' : 'Mute track'))}>
                    {tp.muted ? <VolumeX /> : <Volume2 />}
                  </button>
                  <button className="icon-btn xs" aria-pressed={solo.includes(track.id)} aria-label={`${t('video.solo')} ${tp.name}`} title={t('video.solo')} onClick={(e) => (e.stopPropagation(), ed.getState().set({ soloTracks: solo.includes(track.id) ? solo.filter((x) => x !== track.id) : [...solo, track.id] }))}>
                    <Headphones />
                  </button>
                </>
              )}
              {tp.trackType !== 'audio' && (
                <button className="icon-btn xs" aria-pressed={tp.hidden} aria-label={`${tp.hidden ? 'Show' : t('video.hide')} ${tp.name}`} title={t('video.hide')} disabled={!canEdit} onClick={(e) => (e.stopPropagation(), upd({ hidden: !tp.hidden }, tp.hidden ? 'Show track' : 'Hide track'))}>
                  {tp.hidden ? <EyeOff /> : <Eye />}
                </button>
              )}
              <button className="icon-btn xs" aria-pressed={tp.locked} aria-label={`${tp.locked ? 'Unlock' : 'Lock'} ${tp.name}`} title="Lock" disabled={!canEdit} onClick={(e) => (e.stopPropagation(), upd({ locked: !tp.locked }, tp.locked ? 'Unlock track' : 'Lock track'))}>
                {tp.locked ? <Lock /> : <LockOpen />}
              </button>
              <MenuButton className="icon-btn xs" label={`${tp.name} options`} items={() => trackMenu(track)}>
                <MoreHorizontal />
              </MenuButton>
            </div>
          );
        })}
      </div>
      <div
        className="tl-lanes"
        ref={lanesRef}
        tabIndex={0}
        role="application"
        aria-label={`Timeline. Playhead at ${time.toFixed(2)} seconds. ${tracks.length} tracks.`}
        onScroll={(e) => {
          setScrollX(e.currentTarget.scrollLeft);
          if (headsRef.current) headsRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            zoomTo(pps * Math.exp(-e.deltaY * 0.002), e.clientX);
          }
        }}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        <div style={{ width: totalW, position: 'relative', minHeight: '100%' }}>
          <div
            className="tl-ruler"
            style={{ width: viewW, left: 0, position: 'sticky' }}
            onPointerDown={(e) => {
              ed.getState().set({ time: toFrame(timeAt(e.clientX), fps) });
              drag.current = { kind: 'scrub', id: '', startX: e.clientX, startY: e.clientY, base: state, group: [], moved: true };
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            }}
          >
            <canvas ref={rulerRef} height={RULER} aria-hidden="true" />
          </div>
          {tracks.map((track) => {
            const tp = track.props;
            const kids = childrenOf(state, track.id);
            return (
              <div
                key={track.id}
                data-track={track.id}
                className={`tl-lane${tp.locked ? ' locked' : ''}${dropTrack === track.id ? ' drop' : ''}`}
                style={{ height: TRACK_HEIGHT[tp.trackType] }}
                onPointerDown={onLaneDown}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes(ASSET_MIME)) {
                    e.preventDefault();
                    setDropTrack(track.id);
                  }
                }}
                onDragLeave={() => setDropTrack(null)}
                onDrop={(e) => onDrop(e, track)}
              >
                {kids.map((n) =>
                  n.type === 'clip' ? (
                    <ClipView key={n.id} clip={n as SceneNode<'clip'>} track={track} pps={pps} selected={selected.includes(n.id)} host={host} onDown={beginClip} onMenu={clipMenu} onSelect={() => select(n.id, false)} />
                  ) : n.type === 'animLayer' ? (
                    <LayerBar key={n.id} layer={n as SceneNode<'animLayer'>} pps={pps} selected={selected.includes(n.id)} onDown={beginLayer} />
                  ) : null,
                )}
              </div>
            );
          })}
          <div className="tl-playhead" style={{ left: xOf(time) }} aria-hidden="true" />
          {snapLine !== null && <div className="tl-snapline" style={{ left: xOf(snapLine) }} aria-hidden="true" />}
        </div>
      </div>
      {menu && <Menu anchor={{ x: menu.x, y: menu.y }} items={menu.items} onClose={() => setMenu(null)} label="Clip" />}
    </div>
  );
}

function ClipView({ clip, track, pps, selected, host, onDown, onMenu, onSelect }: { clip: SceneNode<'clip'>; track: SceneNode<'track'>; pps: number; selected: boolean; host: ReturnType<typeof useRenderHost>; onDown: (e: React.PointerEvent, c: SceneNode<'clip'>, part: 'body' | 'l' | 'r') => void; onMenu: (e: React.MouseEvent, c: SceneNode<'clip'>) => void; onSelect: () => void }) {
  const p = clip.props;
  const tt = track.props.trackType;
  const dur = clipDuration(p);
  const w = Math.max(2, dur * pps);
  const meta = p.assetId ? host.assetMeta(p.assetId) : null;
  const color = TRACK_COLORS[tt];
  const label = p.title ? p.title.text : p.name;
  const kfTimes = [...new Set(Object.values(p.keyframes).flatMap((ks) => (ks ?? []).map((k) => k.time)))];
  const darkText = tt === 'effect';
  return (
    <div
      className={`tl-clip${track.props.muted ? ' muted-clip' : ''}`}
      role="button"
      tabIndex={0}
      aria-selected={selected}
      aria-label={`${label}, ${p.start.toFixed(2)} to ${(p.start + dur).toFixed(2)} seconds${p.speed !== 1 ? `, ${p.speed}x speed` : ''}`}
      style={{ left: p.start * pps, width: w, background: color, color: darkText ? '#1d1f24' : '#fff' }}
      onPointerDown={(e) => onDown(e, clip, 'body')}
      onContextMenu={(e) => onMenu(e, clip)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {tt === 'video' && p.assetId && <div className="filmstrip" style={{ backgroundImage: `url(${thumbUrl(p.assetId)})`, backgroundSize: 'auto 100%', backgroundRepeat: 'repeat-x', opacity: 0.55 }} />}
      {(tt === 'audio' || (tt === 'video' && meta?.hasAudio)) && meta?.waveform && <Waveform peaks={meta.waveform} clip={p} source={meta.duration ?? p.sourceDuration} width={w} height={tt === 'audio' ? 46 : 20} />}
      {p.transitionIn && <div className="trans" style={{ left: 0, width: p.transitionIn.duration * pps }} />}
      {p.transitionOut && <div className="trans out" style={{ width: p.transitionOut.duration * pps }} />}
      <span className="clip-label">{label}</span>
      {(p.speed !== 1 || p.reverse || p.speedRamp) && <span className="speed">{p.speedRamp ? 'ramp' : `${p.reverse ? '◀ ' : ''}${p.speed}×`}</span>}
      {kfTimes.map((k) => (
        <span key={k} className="kf" style={{ left: k * pps }} />
      ))}
      <span className="handle l" onPointerDown={(e) => onDown(e, clip, 'l')} aria-hidden="true" />
      <span className="handle r" onPointerDown={(e) => onDown(e, clip, 'r')} aria-hidden="true" />
    </div>
  );
}

function Waveform({ peaks, clip, source, width, height }: { peaks: number[]; clip: SceneNode<'clip'>['props']; source: number; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !source) return;
    const W = Math.min(4000, Math.round(width));
    c.width = W;
    c.height = height;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, W, height);
    g.fillStyle = 'rgba(255,255,255,0.7)';
    const mid = height / 2;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const src = clip.reverse ? clip.out - u * (clip.out - clip.in) : clip.in + u * (clip.out - clip.in);
      const v = peaks[Math.min(peaks.length - 1, Math.floor((src / source) * peaks.length))] ?? 0;
      const h = Math.max(1, v * height * 0.9);
      g.fillRect(x, mid - h / 2, 1, h);
    }
  }, [peaks, clip.in, clip.out, clip.reverse, source, width, height]);
  return <canvas ref={ref} className="wave" style={{ top: 'auto', height, width: '100%' }} aria-hidden="true" />;
}

function LayerBar({ layer, pps, selected, onDown }: { layer: SceneNode<'animLayer'>; pps: number; selected: boolean; onDown: (e: React.PointerEvent, l: SceneNode<'animLayer'>, part: 'body' | 'l' | 'r') => void }) {
  const p = layer.props;
  const kfTimes = [...new Set([...Object.values(p.keyframes).flatMap((ks) => (ks ?? []).map((k) => k.time)), ...(p.rig?.poses.map((q) => q.time) ?? [])])];
  return (
    <div
      className="tl-clip"
      role="button"
      tabIndex={0}
      aria-selected={selected}
      aria-label={`${p.name}, ${p.frames.length} frames, ${p.start.toFixed(2)} to ${(p.start + p.duration).toFixed(2)} seconds`}
      style={{ left: p.start * pps, width: Math.max(4, p.duration * pps), background: TRACK_COLORS.animation, opacity: p.visible ? 1 : 0.5 }}
      onPointerDown={(e) => onDown(e, layer, 'body')}
    >
      <span className="clip-label">
        {p.name}
        {p.frames.length > 0 && ` · ${p.frames.length} fr`}
        {p.rig && ' · rig'}
        {p.motionPath && ' · path'}
      </span>
      {kfTimes.map((k) => (
        <span key={k} className="kf" style={{ left: k * pps }} />
      ))}
      <span className="handle l" onPointerDown={(e) => onDown(e, layer, 'l')} aria-hidden="true" />
      <span className="handle r" onPointerDown={(e) => onDown(e, layer, 'r')} aria-hidden="true" />
    </div>
  );
}
