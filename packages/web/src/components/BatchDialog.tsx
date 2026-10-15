import { useEffect, useMemo, useState } from 'react';
import { defaultsOf, Field, ParamField, type JsonSchema } from './SchemaForm.js';
import { Link } from 'react-router-dom';
import { CheckCircle2, CircleSlash, Play, Sparkles, Square, XCircle } from 'lucide-react';
import { get, post, thumbUrl } from '../lib/api.js';
import { Dialog, Spinner } from '../ui/primitives.js';
import { toast } from '../ui/toast.js';
import { t } from '../i18n/index.js';

/** A batch target: a library file or a document in a project. */
export type BatchTarget = { assetId: string } | { projectId: string; documentId: string };

export interface BatchOperationInfo {
  id: string;
  label: string;
  description: string;
  group: 'image' | 'video' | 'audio' | 'document';
  ai: boolean;
  kinds?: string[];
  documentTypes?: string[];
  params: JsonSchema;
}

interface BatchItemView {
  target: BatchTarget;
  label: string;
  result: { status: 'done' | 'failed' | 'skipped'; message?: string; outputAssetId?: string; outputName?: string; proposalId?: string; commitId?: string } | null;
}

interface BatchJobView {
  id: string;
  title: string;
  status: string;
  progress: number;
  message: string;
  error: string | null;
  items: BatchItemView[];
}

/**
 * Batch processing (feature 54): pick an operation that fits every selected file or document,
 * set it up once, run it on all of them, and follow each item's result.
 */
export function BatchDialog({ targets, kinds, documentTypes, onClose, onFinished }: { targets: BatchTarget[]; kinds?: string[]; documentTypes?: string[]; onClose: () => void; onFinished?: () => void }) {
  const [ops, setOps] = useState<BatchOperationInfo[] | null>(null);
  const [opId, setOpId] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [tags, setTags] = useState('');
  const [job, setJob] = useState<BatchJobView | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<{ operations: BatchOperationInfo[] }>('/api/batch/operations').then((r) => setOps(r.operations), (e: Error) => toast.error(e.message));
  }, []);
  // Only operations that suit every target.
  const fitting = useMemo(
    () =>
      (ops ?? []).filter((o) => {
        if (kinds?.length) return !!o.kinds && kinds.every((k) => o.kinds!.includes(k));
        if (documentTypes?.length) return !!o.documentTypes && documentTypes.every((d) => o.documentTypes!.includes(d));
        return false;
      }),
    [ops, kinds, documentTypes],
  );
  const op = fitting.find((o) => o.id === opId) ?? null;
  const choose = (o: BatchOperationInfo) => {
    setOpId(o.id);
    setParams(defaultsOf(o.params));
  };

  // Follow a running batch.
  useEffect(() => {
    if (!job || ['done', 'failed', 'cancelled'].includes(job.status)) return;
    const timer = window.setTimeout(() => {
      get<{ job: BatchJobView }>(`/api/batch/${job.id}`).then((r) => {
        setJob(r.job);
        if (['done', 'failed', 'cancelled'].includes(r.job.status)) onFinished?.();
      }, () => {});
    }, 500);
    return () => window.clearTimeout(timer);
  }, [job, onFinished]);

  const missing = op ? (op.params.required ?? []).filter((k) => params[k] === undefined || params[k] === '') : [];
  const run = async () => {
    if (!op) return;
    setBusy(true);
    try {
      const r = await post<{ job: BatchJobView }>('/api/batch', { operation: op.id, params, targets, tags: tags.split(',').map((x) => x.trim()).filter(Boolean) });
      setJob(r.job);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const groups = (['image', 'video', 'audio', 'document'] as const).map((g) => ({ g, items: fitting.filter((o) => o.group === g) })).filter((x) => x.items.length);
  const finished = job && ['done', 'failed', 'cancelled'].includes(job.status);
  const tagList = tags.split(',').map((x) => x.trim()).filter(Boolean);

  return (
    <Dialog
      title={job ? job.title : t('batch.title', { count: targets.length })}
      onClose={onClose}
      wide
      footer={
        job ? (
          <>
            {!finished && (
              <button className="btn" onClick={() => void post(`/api/batch/${job.id}/cancel`).catch(() => {})}>
                <Square /> {t('batch.stop')}
              </button>
            )}
            {finished && job.items.some((x) => x.result?.outputAssetId) && (
              <Link className="btn" to={`/assets?q=${encodeURIComponent(`tag:${tagList[0] ?? 'batch'}`)}`} onClick={onClose}>
                {t('batch.showResults')}
              </Link>
            )}
            <button className="btn btn-primary" onClick={onClose}>
              {finished ? t('app.done') : t('batch.background')}
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              {t('app.cancel')}
            </button>
            <button className="btn btn-primary" disabled={!op || busy || missing.length > 0} onClick={() => void run()}>
              {busy ? <Spinner /> : <Play />} {op ? t('batch.run', { label: op.label, count: targets.length }) : t('batch.pick')}
            </button>
          </>
        )
      }
    >
      {!ops && <Spinner />}
      {ops && !job && (
        <div className="batch-setup">
          <div className="batch-ops" role="radiogroup" aria-label={t('batch.operation')}>
            {groups.length === 0 && <p className="muted">{t('batch.none')}</p>}
            {groups.map(({ g, items }) => (
              <section key={g}>
                <h3 className="section-title">{t(`batch.groups.${g}`)}</h3>
                {items.map((o) => (
                  <label key={o.id} className={`batch-op${o.id === opId ? ' selected' : ''}`}>
                    <input type="radio" name="batch-op" checked={o.id === opId} onChange={() => choose(o)} />
                    <span className="grow">
                      <span className="row" style={{ gap: 6 }}>
                        <strong>{o.label}</strong>
                        {o.ai && (
                          <span className="badge ai">
                            <Sparkles size={11} aria-hidden="true" /> AI
                          </span>
                        )}
                      </span>
                      <span className="muted" style={{ display: 'block', fontSize: 'var(--fs-sm)' }}>
                        {o.description}
                      </span>
                    </span>
                  </label>
                ))}
              </section>
            ))}
          </div>
          <div className="batch-params">
            {!op && <p className="muted">{t('batch.pickHint')}</p>}
            {op && (
              <>
                <h3 className="section-title">{t('batch.settings')}</h3>
                {Object.entries(op.params.properties ?? {}).map(([name, schema]) => (
                  <ParamField key={name} name={name} schema={schema} required={(op.params.required ?? []).includes(name)} value={params[name]} onChange={(v) => setParams((p) => ({ ...p, [name]: v }))} />
                ))}
                {Object.keys(op.params.properties ?? {}).length === 0 && <p className="muted">{t('batch.noSettings')}</p>}
                {op.kinds && <Field label={t('batch.tags')} hint={t('batch.tagsHint')}>{(a) => <input {...a} className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="instagram, web" />}</Field>}
              </>
            )}
          </div>
        </div>
      )}
      {job && <BatchProgress job={job} />}
    </Dialog>
  );
}

function BatchProgress({ job }: { job: BatchJobView }) {
  const count = (s: string) => job.items.filter((x) => x.result?.status === s).length;
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="progress" role="progressbar" aria-valuenow={Math.round(job.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={job.title}>
        <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
      </div>
      <p className="muted" role="status" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
        {job.status === 'running' || job.status === 'queued' ? job.message : [t('batch.summaryDone', { count: count('done') }), count('failed') ? t('batch.summaryFailed', { count: count('failed') }) : '', count('skipped') ? t('batch.summarySkipped', { count: count('skipped') }) : ''].filter(Boolean).join(' · ')}
        {job.error ? ` · ${job.error}` : ''}
      </p>
      <ul className="batch-items">
        {job.items.map((x, i) => (
          <li key={i} className={`batch-item ${x.result?.status ?? 'waiting'}`}>
            {!x.result ? <Spinner /> : x.result.status === 'done' ? <CheckCircle2 size={16} aria-label={t('batch.status.done')} /> : x.result.status === 'failed' ? <XCircle size={16} aria-label={t('batch.status.failed')} /> : <CircleSlash size={16} aria-label={t('batch.status.skipped')} />}
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="truncate" style={{ display: 'block' }}>
                {x.label}
                {x.result?.outputName && <span className="muted"> → {x.result.outputName}</span>}
              </span>
              {x.result?.message && (
                <span className="muted" style={{ display: 'block', fontSize: 'var(--fs-xs)' }}>
                  {x.result.message}
                </span>
              )}
              {x.result?.proposalId && (
                <span className="muted" style={{ display: 'block', fontSize: 'var(--fs-xs)' }}>
                  {t('batch.proposed')}
                </span>
              )}
            </span>
            {x.result?.outputAssetId && <img src={thumbUrl(x.result.outputAssetId)} alt="" width={48} height={36} className="batch-thumb" />}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Choose documents in a project, then set up a batch for them. */
export function DocumentBatchDialog({ projectId, docs, initial, onClose }: { projectId: string; docs: { id: string; name: string; type: string }[]; initial: string[]; onClose: () => void }) {
  const [chosen, setChosen] = useState<Set<string>>(new Set(initial));
  const [next, setNext] = useState(false);
  if (next) {
    const picked = docs.filter((d) => chosen.has(d.id));
    return <BatchDialog targets={picked.map((d) => ({ projectId, documentId: d.id }))} documentTypes={[...new Set(picked.map((d) => d.type))]} onClose={onClose} />;
  }
  return (
    <Dialog
      title={t('batch.pickDocuments')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('app.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!chosen.size} onClick={() => setNext(true)}>
            {t('batch.next', { count: chosen.size })}
          </button>
        </>
      }
    >
      <fieldset className="col" style={{ gap: 6, border: 'none', padding: 0, margin: 0 }}>
        <legend className="muted" style={{ fontSize: 'var(--fs-sm)', marginBottom: 8 }}>
          {t('batch.pickDocumentsHint')}
        </legend>
        {docs.map((d) => (
          <label key={d.id} className="row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={chosen.has(d.id)}
              onChange={(e) => {
                const s = new Set(chosen);
                if (e.target.checked) s.add(d.id);
                else s.delete(d.id);
                setChosen(s);
              }}
            />
            <span className="grow">{d.name}</span>
            <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
              {t(`batch.docTypes.${d.type}` as never)}
            </span>
          </label>
        ))}
      </fieldset>
    </Dialog>
  );
}
