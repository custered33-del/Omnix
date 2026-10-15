import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { Diamond, ChevronLeft, ChevronRight, Plus, Trash2, Eye, EyeOff, Sparkles, SquareDashed } from 'lucide-react';
import type { AnimatableProp, ClipEffect, ClipProps, Easing, FilterKind, Keyframe, SceneNode, Transition, TransitionKind } from '@omnix/core';
import { clipPropsAt, setSpeedOp, tracksOf, upsertKeyframe } from '@omnix/core';
import { COLOR_GRADE_DEFAULTS, FILTER_DEFAULTS } from '@omnix/imaging';
import { animLayerTransform } from '@omnix/render';
import { useProject } from '../../state/project.js';
import { realtime } from '../../state/realtime.js';
import { post } from '../../lib/api.js';
import { toast } from '../../ui/toast.js';
import { ColorField, IconButton, MenuButton, NumberField, Select, Switch } from '../../ui/primitives.js';
import { FontSelect } from '../shared/FontSelect.js';
import { EasingEditor } from '../shared/EasingEditor.js';
import { t } from '../../i18n/index.js';
import { tryOp, type TimelineCtx } from './timelineOps.js';
import { activeAnimLayer } from '../animation/useAnimationStage.js';
import { PresetMenu } from '../../components/PresetMenu.js';

const TRANSITIONS: (TransitionKind | 'none')[] = ['none', 'crossfade', 'dip-to-black', 'wipe-left', 'wipe-right', 'slide-left', 'zoom'];
const FILTERS: FilterKind[] = ['gaussianBlur', 'sharpen', 'noise', 'pixelate', 'grayscale', 'sepia', 'vignette', 'emboss', 'edgeDetect'];

const RAMPS: Record<string, { label: string; ramp: { t: number; speed: number }[] | null }> = {
  none: { label: 'None', ramp: null },
  up: { label: 'Speed up', ramp: [{ t: 0, speed: 0.5 }, { t: 1, speed: 2 }] },
  down: { label: 'Slow down', ramp: [{ t: 0, speed: 2 }, { t: 1, speed: 0.5 }] },
  slowmo: { label: 'Slow-motion middle', ramp: [{ t: 0, speed: 1 }, { t: 0.4, speed: 0.3 }, { t: 0.6, speed: 0.3 }, { t: 1, speed: 1 }] },
};

export const SEQUENCE_PRESETS = [
  { label: '1080p landscape (16:9)', w: 1920, h: 1080 },
  { label: '4K landscape (16:9)', w: 3840, h: 2160 },
  { label: '720p landscape (16:9)', w: 1280, h: 720 },
  { label: 'Vertical (9:16)', w: 1080, h: 1920 },
  { label: 'Square (1:1)', w: 1080, h: 1080 },
  { label: 'Portrait (4:5)', w: 1080, h: 1350 },
];

export function Inspector({ ctx }: { ctx: TimelineCtx }) {
  const tab = useStore(ctx.ed, (s) => s.inspectorTab);
  const selected = useStore(ctx.ed, (s) => s.selectedClips);
  const trackId = useStore(ctx.ed, (s) => s.selectedTrack);
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  // In the animation maker the first layer is edited until something else is selected.
  const fallbackLayer = useProject((s) => (selected.length === 0 && (s.state?.nodes[ctx.sequenceId] as SceneNode<'sequence'> | undefined)?.props.purpose === 'animation' ? activeAnimLayer(s.state!, ctx.sequenceId, []) : null));
  const picked = useProject((s) => (selected.length === 1 ? s.state?.nodes[selected[0]!] : undefined));
  const clip = picked ?? fallbackLayer ?? undefined;
  const track = useProject((s) => (trackId ? s.state?.nodes[trackId] : undefined)) as SceneNode<'track'> | undefined;
  return (
    <aside className="tl-inspector" aria-label={t('video.inspector')}>
      <div className="segmented" role="tablist" style={{ margin: 12 }} aria-label={t('video.inspector')}>
        {(['clip', 'track', 'sequence'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => ctx.ed.getState().set({ inspectorTab: k })}>
            {k === 'clip' ? 'Clip' : k === 'track' ? 'Track' : 'Sequence'}
          </button>
        ))}
      </div>
      <fieldset className="props-fieldset" disabled={!canEdit}>
        {tab === 'clip' && clip?.type === 'clip' && <ClipInspector ctx={ctx} clip={clip as SceneNode<'clip'>} />}
        {tab === 'clip' && clip?.type === 'animLayer' && <AnimLayerInspector ctx={ctx} layer={clip as SceneNode<'animLayer'>} />}
        {tab === 'clip' && (!clip || (clip.type !== 'clip' && clip.type !== 'animLayer')) && (
          <p className="muted inspector-note" style={{ paddingBottom: 16 }}>
            {selected.length > 1 ? `${selected.length} clips selected.` : 'Select a clip on the timeline to edit it.'}
          </p>
        )}
        {tab === 'track' && (track ? <TrackInspector ctx={ctx} track={track} /> : <p className="muted inspector-note">Click a track name to edit it.</p>)}
        {tab === 'sequence' && <SequenceInspector ctx={ctx} />}
      </fieldset>
    </aside>
  );
}

/* ---------------- clip ---------------- */

/** Edit an animatable value: keyframed props get a key at the playhead, others change directly. */
export function useAnimated(ctx: TimelineCtx, id: string, start: number, keyframes: Partial<Record<AnimatableProp, Keyframe[]>>) {
  const time = useStore(ctx.ed, (s) => s.time);
  const local = Math.max(0, time - start);
  const s = ctx.store.getState();
  // Keyframed props get a key at the playhead; others change their static value.
  const build = (values: Partial<Record<AnimatableProp, number>>): Record<string, unknown> => {
    let kf = keyframes;
    const set: Record<string, unknown> = {};
    for (const [prop, value] of Object.entries(values) as [AnimatableProp, number][]) {
      if (kf[prop]?.length) kf = { ...kf, [prop]: upsertKeyframe(kf[prop], { time: Math.round(local * 1000) / 1000, value, easing: 'ease-in-out' }) };
      else set[prop] = value;
    }
    if (kf !== keyframes) set.keyframes = kf;
    return set;
  };
  const inputMany = (values: Partial<Record<AnimatableProp, number>>) => s.setTransient(id, build(values));
  const commitMany = (values: Partial<Record<AnimatableProp, number>>, label: string) => {
    s.clearTransient(id);
    s.commit({ kind: 'update', id, set: build(values) }, label);
  };
  return {
    local,
    has: (prop: AnimatableProp) => (keyframes[prop]?.length ?? 0) > 0,
    atKey: (prop: AnimatableProp) => !!keyframes[prop]?.some((k) => Math.abs(k.time - local) < 1e-3),
    input: (prop: AnimatableProp, value: number) => inputMany({ [prop]: value }),
    commit: (prop: AnimatableProp, value: number) => commitMany({ [prop]: value }, `Change ${prop}`),
    inputMany,
    commitMany,
    toggleKey: (prop: AnimatableProp, value: number) => {
      const ks = keyframes[prop] ?? [];
      const at = ks.findIndex((k) => Math.abs(k.time - local) < 1e-3);
      const next = at >= 0 ? ks.filter((_, i) => i !== at) : upsertKeyframe(ks, { time: Math.round(local * 1000) / 1000, value, easing: 'ease-in-out' });
      s.commit({ kind: 'update', id, set: { keyframes: { ...keyframes, [prop]: next } } }, at >= 0 ? t('video.removeKeyframe') : t('video.addKeyframe'));
    },
    jump: (dir: -1 | 1) => {
      const times = [...new Set(Object.values(keyframes).flatMap((k) => (k ?? []).map((x) => x.time)))].sort((a, b) => a - b);
      const next = dir > 0 ? times.find((x) => x > local + 1e-3) : times.reverse().find((x) => x < local - 1e-3);
      if (next !== undefined) ctx.ed.getState().set({ time: start + next });
    },
    setEasing: (easing: Easing) => {
      const next: Partial<Record<AnimatableProp, Keyframe[]>> = {};
      for (const [p, ks] of Object.entries(keyframes)) next[p as AnimatableProp] = (ks ?? []).map((k) => (Math.abs(k.time - local) < 1e-3 ? { ...k, easing } : k));
      s.commit({ kind: 'update', id, set: { keyframes: next } }, 'Change easing');
    },
    easingAtPlayhead: (): Easing | null => {
      for (const ks of Object.values(keyframes)) {
        const k = ks?.find((x) => Math.abs(x.time - local) < 1e-3);
        if (k) return k.easing;
      }
      return null;
    },
  };
}

export function AnimatedField({ anim, prop, label, value, min, max, step, unit }: { anim: ReturnType<typeof useAnimated>; prop: AnimatableProp; label: string; value: number; min: number; max: number; step?: number; unit?: string }) {
  return (
    <div className="row" style={{ gap: 4, alignItems: 'flex-end' }}>
      <div className="grow">
        <NumberField compact label={label} value={Math.round(value * 1000) / 1000} min={min} max={max} {...(step ? { step } : {})} {...(unit ? { unit } : {})} onInput={(v) => anim.input(prop, v)} onCommit={(v) => anim.commit(prop, v)} />
      </div>
      <IconButton small label={anim.atKey(prop) ? `${t('video.removeKeyframe')} (${label})` : `${t('video.addKeyframe')} (${label})`} pressed={anim.atKey(prop)} onClick={() => anim.toggleKey(prop, value)} className={anim.has(prop) ? 'kf-on' : ''}>
        <Diamond style={anim.atKey(prop) ? { fill: 'currentColor' } : undefined} />
      </IconButton>
    </div>
  );
}

function ClipInspector({ ctx, clip }: { ctx: TimelineCtx; clip: SceneNode<'clip'> }) {
  const p = clip.props;
  const s = ctx.store.getState();
  const time = useStore(ctx.ed, (st) => st.time);
  const anim = useAnimated(ctx, clip.id, p.start, p.keyframes);
  const v = clipPropsAt(p, Math.min(Math.max(time, p.start), p.start + 1e9));
  const track = useProject((st) => st.state?.nodes[clip.parentId!]) as SceneNode<'track'>;
  const tt = track.props.trackType;
  const upd = (set: Partial<ClipProps>, label: string) => s.commit({ kind: 'update', id: clip.id, set: set as Record<string, unknown> }, label);
  const isVisual = tt !== 'audio';
  const hasAudio = tt === 'audio' || tt === 'video';
  const easing = anim.easingAtPlayhead();
  return (
    <>
      <section className="inspector-section">
        <h3>{p.title ? (p.title.caption ? 'Caption' : 'Title') : 'Clip'}</h3>
        <input className="input sm" aria-label={t('app.rename')} value={p.name} onChange={(e) => s.setTransient(clip.id, { name: e.target.value })} onBlur={() => s.commitTransient('Rename clip')} />
        <div className="row muted" style={{ fontSize: 'var(--fs-xs)', justifyContent: 'space-between' }}>
          <span>Starts {p.start.toFixed(2)}s</span>
          {p.assetId && (
            <span>
              Source {p.in.toFixed(2)}–{p.out.toFixed(2)}s
            </span>
          )}
        </div>
      </section>
      {p.title && <TitleSection ctx={ctx} clip={clip} />}
      {isVisual && (
        <section className="inspector-section">
          <h3>
            <span className="grow">{t('image.transform')}</span>
            <IconButton small label="Previous keyframe" onClick={() => anim.jump(-1)}>
              <ChevronLeft />
            </IconButton>
            <IconButton small label="Next keyframe" onClick={() => anim.jump(1)}>
              <ChevronRight />
            </IconButton>
          </h3>
          <AnimatedField anim={anim} prop="x" label="X" value={v.x} min={-4000} max={4000} unit="px" />
          <AnimatedField anim={anim} prop="y" label="Y" value={v.y} min={-4000} max={4000} unit="px" />
          <AnimatedField anim={anim} prop="scale" label={t('video.scale')} value={v.scale} min={0.05} max={8} step={0.01} unit="×" />
          <AnimatedField anim={anim} prop="rotation" label={t('video.rotation')} value={v.rotation} min={-360} max={360} unit="°" />
          <AnimatedField anim={anim} prop="opacity" label={t('image.opacity')} value={v.opacity} min={0} max={1} step={0.01} />
          <AnimatedField anim={anim} prop="blur" label="Blur" value={v.blur} min={0} max={50} step={0.5} unit="px" />
          {easing && <EasingEditor value={easing} onChange={anim.setEasing} label="Easing from this keyframe" />}
          <p className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
            The diamond adds a keyframe at the playhead. Once a property has keyframes, edits update the key at the playhead.
          </p>
        </section>
      )}
      {hasAudio && p.assetId && (
        <section className="inspector-section">
          <h3>Audio</h3>
          <AnimatedField anim={anim} prop="volume" label={t('video.volume')} value={v.volume} min={-60} max={12} step={0.5} unit="dB" />
        </section>
      )}
      {p.assetId && (
        <section className="inspector-section">
          <h3>{t('video.speed')}</h3>
          <NumberField
            compact
            slider={false}
            label={`${t('video.speed')} (ripples later clips)`}
            value={p.speed}
            min={0.05}
            max={16}
            step={0.05}
            unit="×"
            onCommit={(x) => {
              const op = tryOp(() => setSpeedOp(ctx.store.getState().state!, clip.id, x, { ripple: true }));
              if (op) s.commit(op, `Speed ${x}×`);
            }}
          />
          <Switch checked={p.reverse} onChange={(x) => upd({ reverse: x }, x ? 'Reverse clip' : 'Play forwards')} label={t('video.reverse')} hint={p.reverse ? 'Reversed clips play without audio in the preview.' : undefined} />
          <Select
            label={t('video.speedRamp')}
            value={(Object.entries(RAMPS).find(([, r]) => JSON.stringify(r.ramp) === JSON.stringify(p.speedRamp))?.[0] ?? (p.speedRamp ? 'custom' : 'none')) as string}
            options={[...Object.entries(RAMPS).map(([k, r]) => ({ value: k, label: r.label })), ...(p.speedRamp && !Object.values(RAMPS).some((r) => JSON.stringify(r.ramp) === JSON.stringify(p.speedRamp)) ? [{ value: 'custom', label: 'Custom' }] : [])]}
            onChange={(k) => k !== 'custom' && upd({ speedRamp: RAMPS[k]!.ramp }, 'Speed ramp')}
          />
        </section>
      )}
      {isVisual && (
        <section className="inspector-section">
          <h3>Transitions</h3>
          <TransitionField label={t('video.transitionIn')} value={p.transitionIn} onChange={(x) => upd({ transitionIn: x }, 'Transition in')} />
          <TransitionField label={t('video.transitionOut')} value={p.transitionOut} onChange={(x) => upd({ transitionOut: x }, 'Transition out')} />
        </section>
      )}
      {isVisual && <EffectsSection ctx={ctx} clip={clip} />}
      {tt === 'video' && p.assetId && <BackgroundSection ctx={ctx} clip={clip} />}
      {tt === 'video' && p.assetId && <GenerativeSection ctx={ctx} clip={clip} />}
    </>
  );
}

/** Generative fill on video: mark an area on the preview, describe it, and Omnix fills it across the clip. */
function GenerativeSection({ ctx, clip }: { ctx: TimelineCtx; clip: SceneNode<'clip'> }) {
  const s = ctx.store.getState();
  const drawing = useStore(ctx.ed, (st) => st.drawingRegion);
  const region = useStore(ctx.ed, (st) => st.regionDraft);
  const canEdit = useProject((st) => st.meta?.role !== 'viewer' && !st.preview);
  const [prompt, setPrompt] = useState('');
  const [job, setJob] = useState<{ id: string; progress: number; message: string } | null>(null);
  const gen = clip.props.generation;
  useEffect(() => {
    if (!job) return;
    return realtime.on('job', (m: { job: { id: string; status: string; progress: number; message: string; error: string | null } }) => {
      if (m.job.id !== job.id) return;
      if (m.job.status === 'done') {
        setJob(null);
        toast.success(t('generative.videoDone'));
      } else if (m.job.status === 'failed' || m.job.status === 'cancelled') {
        setJob(null);
        if (m.job.error) toast.error(m.job.error);
      } else setJob({ id: job.id, progress: m.job.progress, message: m.job.message });
    });
  }, [job?.id]);
  useEffect(() => () => ctx.ed.getState().set({ drawingRegion: false, regionDraft: null }), [clip.id]);
  const start = async () => {
    if (!region) return;
    try {
      const r = await post<{ jobId: string }>(`/api/projects/${s.projectId}/generative/video-fill`, { clipId: clip.id, region, prompt });
      setJob({ id: r.jobId, progress: 0, message: t('generative.queued') });
      ctx.ed.getState().set({ regionDraft: null });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <section className="inspector-section">
      <h3>
        <Sparkles size={14} className="ai-ink" aria-hidden="true" /> {t('generative.videoTitle')}
      </h3>
      {gen && (
        <div className="gen-info">
          <p style={{ fontSize: 'var(--fs-sm)' }}>{gen.prompt ? t('generative.generatedFrom', { prompt: gen.prompt }) : t('generative.generatedFromSurroundings')}</p>
          <button
            className="btn btn-sm"
            disabled={!canEdit}
            onClick={() => s.commit({ kind: 'update', id: clip.id, set: { assetId: gen.sourceAssetId, in: gen.sourceIn, out: gen.sourceOut, sourceDuration: Math.max(gen.sourceOut, clip.props.sourceDuration), generation: null } }, 'Use the original clip')}
          >
            {t('generative.useOriginal')}
          </button>
        </div>
      )}
      {job ? (
        <div className="col" style={{ gap: 6 }} role="status">
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress * 100)} aria-label={t('generative.videoTitle')}>
            <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
          </div>
          <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
            {job.message}
          </span>
        </div>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
            {drawing ? t('generative.drawHint') : region ? t('generative.regionReady') : t('generative.videoHint')}
          </p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn btn-sm" disabled={!canEdit} aria-pressed={drawing} onClick={() => ctx.ed.getState().set({ drawingRegion: !drawing, ...(drawing ? {} : { regionDraft: null, playing: false }) })}>
              <SquareDashed size={14} /> {region ? t('generative.redraw') : t('generative.markArea')}
            </button>
          </div>
          {region && (
            <form
              className="col"
              onSubmit={(e) => {
                e.preventDefault();
                void start();
              }}
            >
              <input className="input" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('generative.videoPlaceholder')} aria-label={t('generative.prompt')} />
              <button className="btn btn-sm btn-ai" type="submit" disabled={!canEdit}>
                <Sparkles size={14} /> {t('generative.fillArea')}
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}

function TransitionField({ label, value, onChange }: { label: string; value: Transition | null; onChange: (t: Transition | null) => void }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      <Select
        label={label}
        value={(value?.kind ?? 'none') as string}
        options={TRANSITIONS.map((k) => ({ value: k, label: t(`video.transitionKinds.${k}`) }))}
        onChange={(k) => onChange(k === 'none' ? null : { kind: k as TransitionKind, duration: value?.duration ?? 0.5, easing: value?.easing ?? 'ease-in-out' })}
      />
      {value && (
        <>
          <NumberField compact label={t('video.duration')} value={value.duration} min={0.05} max={5} step={0.05} unit="s" onCommit={(d) => onChange({ ...value, duration: d })} />
          <EasingEditor value={value.easing} onChange={(e) => onChange({ ...value, easing: e })} />
        </>
      )}
    </div>
  );
}

function TitleSection({ ctx, clip }: { ctx: TimelineCtx; clip: SceneNode<'clip'> }) {
  const tl = clip.props.title!;
  const s = ctx.store.getState();
  const set = (patch: Partial<typeof tl>, label = 'Edit title') => s.commit({ kind: 'update', id: clip.id, set: { title: { ...tl, ...patch } } }, label);
  return (
    <section className="inspector-section">
      <h3>{t('video.text')}</h3>
      <textarea className="input" rows={3} aria-label={t('video.text')} value={tl.text} onChange={(e) => s.setTransient(clip.id, { title: { ...tl, text: e.target.value } })} onBlur={() => s.commitTransient('Edit title text')} />
      <div className="row" style={{ gap: 6 }}>
        <FontSelect value={tl.fontFamily} onChange={(v) => set({ fontFamily: v })} />
        <div style={{ width: 90 }}>
          <NumberField compact slider={false} label={t('image.fontSize')} value={tl.fontSize} min={8} max={400} onCommit={(v) => set({ fontSize: v })} />
        </div>
      </div>
      <NumberField compact label={t('image.weight')} value={tl.fontWeight} min={100} max={900} step={50} onCommit={(v) => set({ fontWeight: v })} />
      <ColorField label={t('image.color')} value={tl.color} onChange={(v) => set({ color: v })} />
      <ColorField label="Background" value={tl.background} allowNone onClear={() => set({ background: null })} onChange={(v) => set({ background: v })} />
      <Select
        label={t('image.align')}
        value={tl.align}
        options={[
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Centre' },
          { value: 'right', label: 'Right' },
        ]}
        onChange={(v) => set({ align: v })}
      />
      <Switch checked={tl.caption} onChange={(v) => set({ caption: v })} label={t('video.caption')} hint="Caption titles sit near the bottom of the frame." />
    </section>
  );
}

function effectRange(effect: ClipEffect['effect'], k: string): { min: number; max: number; step: number } {
  if (effect === 'colorGrade') {
    if (k === 'exposure') return { min: -3, max: 3, step: 0.05 };
    if (k === 'intensity') return { min: 0, max: 1, step: 0.05 };
    return { min: -100, max: 100, step: 1 };
  }
  return k === 'amount' ? { min: 0, max: 2, step: 0.05 } : { min: 0, max: 60, step: 0.5 };
}

function EffectsSection({ ctx, clip }: { ctx: TimelineCtx; clip: SceneNode<'clip'> }) {
  const s = ctx.store.getState();
  const effects = clip.props.effects;
  const commitFx = (fx: ClipEffect, set: Partial<ClipEffect>, label: string) => {
    s.clearTransient(clip.id);
    s.commit({ kind: 'listUpdate', id: clip.id, prop: 'effects', itemId: fx.id, set }, label);
  };
  return (
    <section className="inspector-section">
      <h3>
        <span className="grow">{t('video.effects')}</span>
        <PresetMenu kind="clip-effects" targetId={clip.id} {...(effects.length ? { sourceId: clip.id } : {})} canEdit={ctx.store.getState().canEdit()} className="btn btn-sm btn-ghost" />
        <MenuButton
          className="icon-btn sm"
          label="Add effect"
          items={[
            { label: t('filters.colorGrade'), onSelect: () => s.commit({ kind: 'listInsert', id: clip.id, prop: 'effects', items: [{ id: `fx_${Math.random().toString(36).slice(2, 10)}`, effect: 'colorGrade', params: { ...COLOR_GRADE_DEFAULTS }, enabled: true }] }, `Add ${t('filters.colorGrade')}`) },
            ...FILTERS.map((f) => ({ label: t(`filters.${f}`), onSelect: () => s.commit({ kind: 'listInsert', id: clip.id, prop: 'effects', items: [{ id: `fx_${Math.random().toString(36).slice(2, 10)}`, effect: f, params: { ...FILTER_DEFAULTS[f] }, enabled: true }] }, `Add ${t(`filters.${f}`)}`) })),
          ]}
        >
          <Plus />
        </MenuButton>
      </h3>
      {effects.map((fx, i) => (
        <div key={fx.id} className="filter-card">
          <div className="row" style={{ gap: 4 }}>
            <strong className="grow" style={{ fontSize: 'var(--fs-sm)' }}>
              {t(`filters.${fx.effect}`)}
            </strong>
            <IconButton small label={fx.enabled ? 'Turn off' : 'Turn on'} pressed={!fx.enabled} onClick={() => commitFx(fx, { enabled: !fx.enabled }, 'Toggle effect')}>
              {fx.enabled ? <Eye /> : <EyeOff />}
            </IconButton>
            <IconButton small label={t('app.remove')} onClick={() => s.commit({ kind: 'listRemove', id: clip.id, prop: 'effects', index: i, count: 1 }, 'Remove effect')}>
              <Trash2 />
            </IconButton>
          </div>
          {fx.effect === 'colorGrade' && fx.assetId && <p className="muted" style={{ fontSize: 'var(--fs-xs)' }}>{t('video.gradeLook')}</p>}
          {Object.entries(fx.params)
            .filter(([k]) => k !== 'seed' && (k !== 'intensity' || (fx.effect === 'colorGrade' && fx.assetId)))
            .map(([k, val]) => (
              <NumberField
                key={k}
                compact
                label={fx.effect === 'colorGrade' ? t(`video.grade.${k as 'exposure'}`) : k === 'amount' ? t('adjust.amount') : k === 'radius' ? 'Radius' : k === 'size' ? t('image.size') : k}
                value={val}
                {...effectRange(fx.effect, k)}
                onInput={(x) => s.setTransient(clip.id, { effects: effects.map((e) => (e.id === fx.id ? { ...e, params: { ...e.params, [k]: x } } : e)) })}
                onCommit={(x) => commitFx(fx, { params: { ...fx.params, [k]: x } }, 'Adjust effect')}
              />
            ))}
        </div>
      ))}
    </section>
  );
}

function BackgroundSection({ ctx, clip }: { ctx: TimelineCtx; clip: SceneNode<'clip'> }) {
  const s = ctx.store.getState();
  const br = clip.props.backgroundRemoval ?? { enabled: false, method: 'chroma' as const, keyColor: '#00b140', tolerance: 60, softness: 20 };
  const set = (patch: Partial<typeof br>) => s.commit({ kind: 'update', id: clip.id, set: { backgroundRemoval: { ...br, ...patch } } }, t('video.removeBackground'));
  return (
    <section className="inspector-section">
      <h3>{t('video.removeBackground')}</h3>
      <Switch checked={br.enabled} onChange={(v) => set({ enabled: v })} label={t('video.removeBackground')} />
      {br.enabled && (
        <>
          <Select
            label="Method"
            value={br.method === 'provider' ? 'auto' : br.method}
            options={[
              { value: 'chroma', label: 'Green or blue screen (chroma key)' },
              { value: 'auto', label: 'Automatic (subject from background)' },
            ]}
            onChange={(v) => set({ method: v })}
          />
          {br.method === 'chroma' && <ColorField label={t('video.keyColor')} value={br.keyColor} onChange={(v) => set({ keyColor: v })} />}
          <NumberField compact label={t('image.tolerance')} value={br.tolerance} min={1} max={255} onCommit={(v) => set({ tolerance: v })} />
          <NumberField compact label={t('video.softness')} value={br.softness} min={0} max={100} onCommit={(v) => set({ softness: v })} />
        </>
      )}
    </section>
  );
}

/* ---------------- animation layer ---------------- */

function AnimLayerInspector({ ctx, layer }: { ctx: TimelineCtx; layer: SceneNode<'animLayer'> }) {
  const p = layer.props;
  const s = ctx.store.getState();
  const time = useStore(ctx.ed, (st) => st.time);
  const anim = useAnimated(ctx, layer.id, p.start, p.keyframes);
  const tr = animLayerTransform(p, time);
  const upd = (set: Record<string, unknown>, label: string) => s.commit({ kind: 'update', id: layer.id, set }, label);
  const easing = anim.easingAtPlayhead();
  return (
    <>
      <section className="inspector-section">
        <h3>Animation layer</h3>
        <input className="input sm" aria-label={t('app.rename')} value={p.name} onChange={(e) => s.setTransient(layer.id, { name: e.target.value })} onBlur={() => s.commitTransient('Rename layer')} />
        <div className="grid-2">
          <NumberField compact slider={false} label="Start" value={p.start} min={0} max={36000} step={0.01} unit="s" onCommit={(v) => upd({ start: v }, 'Move layer in time')} />
          <NumberField compact slider={false} label={t('video.duration')} value={p.duration} min={0.04} max={36000} step={0.01} unit="s" onCommit={(v) => upd({ duration: v }, 'Change layer duration')} />
        </div>
        <Select
          label={t('anim.playback')}
          value={p.playback}
          options={(['once', 'loop', 'pingpong'] as const).map((m) => ({ value: m, label: t(`anim.playbackModes.${m}`) }))}
          onChange={(v) => upd({ playback: v }, 'Playback mode')}
        />
      </section>
      <section className="inspector-section">
        <h3>
          <span className="grow">{t('anim.tween')}</span>
          <IconButton small label="Previous keyframe" onClick={() => anim.jump(-1)}>
            <ChevronLeft />
          </IconButton>
          <IconButton small label="Next keyframe" onClick={() => anim.jump(1)}>
            <ChevronRight />
          </IconButton>
        </h3>
        {p.motionPath && <p className="muted" style={{ fontSize: 'var(--fs-xs)' }}>Position follows the motion path.</p>}
        {!p.motionPath && (
          <>
            <AnimatedField anim={anim} prop="x" label="X" value={tr.x} min={-4000} max={4000} unit="px" />
            <AnimatedField anim={anim} prop="y" label="Y" value={tr.y} min={-4000} max={4000} unit="px" />
          </>
        )}
        <AnimatedField anim={anim} prop="scale" label={t('video.scale')} value={tr.scale} min={0.05} max={8} step={0.01} unit="×" />
        <AnimatedField anim={anim} prop="rotation" label={t('video.rotation')} value={tr.rotation} min={-720} max={720} unit="°" />
        <AnimatedField anim={anim} prop="opacity" label={t('image.opacity')} value={tr.opacity} min={0} max={1} step={0.01} />
        {easing && <EasingEditor value={easing} onChange={anim.setEasing} label={t('anim.curve')} />}
        <div className="grid-2">
          <NumberField compact slider={false} label="Anchor X" value={p.anchorX} min={-4000} max={4000} onCommit={(v) => upd({ anchorX: v }, 'Move anchor')} />
          <NumberField compact slider={false} label="Anchor Y" value={p.anchorY} min={-4000} max={4000} onCommit={(v) => upd({ anchorY: v }, 'Move anchor')} />
        </div>
        <p className="muted" style={{ fontSize: 'var(--fs-xs)' }}>Set keyframes at two times to tween between them; the curve shapes the motion from the selected key.</p>
      </section>
    </>
  );
}

/* ---------------- track ---------------- */

function TrackInspector({ ctx, track }: { ctx: TimelineCtx; track: SceneNode<'track'> }) {
  const p = track.props;
  const s = ctx.store.getState();
  const projectState = useProject((st) => st.state)!;
  const tracks = tracksOf(projectState, ctx.sequenceId);
  const upd = (set: Record<string, unknown>, label: string) => s.commit({ kind: 'update', id: track.id, set }, label);
  return (
    <section className="inspector-section">
      <h3>{t(`video.trackTypes.${p.trackType}`)} track</h3>
      <input className="input sm" aria-label={t('app.rename')} value={p.name} onChange={(e) => s.setTransient(track.id, { name: e.target.value })} onBlur={() => s.commitTransient('Rename track')} />
      {(p.trackType === 'audio' || p.trackType === 'video') && (
        <>
          <NumberField compact label={t('video.gain')} value={p.gain} min={-60} max={12} step={0.5} unit="dB" onInput={(v) => s.setTransient(track.id, { gain: v })} onCommit={(v) => (s.clearTransient(track.id), upd({ gain: v }, 'Track gain'))} />
          <NumberField compact label={t('video.pan')} value={p.pan} min={-1} max={1} step={0.05} onInput={(v) => s.setTransient(track.id, { pan: v })} onCommit={(v) => (s.clearTransient(track.id), upd({ pan: v }, 'Track pan'))} />
          <Switch checked={p.muted} onChange={(v) => upd({ muted: v }, v ? 'Mute track' : 'Unmute track')} label={t('video.mute')} />
          <Switch checked={p.ducking.enabled} onChange={(v) => upd({ ducking: { ...p.ducking, enabled: v, sourceTrackId: p.ducking.sourceTrackId ?? tracks.find((x) => x.id !== track.id && x.props.trackType !== 'title')?.id ?? null } }, 'Ducking')} label={t('video.ducking')} hint="Lower this track automatically while another track plays (music under dialogue)." />
          {p.ducking.enabled && (
            <>
              <Select
                label="Duck under"
                value={p.ducking.sourceTrackId ?? ''}
                options={tracks.filter((x) => x.id !== track.id && (x.props.trackType === 'audio' || x.props.trackType === 'video')).map((x) => ({ value: x.id, label: x.props.name }))}
                onChange={(v) => upd({ ducking: { ...p.ducking, sourceTrackId: v } }, 'Ducking source')}
              />
              <NumberField compact label={t('video.duckingAmount')} value={p.ducking.amountDb} min={-40} max={0} step={1} unit="dB" onCommit={(v) => upd({ ducking: { ...p.ducking, amountDb: v } }, 'Ducking amount')} />
            </>
          )}
        </>
      )}
      <Switch checked={p.locked} onChange={(v) => upd({ locked: v }, v ? 'Lock track' : 'Unlock track')} label="Locked" />
      {p.trackType !== 'audio' && <Switch checked={p.hidden} onChange={(v) => upd({ hidden: v }, v ? 'Hide track' : 'Show track')} label={t('video.hide')} />}
    </section>
  );
}

/* ---------------- sequence ---------------- */

function SequenceInspector({ ctx }: { ctx: TimelineCtx }) {
  const seq = useProject((s) => s.state?.nodes[ctx.sequenceId]) as SceneNode<'sequence'>;
  const p = seq.props;
  const s = ctx.store.getState();
  const upd = (set: Record<string, unknown>, label: string) => s.commit({ kind: 'update', id: ctx.sequenceId, set }, label);
  const preset = SEQUENCE_PRESETS.find((x) => x.w === p.width && x.h === p.height);
  return (
    <section className="inspector-section">
      <h3>{t('video.sequenceSettings')}</h3>
      <input className="input sm" aria-label={t('app.rename')} value={p.name} onChange={(e) => s.setTransient(ctx.sequenceId, { name: e.target.value })} onBlur={() => s.commitTransient('Rename sequence')} />
      <Select
        label={t('video.resolution')}
        value={preset ? `${preset.w}x${preset.h}` : 'custom'}
        options={[...SEQUENCE_PRESETS.map((x) => ({ value: `${x.w}x${x.h}`, label: `${x.label} · ${x.w}×${x.h}` })), ...(preset ? [] : [{ value: 'custom', label: `Custom · ${p.width}×${p.height}` }])]}
        onChange={(v) => {
          if (v === 'custom') return;
          const [w, h] = v.split('x').map(Number);
          upd({ width: w, height: h }, 'Change resolution');
        }}
      />
      <div className="grid-2">
        <NumberField compact slider={false} label="Width" value={p.width} min={16} max={8192} onCommit={(v) => upd({ width: Math.round(v / 2) * 2 }, 'Change resolution')} />
        <NumberField compact slider={false} label="Height" value={p.height} min={16} max={8192} onCommit={(v) => upd({ height: Math.round(v / 2) * 2 }, 'Change resolution')} />
      </div>
      <Select
        label={t('video.fps')}
        value={String(p.fps)}
        options={[12, 15, 24, 25, 30, 48, 50, 60].map((f) => ({ value: String(f), label: `${f} fps` }))}
        onChange={(v) => upd({ fps: Number(v) }, 'Change frame rate')}
      />
      <NumberField compact slider={false} label={t('video.duration')} value={p.duration} min={0.1} max={36000} step={0.1} unit="s" onCommit={(v) => upd({ duration: v }, 'Change duration')} />
      <ColorField label={t('video.background')} value={p.background} onChange={(v) => upd({ background: v }, 'Change background')} />
      {p.purpose === 'animation' && (
        <Select
          label={t('anim.playback')}
          value={p.playback}
          options={(['once', 'loop', 'pingpong'] as const).map((m) => ({ value: m, label: t(`anim.playbackModes.${m}`) }))}
          onChange={(v) => upd({ playback: v }, 'Playback mode')}
        />
      )}
    </section>
  );
}
