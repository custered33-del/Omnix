import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Play, Pause, SkipBack, SkipForward, Scissors, Magnet, ZoomIn, ZoomOut, MousePointer2, ArrowLeftRight, Columns2, MoveHorizontal, Slice, StepBack, StepForward, SlidersVertical, GanttChart, Repeat, Palette, Crop } from 'lucide-react';
import type { SceneNode } from '@omnix/core';
import { clipEnd, clipPropsAt, contentDuration, tracksOf, clipsOf } from '@omnix/core';
import { useFocusRequest, useProject, useProjectStore } from '../../state/project.js';
import { useRenderHost } from '../../render/context.js';
import { useShortcuts, formatShortcut } from '../../ui/shortcuts.js';
import { useCommands } from '../../state/commands.js';
import { IconButton, MenuButton } from '../../ui/primitives.js';
import { useDialogs } from '../../state/dialogs.js';
import { post } from '../../lib/api.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../i18n/index.js';
import { createTimelineStore, timecode, toFrame, type EditMode, type TimelineEditorStore } from './timelineState.js';
import { PlaybackEngine } from './playback.js';
import { Timeline } from './Timeline.js';
import { Inspector, useAnimated } from './Inspector.js';
import { MediaBin } from './MediaBin.js';
import { Mixer } from './Mixer.js';
import { Stage, type StageHandlers } from './Stage.js';
import { CaptionsDialog } from './CaptionsDialog.js';
import { addTitle, deleteSelected, duplicateSelected, splitAtPlayhead, type TimelineCtx } from './timelineOps.js';
import { AnimationPanel } from '../animation/AnimationPanel.js';
import { useAnimationStage } from '../animation/useAnimationStage.js';
import '../../styles/editors.css';

const MODES: { mode: EditMode; icon: typeof Scissors; key: string }[] = [
  { mode: 'select', icon: MousePointer2, key: 'v' },
  { mode: 'ripple', icon: ArrowLeftRight, key: 'b' },
  { mode: 'roll', icon: Columns2, key: 'n' },
  { mode: 'slip', icon: MoveHorizontal, key: 'y' },
  { mode: 'slide', icon: Slice, key: 'u' },
  { mode: 'razor', icon: Scissors, key: 'c' },
];

export function TimelineEditor({ sequenceId }: { sequenceId: string }) {
  const store = useProjectStore();
  const host = useRenderHost();
  const seq = useProject((s) => s.state?.nodes[sequenceId]) as SceneNode<'sequence'> | undefined;
  const purpose = seq?.props.purpose ?? 'video';
  const ed = useMemo(() => createTimelineStore(purpose), [purpose]);
  const ctx: TimelineCtx = useMemo(() => ({ store, ed, sequenceId }), [store, ed, sequenceId]);
  const [engine, setEngine] = useState<PlaybackEngine | null>(null);
  const [captionsOpen, setCaptionsOpen] = useState(false);
  const timelineHeight = useStore(ed, (s) => s.timelineHeight);
  const bottom = useStore(ed, (s) => s.bottom);

  useEffect(() => {
    const e = new PlaybackEngine(host, () => store.getState().state, sequenceId, ed);
    setEngine(e);
    return () => e.dispose();
  }, [host, store, sequenceId, ed]);

  // Keep paused video frames and the playhead in step when scrubbing.
  useEffect(
    () =>
      ed.subscribe((s, prev) => {
        if (!s.playing && s.time !== prev.time && engine) {
          const st = store.getState().state;
          if (st?.nodes[sequenceId]) engine.syncMedia(st, s.time);
        }
      }),
    [ed, engine, store, sequenceId],
  );

  // Report the playhead to collaborators.
  const time = useStore(ed, (s) => s.time);
  const lastReport = useRef(0);
  useEffect(() => {
    const now = performance.now();
    if (now - lastReport.current < 250) return;
    lastReport.current = now;
    store.getState().reportLocation({ tool: purpose, nodeId: sequenceId, time: Math.round(time * 100) / 100 });
    store.getState().setEditorContext({ time: Math.round(time * 100) / 100 });
  }, [time, purpose, sequenceId, store]);

  useEditorShortcuts(ctx);
  // Jump to a comment's moment (or any requested time).
  useFocusRequest(sequenceId, (r) => {
    if (r.time !== undefined) ed.getState().set({ time: r.time, playing: false });
  });

  if (!seq) return null;
  const isAnim = purpose === 'animation';
  return (
    <div className="timeline-editor" style={{ ['--tl-height' as string]: `${timelineHeight}px` }}>
      {isAnim ? <AnimationPanel ctx={ctx} /> : <MediaBin ctx={ctx} onCaptions={() => setCaptionsOpen(true)} />}
      <div className="tl-preview">
        {isAnim ? <AnimStage ctx={ctx} /> : <VideoStage ctx={ctx} />}
        <Transport ctx={ctx} />
      </div>
      <Inspector ctx={ctx} />
      <Splitter ed={ed} />
      <section className="tl-timeline" aria-label={bottom === 'timeline' ? 'Timeline' : t('video.mixer')}>
        <TimelineToolbar ctx={ctx} onCaptions={() => setCaptionsOpen(true)} />
        {bottom === 'timeline' ? <Timeline ctx={ctx} /> : <Mixer ctx={ctx} engine={engine} />}
      </section>
      {captionsOpen && <CaptionsDialog ctx={ctx} onClose={() => setCaptionsOpen(false)} />}
    </div>
  );
}

function sequenceEnd(ctx: TimelineCtx): number {
  const st = ctx.store.getState().state!;
  const sp = (st.nodes[ctx.sequenceId] as SceneNode<'sequence'>).props;
  return sp.purpose === 'animation' ? sp.duration : Math.max(contentDuration(st, ctx.sequenceId), 0) || sp.duration;
}

function useEditorShortcuts(ctx: TimelineCtx) {
  const { ed, store } = ctx;
  const fps = () => (store.getState().state!.nodes[ctx.sequenceId] as SceneNode<'sequence'>).props.fps;
  const step = (n: number) => {
    const s = ed.getState();
    s.set({ playing: false, time: Math.max(0, toFrame(s.time + n / fps(), fps())) });
  };
  const jumpEdit = (dir: 1 | -1) => {
    const st = store.getState().state!;
    const pts = new Set<number>([0]);
    for (const tr of tracksOf(st, ctx.sequenceId)) for (const c of clipsOf(st, tr.id)) (pts.add(c.props.start), pts.add(clipEnd(c.props)));
    const now = ed.getState().time;
    const sorted = [...pts].sort((a, b) => a - b);
    const next = dir > 0 ? sorted.find((p) => p > now + 1e-4) : sorted.reverse().find((p) => p < now - 1e-4);
    if (next !== undefined) ed.getState().set({ time: next });
  };
  const shuttle = useRef(0);
  useShortcuts(
    {
      space: () => ed.getState().set({ playing: !ed.getState().playing }),
      k: () => {
        shuttle.current = 0;
        ed.getState().set({ playing: false });
      },
      l: () => ed.getState().set({ playing: true }),
      j: () => step(-Math.max(1, Math.round(fps() / 2))),
      arrowleft: () => step(-1),
      arrowright: () => step(1),
      'shift+arrowleft': () => step(-10),
      'shift+arrowright': () => step(10),
      arrowup: () => jumpEdit(-1),
      arrowdown: () => jumpEdit(1),
      home: () => ed.getState().set({ time: 0 }),
      end: () => ed.getState().set({ time: sequenceEnd(ctx) }),
      s: () => splitAtPlayhead(ctx),
      'mod+b': () => splitAtPlayhead(ctx),
      del: () => deleteSelected(ctx, false),
      'shift+del': () => deleteSelected(ctx, true),
      'mod+d': () => duplicateSelected(ctx),
      t: () => addTitle(ctx),
      '=': () => ed.getState().set({ pxPerSec: Math.min(2000, ed.getState().pxPerSec * 1.4) }),
      '-': () => ed.getState().set({ pxPerSec: Math.max(2, ed.getState().pxPerSec / 1.4) }),
      ...Object.fromEntries(MODES.map((m) => [`alt+${m.key}`, () => ed.getState().set({ mode: m.mode })])),
      esc: () => ed.getState().set({ selectedClips: [] }),
    },
    [ctx],
  );
  useCommands(
    'timeline',
    [
      { id: 'tl.play', label: `${t('video.play')} / ${t('video.pause')}`, section: 'Timeline', shortcut: 'space', run: () => ed.getState().set({ playing: !ed.getState().playing }) },
      { id: 'tl.split', label: t('shortcuts.split'), section: 'Timeline', shortcut: 's', run: () => splitAtPlayhead(ctx) },
      { id: 'tl.ripple', label: t('video.rippleDelete'), section: 'Timeline', shortcut: 'shift+del', run: () => deleteSelected(ctx, true) },
      { id: 'tl.title', label: t('video.addTitle'), section: 'Timeline', shortcut: 't', run: () => addTitle(ctx) },
      { id: 'tl.caption', label: 'Add caption at playhead', section: 'Timeline', run: () => addTitle(ctx, true) },
      { id: 'tl.mixer', label: t('video.mixer'), section: 'Timeline', run: () => ed.getState().set({ bottom: ed.getState().bottom === 'mixer' ? 'timeline' : 'mixer' }) },
      ...MODES.map((m) => ({ id: `tl.mode.${m.mode}`, label: `${t(`video.edits.${m.mode}`)} tool`, section: 'Timeline', shortcut: `alt+${m.key}`, run: () => ed.getState().set({ mode: m.mode }) })),
    ],
    [ctx],
  );
}

function Splitter({ ed }: { ed: TimelineEditorStore }) {
  const h = useStore(ed, (s) => s.timelineHeight);
  return (
    <button
      className="tl-splitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize timeline"
      aria-valuenow={h}
      onPointerDown={(e) => {
        const startY = e.clientY;
        const start = h;
        const move = (ev: PointerEvent) => ed.getState().set({ timelineHeight: Math.min(window.innerHeight - 220, Math.max(140, start - (ev.clientY - startY))) });
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') ed.getState().set({ timelineHeight: Math.min(window.innerHeight - 220, h + 20) });
        if (e.key === 'ArrowDown') ed.getState().set({ timelineHeight: Math.max(140, h - 20) });
      }}
    />
  );
}

function Transport({ ctx }: { ctx: TimelineCtx }) {
  const { ed } = ctx;
  const time = useStore(ed, (s) => s.time);
  const playing = useStore(ed, (s) => s.playing);
  const seq = useProject((s) => s.state?.nodes[ctx.sequenceId]) as SceneNode<'sequence'>;
  const fps = seq.props.fps;
  const end = useProject(() => sequenceEnd(ctx));
  const step = (n: number) => ed.getState().set({ playing: false, time: Math.max(0, toFrame(ed.getState().time + n / fps, fps)) });
  return (
    <div className="tl-transport" role="toolbar" aria-label="Playback">
      <IconButton label={t('video.toStart')} shortcut="Home" onClick={() => ed.getState().set({ time: 0 })}>
        <SkipBack />
      </IconButton>
      <IconButton label={t('shortcuts.framePrev')} shortcut="←" onClick={() => step(-1)}>
        <StepBack />
      </IconButton>
      <IconButton label={playing ? t('video.pause') : t('video.play')} shortcut="Space" onClick={() => ed.getState().set({ playing: !playing })}>
        {playing ? <Pause /> : <Play />}
      </IconButton>
      <IconButton label={t('shortcuts.frameNext')} shortcut="→" onClick={() => step(1)}>
        <StepForward />
      </IconButton>
      <IconButton label={t('video.toEnd')} shortcut="End" onClick={() => ed.getState().set({ time: end })}>
        <SkipForward />
      </IconButton>
      <span className="timecode" aria-live="off" aria-label={`Time ${timecode(time, fps)}`}>
        {timecode(time, fps)}
      </span>
      <span className="muted tabular" style={{ fontSize: 'var(--fs-sm)' }}>
        / {timecode(end, fps)}
      </span>
      {seq.props.purpose === 'animation' && (
        <span className="badge" title={t('anim.playback')}>
          <Repeat size={12} /> {t(`anim.playbackModes.${seq.props.playback}`)}
        </span>
      )}
      <span className="spacer" />
      <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
        {seq.props.width}×{seq.props.height} · {fps} fps
      </span>
    </div>
  );
}

const REFRAMES = [
  { label: '9:16 vertical (1080×1920)', w: 1080, h: 1920 },
  { label: '1:1 square (1080×1080)', w: 1080, h: 1080 },
  { label: '4:5 portrait (1080×1350)', w: 1080, h: 1350 },
  { label: '16:9 landscape (1920×1080)', w: 1920, h: 1080 },
];

/** Change the frame size and fill around each shot with a blurred copy (no black bars). */
async function reframe(ctx: TimelineCtx, width: number, height: number): Promise<void> {
  try {
    await post(`/api/projects/${ctx.store.getState().projectId}/video/reframe`, { sequenceId: ctx.sequenceId, width, height });
    toast.success(t('video.reframed', { w: width, h: height }));
  } catch (e) {
    toast.error((e as Error).message);
  }
}

function TimelineToolbar({ ctx, onCaptions }: { ctx: TimelineCtx; onCaptions: () => void }) {
  const { ed } = ctx;
  const openStyle = useDialogs((d) => d.openStyle);
  const mode = useStore(ed, (s) => s.mode);
  const snapping = useStore(ed, (s) => s.snapping);
  const pps = useStore(ed, (s) => s.pxPerSec);
  const bottom = useStore(ed, (s) => s.bottom);
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  const purpose = useProject((s) => (s.state?.nodes[ctx.sequenceId] as SceneNode<'sequence'>).props.purpose);
  return (
    <div className="tl-toolbar" role="toolbar" aria-label="Timeline tools">
      <div className="segmented" role="group" aria-label="Edit tool">
        {MODES.map(({ mode: m, icon: Icon, key }) => (
          <button key={m} aria-pressed={mode === m} onClick={() => ed.getState().set({ mode: m })} title={`${t(`video.edits.${m}`)} (${formatShortcut(`alt+${key}`)})`} aria-label={t(`video.edits.${m}`)}>
            <Icon size={15} />
            <span className="sr-only">{t(`video.edits.${m}`)}</span>
          </button>
        ))}
      </div>
      <span className="muted" style={{ fontSize: 'var(--fs-xs)', minWidth: 120 }}>
        {mode === 'select' && 'Drag clips, trim edges'}
        {mode === 'ripple' && 'Trims push later clips'}
        {mode === 'roll' && 'Drag a cut between clips'}
        {mode === 'slip' && 'Drag to change the source span'}
        {mode === 'slide' && 'Move a clip between neighbours'}
        {mode === 'razor' && 'Click a clip to cut it'}
      </span>
      <IconButton small label={t('video.split')} shortcut="S" onClick={() => splitAtPlayhead(ctx)} disabled={!canEdit}>
        <Scissors />
      </IconButton>
      <IconButton small label={t('video.snapping')} pressed={snapping} onClick={() => ed.getState().set({ snapping: !snapping })}>
        <Magnet />
      </IconButton>
      <span className="spacer" />
      {canEdit && (
        <button className="btn btn-sm btn-ghost" onClick={() => openStyle(ed.getState().selectedClips.length === 1 ? ed.getState().selectedClips[0]! : ctx.sequenceId)}>
          <Palette size={15} /> {t('style.short')}
        </button>
      )}
      {purpose === 'video' && canEdit && (
        <MenuButton
          className="btn btn-sm btn-ghost"
          label={t('video.reframe')}
          items={[
            { label: t('video.reframe'), heading: true },
            ...REFRAMES.map((r) => ({ label: r.label, onSelect: () => void reframe(ctx, r.w, r.h) })),
          ]}
        >
          <Crop size={15} /> {t('video.reframe')}
        </MenuButton>
      )}
      {purpose === 'video' && canEdit && (
        <button className="btn btn-sm btn-ghost" onClick={onCaptions}>
          {t('video.captions')}
        </button>
      )}
      <div className="segmented" role="tablist" aria-label="Bottom panel">
        <button role="tab" aria-selected={bottom === 'timeline'} onClick={() => ed.getState().set({ bottom: 'timeline' })}>
          <GanttChart size={15} /> Timeline
        </button>
        <button role="tab" aria-selected={bottom === 'mixer'} onClick={() => ed.getState().set({ bottom: 'mixer' })}>
          <SlidersVertical size={15} /> {t('video.mixer')}
        </button>
      </div>
      <IconButton small label={t('shortcuts.zoomOut')} shortcut="-" onClick={() => ed.getState().set({ pxPerSec: Math.max(2, pps / 1.4) })}>
        <ZoomOut />
      </IconButton>
      <input type="range" className="range" style={{ width: 100 }} min={Math.log(2)} max={Math.log(2000)} step={0.01} value={Math.log(pps)} aria-label={t('video.zoomTimeline')} onChange={(e) => ed.getState().set({ pxPerSec: Math.exp(Number(e.target.value)) })} />
      <IconButton small label={t('shortcuts.zoomIn')} shortcut="=" onClick={() => ed.getState().set({ pxPerSec: Math.min(2000, pps * 1.4) })}>
        <ZoomIn />
      </IconButton>
    </div>
  );
}

/** Video preview: drag the selected visual clip to reposition it (keyframe-aware). */
function VideoStage({ ctx }: { ctx: TimelineCtx }) {
  const selected = useStore(ctx.ed, (s) => s.selectedClips);
  const clip = useProject((s) => (selected.length === 1 ? s.state?.nodes[selected[0]!] : undefined)) as SceneNode<'clip'> | undefined;
  const track = useProject((s) => (clip ? s.state?.nodes[clip.parentId!] : undefined)) as SceneNode<'track'> | undefined;
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  const time = useStore(ctx.ed, (s) => s.time);
  const movable = !!clip && !!track && track.props.trackType !== 'audio' && canEdit && !track.props.locked && time >= clip.props.start && time < clipEnd(clip.props);
  const anim = useAnimated(ctx, clip?.id ?? '', clip?.props.start ?? 0, clip?.props.keyframes ?? {});
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const host = useRenderHost();
  const drawingRegion = useStore(ctx.ed, (s) => s.drawingRegion);
  const regionStart = useRef<{ x: number; y: number } | null>(null);
  // The generated area of a clip stays visible on the stage (its mask), and so does a region being drawn.
  const regionOverlay = (g: CanvasRenderingContext2D) => {
    const st = ctx.store.getState().state!;
    const sp = (st.nodes[ctx.sequenceId] as SceneNode<'sequence'>).props;
    const lw = 2 / Math.max(0.01, g.getTransform().a / (window.devicePixelRatio || 1));
    const draft = ctx.ed.getState().regionDraft;
    const c = clip ? (st.nodes[clip.id] as SceneNode<'clip'> | undefined) : undefined;
    const gen = c?.props.generation;
    const rects: { r: { x: number; y: number; width: number; height: number }; dashed: boolean }[] = [];
    if (draft) rects.push({ r: draft, dashed: true });
    if (gen?.region && c) {
      const meta = host.assetMeta(gen.sourceAssetId) ?? (c.props.assetId ? host.assetMeta(c.props.assetId) : null);
      if (meta?.width && meta.height) {
        const s = Math.min(sp.width / meta.width, sp.height / meta.height) * c.props.scale;
        const left = sp.width / 2 + c.props.x - (meta.width * s) / 2;
        const top = sp.height / 2 + c.props.y - (meta.height * s) / 2;
        rects.push({ r: { x: left + gen.region.x * s, y: top + gen.region.y * s, width: gen.region.width * s, height: gen.region.height * s }, dashed: false });
      }
    }
    for (const { r, dashed } of rects) {
      g.save();
      g.fillStyle = 'rgba(106, 72, 215, 0.18)';
      g.fillRect(r.x, r.y, r.width, r.height);
      g.strokeStyle = '#6a48d7';
      g.lineWidth = lw;
      if (dashed) g.setLineDash([6 * lw, 4 * lw]);
      g.strokeRect(r.x, r.y, r.width, r.height);
      g.restore();
    }
  };
  if (drawingRegion && clip) {
    const regionHandlers: StageHandlers = {
      cursor: 'crosshair',
      onDown: (p) => {
        regionStart.current = p;
        ctx.ed.getState().set({ regionDraft: { x: p.x, y: p.y, width: 0, height: 0 } });
      },
      onMove: (p) => {
        const a = regionStart.current;
        if (!a) return;
        ctx.ed.getState().set({ regionDraft: { x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), width: Math.abs(p.x - a.x), height: Math.abs(p.y - a.y) } });
      },
      onUp: () => {
        regionStart.current = null;
        const d = ctx.ed.getState().regionDraft;
        ctx.ed.getState().set({ drawingRegion: false, regionDraft: d && d.width > 4 && d.height > 4 ? { x: Math.round(d.x), y: Math.round(d.y), width: Math.round(d.width), height: Math.round(d.height) } : null });
      },
      overlay: regionOverlay,
    };
    return <Stage ctx={ctx} handlers={regionHandlers} label="Video preview: drag to mark the area to fill" />;
  }
  const handlers: StageHandlers | undefined = movable
    ? {
        cursor: 'move',
        onDown: (p) => {
          const v = clipPropsAt(clip!.props, time);
          drag.current = { x: p.x, y: p.y, ox: v.x, oy: v.y };
        },
        onMove: (p) => {
          const d = drag.current;
          if (!d) return;
          anim.inputMany({ x: Math.round(d.ox + p.x - d.x), y: Math.round(d.oy + p.y - d.y) });
        },
        onUp: (p) => {
          const d = drag.current;
          drag.current = null;
          if (!d || (Math.abs(p.x - d.x) < 1 && Math.abs(p.y - d.y) < 1)) {
            ctx.store.getState().clearTransient(clip!.id);
            return;
          }
          anim.commitMany({ x: Math.round(d.ox + p.x - d.x), y: Math.round(d.oy + p.y - d.y) }, 'Move clip on screen');
        },
        overlay: (g) => {
          const st = ctx.store.getState().state!;
          const c = st.nodes[clip!.id] as SceneNode<'clip'> | undefined;
          if (!c) return;
          const sp = (st.nodes[ctx.sequenceId] as SceneNode<'sequence'>).props;
          const v = clipPropsAt(c.props, time);
          g.save();
          g.strokeStyle = '#3b5bdb';
          g.lineWidth = 2 / Math.max(0.01, g.getTransform().a / (window.devicePixelRatio || 1));
          g.setLineDash([6, 4]);
          g.translate(sp.width / 2 + v.x, sp.height / 2 + v.y);
          g.rotate((v.rotation * Math.PI) / 180);
          g.scale(v.scale, v.scale);
          g.strokeRect(-sp.width / 2, -sp.height / 2, sp.width, sp.height);
          g.restore();
          regionOverlay(g);
        },
      }
    : clip
      ? { overlay: regionOverlay }
      : undefined;
  return <Stage ctx={ctx} handlers={handlers} label="Video preview" />;
}

function AnimStage({ ctx }: { ctx: TimelineCtx }) {
  const { handlers, editor } = useAnimationStage(ctx);
  return <Stage ctx={ctx} handlers={handlers} editor={editor} label="Animation stage" />;
}
