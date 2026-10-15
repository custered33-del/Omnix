import { useEffect, useRef, useState } from 'react';
import { Captions, FileUp, Plus } from 'lucide-react';
import type { SceneNode } from '@omnix/core';
import { clipsOf, tracksOf } from '@omnix/core';
import { get, post } from '../../lib/api.js';
import { watchJob } from '../../state/jobs.js';
import { useProject } from '../../state/project.js';
import { Dialog, Spinner } from '../../ui/primitives.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../i18n/index.js';
import { addTitle, type TimelineCtx } from './timelineOps.js';

interface Provider {
  id: string;
  label: string;
  transcribes: boolean;
}

/**
 * Captions: generate them from speech (transcription service, or speech detection that leaves
 * timed slots to type into), import SRT/VTT, or add one by hand. Captions are ordinary title clips.
 */
export function CaptionsDialog({ ctx, onClose }: { ctx: TimelineCtx; onClose: () => void }) {
  const projectId = ctx.store.getState().projectId;
  const [provider, setProvider] = useState<Provider | null>(null);
  const [job, setJob] = useState<{ id: string; status: string; progress: number; message: string; error: string | null; result?: { count: number; hasText: boolean } | null } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const st = useProject((s) => s.state)!;
  const captions = tracksOf(st, ctx.sequenceId)
    .filter((tr) => tr.props.trackType === 'title')
    .flatMap((tr) => clipsOf(st, tr.id))
    .filter((c) => c.props.title?.caption);

  useEffect(() => {
    get<Provider>('/api/captions/provider').then(setProvider, () => {});
  }, []);
  useEffect(() => {
    if (!job) return;
    return watchJob<NonNullable<typeof job>>(job.id, setJob);
  }, [job?.id]);
  useEffect(() => {
    if (job?.status === 'done') toast.success(job.result?.hasText ? `Added ${job.result.count} captions` : `Found ${job.result?.count ?? 0} stretches of speech. Type the words into each caption.`);
    if (job?.status === 'failed') toast.error(job.error ?? 'Caption generation failed');
  }, [job?.status]);

  const generate = async () => {
    try {
      const r = await post<{ job: NonNullable<typeof job> }>(`/api/projects/${projectId}/captions/generate`, { sequenceId: ctx.sequenceId });
      setJob(r.job);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const importFile = async (f: File) => {
    try {
      const text = await f.text();
      const r = await post<{ count: number }>(`/api/projects/${projectId}/captions/import`, { sequenceId: ctx.sequenceId, text });
      toast.success(`Imported ${r.count} captions`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const running = job && !['done', 'failed', 'cancelled'].includes(job.status);
  return (
    <Dialog title={t('video.captions')} icon={<Captions />} onClose={onClose} wide>
      <div className="col" style={{ gap: 16 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => void generate()} disabled={!!running}>
            {running ? <Spinner /> : <Captions />} {t('video.generateCaptions')}
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            <FileUp /> {t('video.importCaptions')}
          </button>
          <input ref={fileRef} type="file" hidden accept=".srt,.vtt,text/vtt,application/x-subrip" onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
          <button className="btn" onClick={() => addTitle(ctx, true)}>
            <Plus /> Add caption at playhead
          </button>
        </div>
        {provider && !provider.transcribes && <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>{t('video.captionsVadNote')}</p>}
        {provider?.transcribes && <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Transcription by {provider.label}.</p>}
        {running && (
          <div className="col" role="status" aria-live="polite">
            <span style={{ fontSize: 'var(--fs-sm)' }}>{job!.message || 'Listening for speech…'}</span>
            <div className="progress">
              <span style={{ width: `${Math.round(job!.progress * 100)}%` }} />
            </div>
          </div>
        )}
        <div>
          <h3 style={{ fontSize: 'var(--fs-md)', marginBottom: 8 }}>
            {captions.length} {captions.length === 1 ? 'caption' : 'captions'}
          </h3>
          {captions.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: 340 }}>
              <table className="data-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th scope="col">Start</th>
                    <th scope="col">End</th>
                    <th scope="col">Text</th>
                  </tr>
                </thead>
                <tbody>
                  {captions.map((c) => (
                    <CaptionRow key={c.id} ctx={ctx} clip={c} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function CaptionRow({ ctx, clip }: { ctx: TimelineCtx; clip: SceneNode<'clip'> }) {
  const p = clip.props;
  const s = ctx.store.getState();
  const end = p.start + (p.out - p.in) / p.speed;
  return (
    <tr>
      <td className="num">
        <button className="btn btn-sm btn-ghost tabular" onClick={() => ctx.ed.getState().set({ time: p.start, selectedClips: [clip.id] })}>
          {p.start.toFixed(2)}
        </button>
      </td>
      <td className="num tabular">{end.toFixed(2)}</td>
      <td style={{ width: '100%' }}>
        <input
          className="input sm"
          style={{ width: '100%' }}
          aria-label={`Caption at ${p.start.toFixed(2)} seconds`}
          defaultValue={p.title!.text}
          placeholder="Type what is said…"
          onBlur={(e) => e.target.value !== p.title!.text && s.commit({ kind: 'update', id: clip.id, set: { title: { ...p.title!, text: e.target.value } } }, 'Edit caption')}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </td>
    </tr>
  );
}
