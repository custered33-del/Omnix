import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import type { SceneNode } from '@omnix/core';
import { get, post } from '../lib/api.js';
import { realtime } from '../state/realtime.js';
import { useProjectStore } from '../state/project.js';
import { Dialog, NumberField, Select, Spinner, Switch } from '../ui/primitives.js';
import { formatBytes, t } from '../i18n/index.js';

interface Preset {
  id: string;
  label: string;
  category: 'social' | 'web' | 'broadcast' | 'audio';
  description: string;
  width: number | null;
  height: number | null;
}

interface JobView {
  id: string;
  status: string;
  progress: number;
  message: string;
  error: string | null;
  result: { assetId: string; name: string; size: number; downloadUrl: string; notes: string[] } | null;
}

function formatsFor(node: SceneNode, presets: Preset[]): { group: string; options: { value: string; label: string; hint?: string }[] }[] {
  switch (node.type) {
    case 'canvas':
      return [
        { group: t('export.image'), options: [{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }, { value: 'webp', label: 'WebP' }, { value: 'avif', label: 'AVIF' }, { value: 'svg', label: 'SVG' }] },
        { group: t('export.layered'), options: [{ value: 'psd', label: 'Photoshop (PSD, layered)' }] },
      ];
    case 'sequence': {
      const animation = (node as SceneNode<'sequence'>).props.purpose === 'animation';
      const anim = { group: t('export.animation'), options: [{ value: 'gif', label: 'GIF' }, { value: 'apng', label: 'Animated PNG' }, { value: 'webm', label: 'WebM (with transparency)' }, { value: 'mp4', label: 'MP4' }, { value: 'lottie', label: 'Lottie (JSON)' }, { value: 'spritesheet', label: 'Sprite sheet (PNG)' }, { value: 'spritesheet-json', label: 'Sprite atlas (JSON)' }] };
      const byCat = (cat: Preset['category'], title: string) => ({ group: title, options: presets.filter((p) => p.category === cat).map((p) => ({ value: p.id, label: p.label, hint: p.description })) });
      const video = [byCat('social', t('export.social')), byCat('web', t('export.web')), byCat('broadcast', t('export.broadcast')), byCat('audio', t('export.audio')), { group: t('export.captions'), options: [{ value: 'srt', label: 'SRT subtitles' }, { value: 'vtt', label: 'WebVTT subtitles' }] }];
      return animation ? [anim, ...video] : [...video, { group: t('export.animation'), options: [{ value: 'gif', label: 'GIF' }] }];
    }
    case 'document':
      return [{ group: 'Document', options: [{ value: 'docx', label: 'Word (DOCX)' }, { value: 'pdf', label: 'PDF' }, { value: 'md', label: 'Markdown' }, { value: 'html', label: 'HTML' }] }];
    case 'deck':
      return [{ group: 'Slides', options: [{ value: 'pptx', label: 'PowerPoint (PPTX)' }, { value: 'pdf', label: 'PDF' }] }];
    case 'codeWorkspace':
      return [{ group: 'Code', options: [{ value: 'zip', label: 'ZIP of all files' }, { value: 'ipynb', label: 'Jupyter notebook (.ipynb)' }] }];
    default:
      return [];
  }
}

export function ExportDialog({ node, onClose }: { node: SceneNode; onClose: () => void }) {
  const store = useProjectStore();
  const projectId = store.getState().projectId;
  const [presets, setPresets] = useState<Preset[]>([]);
  const groups = formatsFor(node, presets);
  const [format, setFormat] = useState<string>(groups[0]?.options[0]?.value ?? 'png');
  const [scale, setScale] = useState(1);
  const [quality, setQuality] = useState(90);
  const [transparent, setTransparent] = useState(false);
  const [colorProfile, setColorProfile] = useState<'srgb' | 'display-p3'>('srgb');
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (node.type === 'sequence') get<{ video: Preset[] }>('/api/export/presets').then((r) => setPresets(r.video), () => {});
  }, [node.type]);
  useEffect(() => {
    if (node.type === 'sequence' && presets.length && !groups.some((g) => g.options.some((o) => o.value === format))) setFormat(groups[0]!.options[0]!.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presets]);
  useEffect(() => {
    if (!job) return;
    return realtime.on('job', (m: { job: JobView }) => {
      if (m.job.id === job.id) setJob(m.job);
    });
  }, [job?.id]);

  const isImage = node.type === 'canvas';
  const isAnim = ['gif', 'apng', 'webm', 'mp4', 'spritesheet'].includes(format) && node.type === 'sequence';
  const all = groups.flatMap((g) => g.options);
  const hint = all.find((o) => o.value === format)?.hint;
  const running = job && !['done', 'failed', 'cancelled'].includes(job.status);

  return (
    <Dialog
      title={t('export.title')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('app.close')}
          </button>
          {job?.status === 'done' && job.result ? (
            <a className="btn btn-primary" href={job.result.downloadUrl} download={job.result.name}>
              <Download /> {t('export.download')} ({formatBytes(job.result.size)})
            </a>
          ) : (
            <button
              className="btn btn-primary"
              disabled={!!running}
              onClick={async () => {
                setError(null);
                try {
                  const r = await post<{ job: JobView }>(`/api/projects/${projectId}/export`, {
                    nodeId: node.id,
                    format,
                    ...(isImage || isAnim ? { scale } : {}),
                    ...(isImage && ['jpeg', 'webp', 'avif'].includes(format) ? { quality } : {}),
                    ...(transparent ? { transparent } : {}),
                    ...(isImage ? { colorProfile } : {}),
                  });
                  setJob(r.job);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {running ? <Spinner /> : t('export.start')}
            </button>
          )}
        </>
      }
    >
      <div className="col" style={{ gap: 16 }}>
        <div className="field">
          <label className="label" htmlFor="export-format">
            {t('export.format')}
          </label>
          <select id="export-format" className="select" value={format} onChange={(e) => setFormat(e.target.value)}>
            {groups.map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {hint && <span className="hint">{hint}</span>}
        </div>
        {(isImage || isAnim) && format !== 'psd' && format !== 'svg' && <NumberField label={t('export.scale')} value={scale} min={0.1} max={4} step={0.05} unit="×" onCommit={setScale} />}
        {isImage && ['jpeg', 'webp', 'avif'].includes(format) && <NumberField label={t('export.quality')} value={quality} min={10} max={100} onCommit={setQuality} />}
        {((isImage && ['png', 'webp', 'avif'].includes(format)) || ['apng', 'webm', 'gif'].includes(format)) && <Switch checked={transparent} onChange={setTransparent} label={t('export.transparent')} />}
        {isImage && !['svg', 'psd'].includes(format) && (
          <Select
            label={t('export.colorProfile')}
            value={colorProfile}
            onChange={setColorProfile}
            options={[
              { value: 'srgb', label: 'sRGB (web, most screens)' },
              { value: 'display-p3', label: 'Display P3 (wide gamut)' },
            ]}
          />
        )}
        {job && (
          <div className="col" role="status" aria-live="polite">
            <div className="row" style={{ fontSize: 'var(--fs-sm)' }}>
              <span className="grow">{job.status === 'done' ? t('export.ready') : job.status === 'failed' ? `${t('export.failed')}: ${job.error ?? ''}` : job.message || t('export.working')}</span>
              <span className="tabular muted">{Math.round(job.progress * 100)}%</span>
            </div>
            <div className="progress">
              <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
            </div>
            {job.result?.notes?.map((n) => (
              <p key={n} className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
                {n}
              </p>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
