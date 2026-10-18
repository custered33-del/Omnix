import { useEffect, useRef, useState } from 'react';
import { Upload, Plus, Film, Music, Image as ImageIcon, Type, Captions } from 'lucide-react';
import { referencedAssets } from '@omnix/core';
import { get, uploadFile, thumbUrl, type AssetSummary } from '../../lib/api.js';
import { realtime } from '../../state/realtime.js';
import { AssetPicker } from '../../components/AssetPicker.js';
import { IconButton, Spinner } from '../../ui/primitives.js';
import { toast } from '../../ui/toast.js';
import { formatDuration, t } from '../../i18n/index.js';
import { ASSET_MIME } from './Timeline.js';
import { addAssetClip, addTitle, type TimelineCtx } from './timelineOps.js';

/** Media used by this project, ready to drag onto the timeline. */
export function MediaBin({ ctx, onCaptions, top }: { ctx: TimelineCtx; onCaptions: () => void; top?: React.ReactNode }) {
  const projectId = ctx.store.getState().projectId;
  const [assets, setAssets] = useState<AssetSummary[] | null>(null);
  const [picker, setPicker] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const canEdit = ctx.store.getState().canEdit();

  // Project uploads plus anything already on the timeline (library media placed from other projects).
  const load = async () => {
    try {
      const r = await get<{ assets: AssetSummary[] }>(`/api/assets?projectId=${projectId}&limit=300`);
      const list = r.assets.filter((a) => ['video', 'audio', 'image'].includes(a.kind) && !a.tags.includes('mask'));
      const state = ctx.store.getState().state;
      const missing = state ? [...referencedAssets(state)].filter((id) => !list.some((a) => a.id === id)) : [];
      const extra = await Promise.all(missing.map((id) => get<{ asset: AssetSummary }>(`/api/assets/${id}`).then((x) => x.asset, () => null)));
      setAssets([...list, ...extra.filter((a): a is AssetSummary => !!a && ['video', 'audio', 'image'].includes(a.kind) && !a.tags.includes('mask'))]);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    // Proxies and waveforms finish in the background; refresh when jobs complete.
    return realtime.on('job', (m: { job: { kind: string; status: string } }) => {
      if (m.job.status === 'done' && (m.job.kind?.startsWith('asset') || m.job.kind === 'video-fill')) void load();
    });
  }, [projectId]);

  const upload = async (files: FileList) => {
    for (const f of Array.from(files)) {
      setUploading(0);
      try {
        const r = await uploadFile(f, { projectId, onProgress: setUploading });
        setAssets((cur) => [r.asset, ...(cur ?? []).filter((x) => x.id !== r.asset.id)]);
      } catch (e) {
        toast.error((e as Error).message);
      }
    }
    setUploading(null);
  };

  return (
    <aside
      className="tl-media"
      aria-label={t('video.media')}
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        void upload(e.dataTransfer.files);
      }}
    >
      <div className="panel-header">
        <span className="grow">{t('video.media')}</span>
        {canEdit && (
          <>
            <IconButton small label={t('assets.upload')} onClick={() => fileRef.current?.click()}>
              {uploading !== null ? <Spinner /> : <Upload />}
            </IconButton>
            <IconButton small label="Add from library" onClick={() => setPicker(true)}>
              <Plus />
            </IconButton>
          </>
        )}
        <input ref={fileRef} type="file" hidden multiple accept="video/*,audio/*,image/*" onChange={(e) => e.target.files && void upload(e.target.files)} />
      </div>
      {top}
      {canEdit && (
        <div className="col" style={{ gap: 6, padding: '8px 12px' }}>
          <button className="btn btn-sm" onClick={() => addTitle(ctx)}>
            <Type /> {t('video.addTitle')}
          </button>
          <button className="btn btn-sm" onClick={onCaptions}>
            <Captions /> {t('video.captions')}
          </button>
        </div>
      )}
      {uploading !== null && (
        <div className="progress" style={{ margin: '0 12px' }}>
          <span style={{ width: `${Math.round(uploading * 100)}%` }} />
        </div>
      )}
      {!assets && <Spinner />}
      {assets && assets.length === 0 && <p className="muted" style={{ padding: 12, fontSize: 'var(--fs-sm)' }}>{t('video.dropMedia')}. Drop files here to upload.</p>}
      <ul style={{ listStyle: 'none', margin: 0, padding: '4px 6px' }} aria-label="Project media">
        {assets?.map((a) => (
          <li key={a.id}>
            <div
              className="media-item"
              draggable
              tabIndex={0}
              role="button"
              aria-label={`${a.name}. Press Enter to add at the end of the timeline, or drag onto a track.`}
              onDragStart={(e) => {
                e.dataTransfer.setData(ASSET_MIME, JSON.stringify(a));
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onKeyDown={(e) => e.key === 'Enter' && canEdit && addAssetClip(ctx, a)}
              onDoubleClick={() => canEdit && addAssetClip(ctx, a)}
              title={a.name}
            >
              <span className="media-thumb" style={a.hasThumbnail ? { backgroundImage: `url(${thumbUrl(a.id)})` } : undefined}>
                {!a.hasThumbnail && (a.kind === 'audio' ? <Music size={16} /> : a.kind === 'video' ? <Film size={16} /> : <ImageIcon size={16} />)}
              </span>
              <span className="col" style={{ gap: 0, minWidth: 0 }}>
                <span className="truncate">{a.name}</span>
                <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                  {t(`assets.kinds.${a.kind}`)}
                  {a.duration ? ` · ${formatDuration(a.duration)}` : ''}
                  {a.proxyStatus === 'pending' ? ` · ${t('assets.proxyPending')}` : ''}
                </span>
              </span>
            </div>
          </li>
        ))}
      </ul>
      {picker && (
        <AssetPicker
          kinds={['video', 'audio', 'image']}
          multiple
          projectId={projectId}
          onPick={(picked) => {
            setAssets((cur) => [...picked, ...(cur ?? []).filter((x) => !picked.some((p) => p.id === x.id))]);
            for (const a of picked) addAssetClip(ctx, a);
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </aside>
  );
}
