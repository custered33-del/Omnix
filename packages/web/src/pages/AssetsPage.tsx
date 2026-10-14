import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Upload, Link2, X, Search, Plus, Download, Trash2 } from 'lucide-react';
import { del, get, patch, post, uploadFile, assetUrl, thumbUrl, type AssetSummary } from '../lib/api.js';
import { Dialog, Spinner } from '../ui/primitives.js';
import { toast } from '../ui/toast.js';
import { formatBytes, formatDuration, formatRelative, t } from '../i18n/index.js';

const KINDS = ['image', 'video', 'audio', 'lut', 'font', 'text', 'data', 'other'] as const;

interface AssetDetail extends AssetSummary {
  exif?: Record<string, string | number>;
  colorSpace?: string | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  source?: { kind: string; url?: string };
}

export function AssetsPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<string>('');
  const [tag, setTag] = useState<string>('');
  const [data, setData] = useState<{ assets: AssetSummary[]; tags: string[]; total: number } | null>(null);
  const [uploads, setUploads] = useState<{ name: string; progress: number }[]>([]);
  const [over, setOver] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const focus = params.get('focus');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    const p = new URLSearchParams({ limit: '300' });
    if (q) p.set('q', q);
    if (kind) p.set('kind', kind);
    if (tag) p.set('tag', tag);
    get<{ assets: AssetSummary[]; tags: string[]; total: number }>(`/api/assets?${p}`).then(setData, (e) => toast.error(e.message));
  }, [q, kind, tag]);
  useEffect(() => {
    const id = window.setTimeout(load, 150);
    return () => window.clearTimeout(id);
  }, [load]);

  const upload = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      setUploads((u) => [...u, { name: f.name, progress: 0 }]);
      try {
        const r = await uploadFile(f, { onProgress: (p) => setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, progress: p } : x))) });
        toast.success(r.deduplicated ? t('assets.duplicate', { name: f.name }) : t('assets.uploaded', { name: f.name }));
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setUploads((u) => u.filter((x) => x.name !== f.name));
      }
    }
    load();
  };

  return (
    <div
      className="page"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void upload(e.dataTransfer.files);
      }}
    >
      <header className="page-header">
        <div className="grow">
          <h1>{t('assets.title')}</h1>
          {data && <p className="subtitle">{data.total} items · identical files are stored once</p>}
        </div>
        <button className="btn" onClick={() => setUrlOpen(true)}>
          <Link2 /> {t('assets.importUrl')}
        </button>
        <button className="btn btn-primary" onClick={() => fileRef.current?.click()}>
          <Upload /> {t('assets.upload')}
        </button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => e.target.files && void upload(e.target.files)} />
      </header>

      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 20, gap: 12 }}>
        <div className="row" style={{ position: 'relative', width: 320 }}>
          <Search size={16} className="muted" style={{ position: 'absolute', left: 10 }} aria-hidden="true" />
          <input className="input" style={{ paddingLeft: 32 }} placeholder={t('assets.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('app.search')} />
        </div>
        <div className="segmented" role="group" aria-label="Kind">
          <button aria-pressed={kind === ''} onClick={() => setKind('')}>
            {t('assets.filterAll')}
          </button>
          {KINDS.slice(0, 5).map((k) => (
            <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {t(`assets.kinds.${k}`)}
            </button>
          ))}
        </div>
        {data && data.tags.length > 0 && (
          <select className="select" style={{ width: 180 }} value={tag} onChange={(e) => setTag(e.target.value)} aria-label={t('assets.tags')}>
            <option value="">{t('assets.tags')}: {t('assets.filterAll')}</option>
            {data.tags.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        )}
      </div>

      {uploads.length > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }} role="status">
          {uploads.map((u) => (
            <div key={u.name} className="col" style={{ gap: 4, marginBottom: 8 }}>
              <span style={{ fontSize: 'var(--fs-sm)' }}>{t('assets.uploading', { name: u.name })}</span>
              <div className="progress">
                <span style={{ width: `${Math.round(u.progress * 100)}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {over && <div className="dropzone over" style={{ marginBottom: 16 }}>{t('assets.dropHere')}</div>}
      {!data && <Spinner />}
      {data && data.assets.length === 0 && (
        <div className="empty card">
          <Upload />
          <p>{t('assets.empty')}</p>
        </div>
      )}
      {data && data.assets.length > 0 && (
        <ul className="project-grid" style={{ listStyle: 'none', padding: 0, margin: 0, gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
          {data.assets.map((a) => (
            <li key={a.id}>
              <button className="project-card" style={{ width: '100%', padding: 0, cursor: 'pointer', textAlign: 'left' }} onClick={() => setParams({ focus: a.id })} aria-label={a.name}>
                <span className="cover" style={{ display: 'block', aspectRatio: '4 / 3', background: a.hasThumbnail ? `var(--surface-2) url(${thumbUrl(a.id)}) center / cover` : 'var(--surface-2)' }} />
                <span className="meta" style={{ display: 'block' }}>
                  <span className="name truncate" style={{ display: 'block' }}>
                    {a.name}
                  </span>
                  <span className="sub" style={{ display: 'block' }}>
                    {t(`assets.kinds.${a.kind}`)} · {a.width ? `${a.width}×${a.height}` : formatBytes(a.size)}
                    {a.duration ? ` · ${formatDuration(a.duration)}` : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {focus && <AssetDetailDialog id={focus} onClose={() => setParams({})} onChanged={load} />}
      {urlOpen && <ImportUrlDialog onClose={() => setUrlOpen(false)} onDone={load} />}
    </div>
  );
}

function AssetDetailDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [a, setA] = useState<AssetDetail | null>(null);
  const [newTag, setNewTag] = useState('');
  useEffect(() => {
    get<{ asset: AssetDetail }>(`/api/assets/${id}`).then((r) => setA(r.asset), (e) => toast.error(e.message));
  }, [id]);
  const saveTags = async (tags: string[]) => {
    const r = await patch<{ asset: AssetDetail }>(`/api/assets/${id}`, { tags });
    setA((cur) => (cur ? { ...cur, tags: r.asset.tags } : cur));
    onChanged();
  };
  return (
    <Dialog title={a?.name ?? t('assets.details')} onClose={onClose} wide>
      {!a && <Spinner />}
      {a && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)', gap: 24 }}>
          <div style={{ background: 'var(--surface-2)', borderRadius: 12, overflow: 'hidden', minHeight: 200, display: 'grid', placeItems: 'center' }}>
            {a.kind === 'image' && <img src={assetUrl(a.id)} alt={a.name} style={{ maxHeight: 420, objectFit: 'contain' }} />}
            {a.kind === 'video' && <video src={`/api/assets/${a.id}/proxy`} controls style={{ maxHeight: 420, width: '100%' }} />}
            {a.kind === 'audio' && <audio src={assetUrl(a.id)} controls style={{ width: '90%' }} />}
            {!['image', 'video', 'audio'].includes(a.kind) && (a as AssetSummary & { hasThumbnail?: boolean }).kind === 'lut' && <img src={thumbUrl(a.id)} alt="" />}
          </div>
          <div className="col" style={{ gap: 16 }}>
            <dl className="kv">
              <dt>Type</dt>
              <dd>{a.mime}</dd>
              <dt>Size</dt>
              <dd>{formatBytes(a.size)}</dd>
              {a.width && (
                <>
                  <dt>Dimensions</dt>
                  <dd>
                    {a.width} × {a.height}
                  </dd>
                </>
              )}
              {a.duration !== undefined && (
                <>
                  <dt>Duration</dt>
                  <dd>{formatDuration(a.duration)}</dd>
                </>
              )}
              {a.fps && (
                <>
                  <dt>Frame rate</dt>
                  <dd>{a.fps} fps</dd>
                </>
              )}
              {a.videoCodec && (
                <>
                  <dt>Codecs</dt>
                  <dd>
                    {a.videoCodec}
                    {a.audioCodec ? ` / ${a.audioCodec}` : ''}
                  </dd>
                </>
              )}
              {a.colorProfile && (
                <>
                  <dt>Color profile</dt>
                  <dd>{a.colorProfile}</dd>
                </>
              )}
              {a.proxyStatus && a.proxyStatus !== 'none' && (
                <>
                  <dt>{t('video.proxy')}</dt>
                  <dd>{a.proxyStatus}</dd>
                </>
              )}
              <dt>Added</dt>
              <dd>{formatRelative(a.createdAt)}</dd>
              {a.exif &&
                Object.entries(a.exif).map(([k, v]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt>{k}</dt>
                    <dd>{String(v)}</dd>
                  </div>
                ))}
            </dl>
            <div className="col">
              <span className="label">{t('assets.tags')}</span>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {a.tags.map((tag) => (
                  <span key={tag} className="badge">
                    {tag}
                    <button className="icon-btn sm" style={{ width: 16, height: 16 }} aria-label={`${t('app.remove')} ${tag}`} onClick={() => void saveTags(a.tags.filter((x) => x !== tag))}>
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (newTag.trim()) void saveTags([...a.tags, newTag.trim()]);
                  setNewTag('');
                }}
              >
                <input className="input sm" placeholder={t('assets.addTag')} value={newTag} onChange={(e) => setNewTag(e.target.value)} aria-label={t('assets.addTag')} />
                <button className="btn btn-sm" type="submit">
                  <Plus />
                </button>
              </form>
            </div>
            <div className="row">
              <a className="btn btn-sm" href={`${assetUrl(a.id)}?download=1`}>
                <Download /> Download
              </a>
              <button
                className="btn btn-sm btn-danger"
                onClick={async () => {
                  await del(`/api/assets/${a.id}`);
                  onChanged();
                  onClose();
                }}
              >
                <Trash2 /> {t('app.remove')}
              </button>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function ImportUrlDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={t('assets.importUrl')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('app.cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={!url || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await post('/api/assets/import-url', { url });
                onDone();
                onClose();
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner /> : t('app.add')}
          </button>
        </>
      }
    >
      <input className="input" data-autofocus type="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="URL" />
    </Dialog>
  );
}
