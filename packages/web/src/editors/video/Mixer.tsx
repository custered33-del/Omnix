import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { Headphones, Volume2, VolumeX } from 'lucide-react';
import type { SceneNode } from '@omnix/core';
import { tracksOf } from '@omnix/core';
import { useProject } from '../../state/project.js';
import { t } from '../../i18n/index.js';
import type { PlaybackEngine } from './playback.js';
import type { TimelineCtx } from './timelineOps.js';

/** Audio mixer: a channel strip per track with gain, pan, mute, solo, ducking state and a live meter. */
export function Mixer({ ctx, engine }: { ctx: TimelineCtx; engine: PlaybackEngine | null }) {
  const state = useProject((s) => s.state)!;
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  const solo = useStore(ctx.ed, (s) => s.soloTracks);
  const tracks = tracksOf(state, ctx.sequenceId).filter((tr) => tr.props.trackType === 'audio' || tr.props.trackType === 'video');
  const s = ctx.store.getState();
  if (!tracks.length) return <p className="muted" style={{ padding: 16 }}>Add an audio or video track to mix its sound.</p>;
  return (
    <div className="mixer" role="group" aria-label={t('video.mixer')} style={{ padding: 12 }}>
      {tracks.map((tr) => {
        const p = tr.props;
        const upd = (set: Record<string, unknown>, label: string) => s.commit({ kind: 'update', id: tr.id, set }, label);
        const source = p.ducking.enabled && p.ducking.sourceTrackId ? (state.nodes[p.ducking.sourceTrackId] as SceneNode<'track'> | undefined) : undefined;
        return (
          <div key={tr.id} className="strip">
            <strong className="truncate" style={{ width: '100%', textAlign: 'center' }} title={p.name}>
              {p.name}
            </strong>
            <div className="row" style={{ gap: 6, alignItems: 'stretch' }}>
              <input
                type="range"
                className="vfader"
                min={-60}
                max={12}
                step={0.5}
                value={p.gain}
                disabled={!canEdit}
                aria-label={`${p.name} ${t('video.gain')}`}
                aria-valuetext={`${p.gain} dB`}
                onChange={(e) => s.setTransient(tr.id, { gain: Number(e.target.value) })}
                onPointerUp={(e) => (s.clearTransient(tr.id), upd({ gain: Number((e.target as HTMLInputElement).value) }, 'Track gain'))}
                onKeyUp={(e) => (s.clearTransient(tr.id), upd({ gain: Number((e.target as HTMLInputElement).value) }, 'Track gain'))}
              />
              <Meter engine={engine} trackId={tr.id} />
            </div>
            <span className="tabular">{p.gain > 0 ? '+' : ''}{p.gain} dB</span>
            <input
              type="range"
              className="range"
              min={-1}
              max={1}
              step={0.05}
              value={p.pan}
              disabled={!canEdit}
              style={{ width: 70 }}
              aria-label={`${p.name} ${t('video.pan')}`}
              aria-valuetext={p.pan === 0 ? 'Centre' : p.pan < 0 ? `${Math.round(-p.pan * 100)}% left` : `${Math.round(p.pan * 100)}% right`}
              onChange={(e) => s.setTransient(tr.id, { pan: Number(e.target.value) })}
              onPointerUp={(e) => (s.clearTransient(tr.id), upd({ pan: Number((e.target as HTMLInputElement).value) }, 'Track pan'))}
              onDoubleClick={() => upd({ pan: 0 }, 'Centre pan')}
            />
            <span className="muted">{p.pan === 0 ? 'C' : p.pan < 0 ? `L${Math.round(-p.pan * 100)}` : `R${Math.round(p.pan * 100)}`}</span>
            <div className="row" style={{ gap: 2 }}>
              <button className="icon-btn xs" aria-pressed={p.muted} aria-label={`${t('video.mute')} ${p.name}`} disabled={!canEdit} onClick={() => upd({ muted: !p.muted }, p.muted ? 'Unmute track' : 'Mute track')}>
                {p.muted ? <VolumeX /> : <Volume2 />}
              </button>
              <button className="icon-btn xs" aria-pressed={solo.includes(tr.id)} aria-label={`${t('video.solo')} ${p.name}`} onClick={() => ctx.ed.getState().set({ soloTracks: solo.includes(tr.id) ? solo.filter((x) => x !== tr.id) : [...solo, tr.id] })}>
                <Headphones />
              </button>
            </div>
            {source && (
              <span className="badge" title={`Ducks ${p.ducking.amountDb} dB under ${source.props.name}`}>
                ducks under {source.props.name}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Meter({ engine, trackId }: { engine: PlaybackEngine | null; trackId: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let shown = 0;
    const tick = () => {
      const v = engine?.level(trackId) ?? 0;
      // Fast attack, slow release, on a dB-ish scale.
      const db = v > 0 ? Math.max(0, 1 + Math.log10(v) / 3) : 0;
      shown = db > shown ? db : shown * 0.92;
      if (ref.current) ref.current.style.height = `${Math.round(shown * 100)}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, trackId]);
  return (
    <div className="meter" aria-hidden="true">
      <span ref={ref} />
    </div>
  );
}
