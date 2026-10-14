import { useEffect, useRef, useState } from 'react';
import { Search, Upload } from 'lucide-react';
import { get, uploadFile, thumbUrl, type AssetSummary } from '../lib/api.js';
import { Dialog, Spinner } from '../ui/primitives.js';
import { toast } from '../ui/toast.js';
import { formatBytes, formatDuration, t } from '../i18n/index.js';

type Kind = AssetSummary['kind'];

const ACCEPT: Partial<Record<Kind, string>> = {
  image: 'image/*,.psd',
  video: 'video/*',
  audio: 'audio/*',
  lut: '.cube',
  font: '.ttf,.otf,.woff,.woff2',
  data: '.csv,.json,.tsv',
};

/**
 * Choose an asset from the library (or upload a new one). Used by every editor that places media.
 */
export function AssetPicker(props: { kinds: Kind[]; title?: string; projectId?: string; multiple?: boolean; /** Only files of this type (e.g. PSDs among "other"). */ mime?: string; accept?: string; onPick: (assets: AssetSummary[]) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [assets, setAssets] = useState<AssetSummary[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [uploading, setUploading] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const p = new URLSearchParams({ limit: '200' });
      if (q) p.set('q', q);
      if (props.kinds.length === 1) p.set('kind', props.kinds[0]!);
      get<{ assets: AssetSummary[] }>(`/api/assets?${p}`).then(
        (r) => setAssets(r.assets.filter((a) => props.kinds.includes(a.kind) && !a.tags.includes('mask') && (!props.mime || a.mime === props.mime))),
        (e) => toast.error(e.message),
      );
    }, 120);
    return () => window.clearTimeout(timer);
  }, [q, props.kinds.join(',')]);

  const upload = async (files: FileList) => {
    const out: AssetSummary[] = [];
    for (const f of Array.from(files)) {
      setUploading(0);
      try {
        const r = await uploadFile(f, { ...(props.projectId ? { projectId: props.projectId } : {}), onProgress: setUploading });
        out.push(r.asset);
      } catch (e) {
        toast.error((e as Error).message);
      }
    }
    setUploading(null);
    if (out.length) {
      props.onPick(out);
      props.onClose();
    }
  };

  const choose = (a: AssetSummary) => {
    if (!props.multiple) {
      props.onPick([a]);
      props.onClose();
      return;
    }
    setPicked((p) => (p.includes(a.id) ? p.filter((x) => x !== a.id) : [...p, a.id]));
  };

  const accept = props.accept ?? props.kinds.map((k) => ACCEPT[k]).filter(Boolean).join(',');
  return (
    <Dialog
      title={props.title ?? t('assets.insert')}
      wide
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={() => fileRef.current?.click()} disabled={uploading !== null}>
            {uploading !== null ? <Spinner /> : <Upload />} {t('assets.upload')}
          </button>
          <input ref={fileRef} type="file" hidden multiple={props.multiple} accept={accept || undefined} onChange={(e) => e.target.files && void upload(e.target.files)} />
          <span className="spacer" />
          <button className="btn" onClick={props.onClose}>
            {t('app.cancel')}
          </button>
          {props.multiple && (
            <button
              className="btn btn-primary"
              disabled={!picked.length}
              onClick={() => {
                props.onPick(picked.map((id) => assets!.find((a) => a.id === id)!).filter(Boolean));
                props.onClose();
              }}
            >
              {t('assets.insert')} {picked.length > 0 && `(${picked.length})`}
            </button>
          )}
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <div className="row" style={{ position: 'relative' }}>
          <Search size={16} className="muted" style={{ position: 'absolute', left: 10 }} aria-hidden="true" />
          <input className="input" data-autofocus style={{ paddingLeft: 32 }} placeholder={t('assets.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('app.search')} />
        </div>
        {uploading !== null && (
          <div className="progress" role="progressbar" aria-valuenow={Math.round(uploading * 100)}>
            <span style={{ width: `${Math.round(uploading * 100)}%` }} />
          </div>
        )}
        {!assets && <Spinner />}
        {assets && assets.length === 0 && <p className="muted">{t('assets.empty')}</p>}
        {assets && assets.length > 0 && (
          <ul className="picker-grid" role="listbox" aria-multiselectable={props.multiple} aria-label={t('assets.title')}>
            {assets.map((a) => (
              <li key={a.id} role="option" aria-selected={picked.includes(a.id)}>
                <button className="picker-item" onClick={() => choose(a)} onDoubleClick={() => props.multiple && (props.onPick([a]), props.onClose())} title={a.name}>
                  <span className="picker-thumb" style={a.hasThumbnail ? { backgroundImage: `url(${thumbUrl(a.id)})` } : undefined}>
                    {!a.hasThumbnail && <span className="badge">{t(`assets.kinds.${a.kind}`)}</span>}
                  </span>
                  <span className="truncate" style={{ display: 'block', fontSize: 'var(--fs-sm)' }}>
                    {a.name}
                  </span>
                  <span className="muted" style={{ display: 'block', fontSize: 'var(--fs-xs)' }}>
                    {a.width ? `${a.width}×${a.height}` : formatBytes(a.size)}
                    {a.duration ? ` · ${formatDuration(a.duration)}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
