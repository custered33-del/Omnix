import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Upload, Link2, X, Search, Plus, Download, Trash2, Copy, CheckSquare, Square, Tag, Layers } from 'lucide-react';
import { del, get, patch, post, uploadFile, assetUrl, thumbUrl, type AssetSummary } from '../lib/api.js';
import { ConfirmDialog, Dialog, Spinner } from '../ui/primitives.js';
import { BatchDialog } from '../components/BatchDialog.js';
import { toast } from '../ui/toast.js';
import { formatBytes, formatDuration, formatRelative, plural, t } from '../i18n/index.js';

const KINDS = ['image', 'video', 'audio', 'lut', 'font', 'text', 'data', 'other'] as const;

interface AssetDetail extends Omit<AssetSummary, 'usedIn'> {
  exif?: Record<string, string | number>;
  colorSpace?: string | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  source?: { kind: string; url?: string; prompt?: string };
  usedIn?: { projectId: string; projectName: string; nodeIds: string[] }[];
  similar?: { id: string; name: string; distance: number; width?: number; height?: number; size: number }[];
}

type Listing = { assets: AssetSummary[]; tags: string[]; autoTags: string[]; total: number; similarGroups: number };

export function AssetsPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(() => params.get('q') ?? '');
  const [kind, setKind] = useState<string>('');
  const [tag, setTag] = useState<string>('');
  const [sort, setSort] = useState('');
  const [data, setData] = useState<Listing | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [similarOpen, setSimilarOpen] = useState(false);
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
    if (sort) p.set('sort', sort);
    get<Listing>(`/api/assets?${p}`).then(setData, (e) => toast.error(e.message));
  }, [q, kind, tag, sort]);
  useEffect(() => {
    const id = window.setTimeout(load, 150);
    return () => window.clearTimeout(id);
  }, [load]);

  const upload = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      setUploads((u) => [...u, { name: f.name, progress: 0 }]);
      try {
        const r = await uploadFile(f, { onProgress: (p) => setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, progress: p } : x))) });
        const like = r.similar?.[0];
        if (like) toast.info(t('assets.looksLikeUpload', { name: f.name, other: like.name }), { label: t('assets.review'), run: () => setSimilarOpen(true) });
        else toast.success(r.deduplicated ? t('assets.duplicate', { name: f.name }) : t('assets.uploaded', { name: f.name }));
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
          {data && <p className="subtitle">{t('assets.subtitle', { count: data.total })}</p>}
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
        {data && (data.tags.length > 0 || data.autoTags.length > 0) && (
          <select className="select" style={{ width: 180 }} value={tag} onChange={(e) => setTag(e.target.value)} aria-label={t('assets.tags')}>
            <option value="">{t('assets.tags')}: {t('assets.filterAll')}</option>
            {data.tags.length > 0 && (
              <optgroup label={t('assets.tags')}>
                {data.tags.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </optgroup>
            )}
            {data.autoTags.length > 0 && (
              <optgroup label={t('assets.autoTags')}>
                {data.autoTags.map((x) => (
                  <option key={`auto-${x}`} value={x}>
                    {x}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        )}
        <select className="select" style={{ width: 150 }} value={sort} onChange={(e) => setSort(e.target.value)} aria-label={t('assets.sort')}>
          <option value="">
            {t('assets.sort')}: {q ? t('assets.sorts.relevance') : t('assets.sorts.newest')}
          </option>
          {(['newest', 'oldest', 'name', 'size'] as const).map((k) => (
            <option key={k} value={k}>
              {t(`assets.sorts.${k}`)}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button
          className={`btn btn-sm${selecting ? ' btn-primary' : ''}`}
          aria-pressed={selecting}
          onClick={() => {
            setSelecting(!selecting);
            setSelected(new Set());
          }}
        >
          <CheckSquare /> {selecting ? t('assets.doneSelecting') : t('assets.select')}
        </button>
      </div>

      {data && data.similarGroups > 0 && (
        <div className="notice" role="status">
          <Copy size={16} aria-hidden="true" />
          <span className="grow">{plural('assets.similarBanner', data.similarGroups)}</span>
          <button className="btn btn-sm" onClick={() => setSimilarOpen(true)}>
            {t('assets.review')}
          </button>
        </div>
      )}
      {selecting && selected.size > 0 && <BulkBar ids={[...selected]} kinds={[...new Set((data?.assets ?? []).filter((a) => selected.has(a.id)).map((a) => a.kind))]} tags={data?.tags ?? []} onDone={() => (setSelected(new Set()), load())} onReload={load} />}

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
              <button
                className={`project-card asset-card${selected.has(a.id) ? ' selected' : ''}`}
                style={{ width: '100%', padding: 0, cursor: 'pointer', textAlign: 'left' }}
                onClick={() => {
                  if (!selecting) return setParams({ focus: a.id });
                  const next = new Set(selected);
                  if (next.has(a.id)) next.delete(a.id);
                  else next.add(a.id);
                  setSelected(next);
                }}
                aria-label={a.name}
                {...(selecting ? { 'aria-pressed': selected.has(a.id) } : {})}
              >
                {selecting && <span className="asset-check" aria-hidden="true">{selected.has(a.id) ? <CheckSquare size={18} /> : <Square size={18} />}</span>}
                <span className="cover" style={{ display: 'block', aspectRatio: '4 / 3', background: a.hasThumbnail ? `var(--surface-2) url(${thumbUrl(a.id)}) center / cover` : 'var(--surface-2)' }} />
                <span className="meta" style={{ display: 'block' }}>
                  <span className="name truncate" style={{ display: 'block' }}>
                    {a.name}
                  </span>
                  <span className="sub" style={{ display: 'block' }}>
                    {t(`assets.kinds.${a.kind}`)} · {a.width ? `${a.width}×${a.height}` : formatBytes(a.size)}
                    {a.duration ? ` · ${formatDuration(a.duration)}` : ''}
                  </span>
                  <span className="sub" style={{ display: 'block' }}>
                    {a.usedIn?.length ? plural('assets.usedInCount', a.usedIn.length) : t('assets.unused')}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {focus && <AssetDetailDialog id={focus} onClose={() => setParams({})} onChanged={load} onSearch={(word) => (setQ(word), setParams({}))} />}
      {similarOpen && <SimilarDialog onClose={() => setSimilarOpen(false)} onChanged={load} />}
      {urlOpen && <ImportUrlDialog onClose={() => setUrlOpen(false)} onDone={load} />}
    </div>
  );
}

function AssetDetailDialog({ id, onClose, onChanged, onSearch }: { id: string; onClose: () => void; onChanged: () => void; onSearch: (word: string) => void }) {
  const [a, setA] = useState<AssetDetail | null>(null);
  const [newTag, setNewTag] = useState('');
  const [, setParams] = useSearchParams();
  const reload = useCallback(() => {
    get<{ asset: AssetDetail }>(`/api/assets/${id}`).then((r) => setA(r.asset), (e) => toast.error(e.message));
  }, [id]);
  useEffect(reload, [reload]);
  const mergeInto = async (dropId: string) => {
    const r = await post<MergeResult>('/api/assets/merge', { keep: id, drop: [dropId] });
    toast.success(mergedMessage(r, a?.name ?? ''));
    reload();
    onChanged();
  };
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
            {(a.autoTags?.length ?? 0) > 0 && (
              <div className="col">
                <span className="label">{t('assets.autoTags')}</span>
                <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                  {a.autoTags!.map((tag) => (
                    <button key={tag} type="button" className="chip" onClick={() => onSearch(tag)}>
                      {tag}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="col">
              <span className="label">{t('assets.usedIn')}</span>
              {a.usedIn?.length ? (
                <ul className="plain-list">
                  {a.usedIn.map((u) => (
                    <li key={u.projectId}>
                      <Link to={`/projects/${u.projectId}`}>{t('assets.usedInUses', { name: u.projectName, count: u.nodeIds.length })}</Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
                  {t('assets.unused')}
                </span>
              )}
            </div>
            {(a.similar?.length ?? 0) > 0 && (
              <div className="col">
                <span className="label">{t('assets.looksLike')}</span>
                {a.similar!.map((s) => (
                  <div key={s.id} className="row" style={{ gap: 8 }}>
                    <img src={thumbUrl(s.id)} alt="" width={48} height={36} style={{ objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)' }} />
                    <button type="button" className="link-btn grow truncate" onClick={() => setParams({ focus: s.id })}>
                      {s.name}
                    </button>
                    <span className="muted tabular" style={{ fontSize: 'var(--fs-xs)' }}>
                      {s.width ? `${s.width}×${s.height}` : formatBytes(s.size)}
                    </span>
                    <button className="btn btn-sm" onClick={() => void mergeInto(s.id).catch((e: Error) => toast.error(e.message))}>
                      {t('assets.mergeInto')}
                    </button>
                  </div>
                ))}
              </div>
            )}
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

interface MergeResult {
  kept: string;
  merged: string[];
  projects: { projectName: string; replaced: number; status: string }[];
}

function mergedMessage(r: MergeResult, name: string): string {
  const uses = r.projects.filter((p) => p.status !== 'skipped').reduce((n, p) => n + p.replaced, 0);
  return uses ? plural('assets.merged', r.merged.length, { uses, name }) : plural('assets.mergedUnused', r.merged.length, { name });
}

/** Near-duplicate groups: pick the copy to keep and merge the rest into it. */
function SimilarDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [groups, setGroups] = useState<AssetSummary[][] | null>(null);
  const [keep, setKeep] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const load = useCallback(() => {
    get<{ groups: AssetSummary[][] }>('/api/assets/similar').then((r) => setGroups(r.groups), (e) => toast.error(e.message));
  }, []);
  useEffect(load, [load]);
  return (
    <Dialog title={t('assets.similarTitle')} onClose={onClose} wide description={t('assets.similarHint')}>
      {!groups && <Spinner />}
      {groups && groups.length === 0 && <p>{t('assets.noSimilar')}</p>}
      <div className="col" style={{ gap: 16 }}>
        {groups?.map((g, gi) => {
          const kept = keep[gi] ?? g[0]!.id;
          return (
            <section key={g.map((a) => a.id).join()} className="similar-group">
              <div className="similar-row" role="radiogroup" aria-label={t('assets.keep')}>
                {g.map((a) => (
                  <label key={a.id} className={`similar-item${a.id === kept ? ' kept' : ''}`}>
                    <img src={thumbUrl(a.id)} alt="" />
                    <span className="row" style={{ gap: 6 }}>
                      <input type="radio" name={`keep-${gi}`} checked={a.id === kept} onChange={() => setKeep({ ...keep, [gi]: a.id })} />
                      <span className="truncate">{a.name}</span>
                    </span>
                    <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                      {a.width ? `${a.width}×${a.height} · ` : ''}
                      {formatBytes(a.size)} · {a.usedIn?.length ? plural('assets.usedInCount', a.usedIn.length) : t('assets.unused')}
                    </span>
                  </label>
                ))}
              </div>
              <button
                className="btn btn-sm btn-primary"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy(gi);
                  try {
                    const r = await post<MergeResult>('/api/assets/merge', { keep: kept, drop: g.filter((a) => a.id !== kept).map((a) => a.id) });
                    toast.success(mergedMessage(r, g.find((a) => a.id === kept)!.name));
                    load();
                    onChanged();
                  } catch (e) {
                    toast.error((e as Error).message);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === gi ? <Spinner /> : <Copy />} {t('assets.merge')}
              </button>
            </section>
          );
        })}
      </div>
    </Dialog>
  );
}

/** Actions for several selected assets. */
function BulkBar({ ids, kinds, tags, onDone, onReload }: { ids: string[]; kinds: string[]; tags: string[]; onDone: () => void; onReload: () => void }) {
  const [tag, setTag] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [batch, setBatch] = useState(false);
  const run = async (body: Record<string, unknown>, message: string) => {
    try {
      await post('/api/assets/bulk', { ids, ...body });
      toast.success(message);
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="bulk-bar" role="toolbar" aria-label={plural('assets.selected', ids.length)}>
      <strong>{plural('assets.selected', ids.length)}</strong>
      <form
        className="row"
        style={{ gap: 4 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (tag.trim()) void run({ addTags: [tag.trim()] }, t('assets.tagged', { count: ids.length }));
          setTag('');
        }}
      >
        <input className="input sm" style={{ width: 140 }} placeholder={t('assets.addTag')} value={tag} onChange={(e) => setTag(e.target.value)} aria-label={t('assets.bulkTag')} />
        <button className="btn btn-sm" type="submit" disabled={!tag.trim()}>
          <Tag /> {t('assets.bulkTag')}
        </button>
      </form>
      {tags.length > 0 && (
        <select className="select sm" style={{ width: 160 }} value="" onChange={(e) => e.target.value && void run({ removeTags: [e.target.value] }, t('assets.tagged', { count: ids.length }))} aria-label={t('assets.bulkUntag')}>
          <option value="">{t('assets.bulkUntag')}…</option>
          {tags.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      )}
      <span className="spacer" />
      <button className="btn btn-sm btn-primary" onClick={() => setBatch(true)}>
        <Layers /> {t('assets.process')}
      </button>
      {batch && <BatchDialog targets={ids.map((assetId) => ({ assetId }))} kinds={kinds} onClose={() => setBatch(false)} onFinished={onReload} />}
      <button className="btn btn-sm btn-danger" onClick={() => setConfirm(true)}>
        <Trash2 /> {t('assets.bulkRemove')}
      </button>
      {confirm && <ConfirmDialog title={t('assets.bulkRemove')} message={t('assets.bulkRemoveConfirm', { count: ids.length })} confirmLabel={t('app.remove')} danger onConfirm={() => run({ remove: true }, t('assets.removed', { count: ids.length }))} onClose={() => setConfirm(false)} />}
    </div>
  );
}
