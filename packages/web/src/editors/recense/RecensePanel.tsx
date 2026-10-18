import { useState } from 'react';
import { AudioWaveform, Sparkles, Zap } from 'lucide-react';
import type { EditFxKind, EditStyle, Operation, SceneNode, TransitionKind, VelocityStyle } from '@omnix/core';
import { beatEffectOps, EDIT_FX_KINDS, EDIT_FX_LENGTH, EDIT_STYLE_NAMES, EDIT_STYLES, EDIT_TRANSITION_LENGTH, fxClipProps, makeNode, tracksOf, VELOCITY_RAMPS } from '@omnix/core';
import { useStore } from 'zustand';
import { useProject } from '../../state/project.js';
import { post } from '../../lib/api.js';
import { toast } from '../../ui/toast.js';
import { Spinner } from '../../ui/primitives.js';
import { t } from '../../i18n/index.js';
import type { TimelineCtx } from '../video/timelineOps.js';

const EDIT_TRANSITIONS: TransitionKind[] = ['whip-left', 'whip-right', 'zoom-punch', 'spin', 'flash', 'glitch'];
const VELOCITY: { id: VelocityStyle; label: string }[] = [
  { id: 'velocity', label: 'Velocity' },
  { id: 'slowHit', label: 'Slow-mo hit' },
  { id: 'speedUp', label: 'Speed up' },
];

/** Recense: the edit-making tools, above the media list. */
export function RecensePanel({ ctx }: { ctx: TimelineCtx }) {
  const { store, ed, sequenceId } = ctx;
  const seq = useProject((s) => s.state?.nodes[sequenceId]) as SceneNode<'sequence'> | undefined;
  const canEdit = useProject((s) => s.canEdit());
  const projectId = useProject((s) => s.projectId);
  const selected = useStore(ed, (s) => s.selectedClips);
  const [busy, setBusy] = useState<string | null>(null);
  const [fx, setFx] = useState<EditFxKind>('zoomPunch');
  const [every, setEvery] = useState(1);
  if (!seq || !canEdit) return null;
  const beats = seq.props.beats ?? [];
  const commit = (ops: Operation[], label: string) => ops.length && store.getState().commit(ops.length === 1 ? ops[0]! : { kind: 'batch', ops }, label);

  const run = async (key: string, f: () => Promise<void>) => {
    setBusy(key);
    try {
      await f();
    } catch (e) {
      toast.error((e as Error).message);
    }
    setBusy(null);
  };
  const findBeats = () =>
    run('beats', async () => {
      const r = await post<{ bpm: number; beats: number }>(`/api/projects/${projectId}/recense/beats`, { sequenceId });
      toast.success(`Found ${r.beats} beats (${r.bpm} BPM).`);
    });
  const autoEdit = (style: EditStyle) =>
    run(style, async () => {
      const r = await post<{ cuts: number; effects: number }>(`/api/projects/${projectId}/recense/auto`, { sequenceId, style });
      toast.success(`${EDIT_STYLES[style].label} edit: ${r.cuts} cuts, ${r.effects} effects. Press play.`);
    });

  const onBeat = () => {
    const st = store.getState().state!;
    const r = beatEffectOps(st, sequenceId, { effect: fx, beats, every });
    commit(r.ops, `${t(`filters.${fx}`)} on the beat`);
  };
  const atPlayhead = (kind: EditFxKind) => {
    const st = store.getState().state!;
    const ops: Operation[] = [];
    let track = tracksOf(st, sequenceId).find((x) => x.props.trackType === 'effect' && x.props.name === 'Effects');
    if (!track) {
      track = makeNode('track', { name: 'Effects', trackType: 'effect' });
      ops.push({ kind: 'create', parentId: sequenceId, index: 0, nodes: [track] });
    }
    ops.push({ kind: 'create', parentId: track.id, nodes: [makeNode('clip', fxClipProps(kind, ed.getState().time, EDIT_FX_LENGTH[kind]))] });
    commit(ops, `Add ${t(`filters.${kind}`)}`);
  };
  const clips = () => selected.map((id) => store.getState().state!.nodes[id]).filter((n): n is SceneNode<'clip'> => n?.type === 'clip');
  const setTransition = (kind: TransitionKind) => {
    const c = clips();
    if (!c.length) return toast.info('Select the clip that comes after the cut.');
    commit(c.map((n) => ({ kind: 'update', id: n.id, set: { transitionIn: { kind, duration: EDIT_TRANSITION_LENGTH[kind] ?? 0.3, easing: 'ease-in-out' } } })), `${t(`video.transitionKinds.${kind}`)} transition`);
  };
  const setVelocity = (v: VelocityStyle) => {
    const c = clips().filter((n) => n.props.assetId);
    if (!c.length) return toast.info('Select a video clip first.');
    commit(c.map((n) => ({ kind: 'update', id: n.id, set: { speedRamp: VELOCITY_RAMPS[v].map((p) => ({ ...p })), speed: 1 } })), 'Velocity');
  };

  return (
    <div className="recense-panel" aria-label="Recense">
      <section>
        <h3>
          <Zap aria-hidden="true" /> Make an edit
        </h3>
        <p className="muted">Add your clips and a song (on the Music track), then pick a style.</p>
        <button className="btn btn-sm" onClick={findBeats} disabled={!!busy}>
          {busy === 'beats' ? <Spinner /> : <AudioWaveform />} {beats.length ? `Beats: ${beats.length}${seq.props.bpm ? ` · ${seq.props.bpm} BPM` : ''}` : 'Find the beats'}
        </button>
        <div className="recense-styles" role="group" aria-label="Edit styles">
          {EDIT_STYLE_NAMES.map((s) => (
            <button key={s} className="btn btn-sm" onClick={() => autoEdit(s)} disabled={!!busy}>
              {busy === s ? <Spinner /> : <Sparkles />} {EDIT_STYLES[s].label}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3>On the beat</h3>
        <div className="row recense-row">
          <select className="select sm" aria-label="Effect" value={fx} onChange={(e) => setFx(e.target.value as EditFxKind)}>
            {EDIT_FX_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`filters.${k}`)}
              </option>
            ))}
          </select>
          <select className="select sm" aria-label="How often" value={every} onChange={(e) => setEvery(Number(e.target.value))}>
            <option value={1}>Every beat</option>
            <option value={2}>Every 2nd</option>
            <option value={4}>Every 4th</option>
            <option value={8}>Every 8th</option>
          </select>
          <button className="btn btn-sm" onClick={onBeat} disabled={!beats.length} title={beats.length ? undefined : 'Find the beats first'}>
            Add
          </button>
        </div>
      </section>
      <section>
        <h3>Effect at the playhead</h3>
        <div className="recense-chips">
          {EDIT_FX_KINDS.map((k) => (
            <button key={k} className="chip" onClick={() => atPlayhead(k)}>
              {t(`filters.${k}`)}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3>Transition into the selected clip</h3>
        <div className="recense-chips">
          {EDIT_TRANSITIONS.map((k) => (
            <button key={k} className="chip" onClick={() => setTransition(k)}>
              {t(`video.transitionKinds.${k}`)}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3>Speed of the selected clip</h3>
        <div className="recense-chips">
          {VELOCITY.map((v) => (
            <button key={v.id} className="chip" onClick={() => setVelocity(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
