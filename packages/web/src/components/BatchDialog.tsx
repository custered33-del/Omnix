import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, CircleSlash, Play, Sparkles, Square, XCircle } from 'lucide-react';
import { get, post, thumbUrl, type AssetSummary } from '../lib/api.js';
import { Dialog, Spinner } from '../ui/primitives.js';
import { toast } from '../ui/toast.js';
import { t } from '../i18n/index.js';

/** A batch target: a library file or a document in a project. */
export type BatchTarget = { assetId: string } | { projectId: string; documentId: string };

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: (string | number)[];
  anyOf?: { const?: string | number; type?: string }[];
  const?: string | number;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  description?: string;
  maxLength?: number;
  pattern?: string;
  items?: JsonSchema;
}

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

/** Human labels for settings; anything else is shown as its name split into words. */
const PARAM_LABELS: Record<string, string> = {
  lutAssetId: 'LUT',
  referenceAssetId: 'Reference picture',
  maxHeight: 'Largest height',
  keyColor: 'Screen color',
  lufs: 'Loudness target (LUFS)',
  apply: 'Apply right away instead of leaving each change to review',
  enlarge: 'Enlarge smaller pictures',
  text: 'Text',
};

function words(name: string): string {
  return PARAM_LABELS[name] ?? name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

function defaultsOf(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(schema.properties ?? {})) if (p.default !== undefined) out[k] = p.default;
  return out;
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

/** A labelled form field whose hint is announced as a description, not as part of the name. */
function Field({ label, hint, children }: { label: string; hint?: string | undefined; children: (a: { id: string; 'aria-describedby'?: string }) => ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children({ id, ...(hint ? { 'aria-describedby': hintId } : {}) })}
      {hint && (
        <span id={hintId} className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
          {hint}
        </span>
      )}
    </div>
  );
}

function ParamField({ name, schema, required, value, onChange }: { name: string; schema: JsonSchema; required: boolean; value: unknown; onChange: (v: unknown) => void }) {
  const label = `${words(name)}${required ? '' : ` (${t('batch.optional')})`}`;
  const hint = schema.description && !PARAM_LABELS[name] ? schema.description : undefined;
  const options = schema.enum ?? schema.anyOf?.map((a) => a.const).filter((c): c is string | number => c !== undefined);
  if (name.endsWith('AssetId')) return <AssetField label={label} kind={name === 'lutAssetId' ? 'lut' : 'image'} value={value as string | undefined} onChange={onChange} />;
  if (options?.length) {
    return (
      <Field label={label} hint={hint}>
        {(a) => (
          <select {...a} className="select" value={value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : typeof options[0] === 'number' ? Number(e.target.value) : e.target.value)}>
            {!required && <option value="">{t('batch.same')}</option>}
            {options.map((o) => (
              <option key={String(o)} value={String(o)}>
                {String(o)}
              </option>
            ))}
          </select>
        )}
      </Field>
    );
  }
  if (schema.type === 'boolean') {
    return (
      <label className="row" style={{ gap: 8, fontSize: 'var(--fs-sm)' }}>
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        {words(name)}
      </label>
    );
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    return (
      <Field label={label} hint={hint}>
        {(a) => (
          <input
            {...a}
            className="input"
            type="number"
            min={schema.minimum}
            max={schema.maximum}
            step={schema.type === 'integer' ? 1 : (schema.maximum ?? 100) - (schema.minimum ?? 0) <= 4 ? 0.05 : 1}
            value={value === undefined ? '' : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          />
        )}
      </Field>
    );
  }
  if (schema.type === 'string' && schema.pattern?.startsWith('^#')) {
    return <Field label={label}>{(a) => <input {...a} type="color" value={(value as string) ?? '#ffffff'} onChange={(e) => onChange(e.target.value)} />}</Field>;
  }
  return <Field label={label} hint={hint}>{(a) => (name === 'text' ? <textarea {...a} className="input" rows={2} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} /> : <input {...a} className="input" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || undefined)} />)}</Field>;
}

/** Pick a library file (a LUT or a reference picture) for a setting. */
function AssetField({ label, kind, value, onChange }: { label: string; kind: string; value: string | undefined; onChange: (v: string | undefined) => void }) {
  const [list, setList] = useState<AssetSummary[] | null>(null);
  useEffect(() => {
    get<{ assets: AssetSummary[] }>(`/api/assets?kind=${kind}&limit=200`).then((r) => setList(r.assets), () => setList([]));
  }, [kind]);
  return (
    <Field label={label}>
      {(f) => (
        <select {...f} className="select" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">{list === null ? '…' : list.length ? t('batch.chooseFile') : t('batch.noFiles', { kind })}</option>
          {list?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      )}
    </Field>
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
