import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, ArrowRight, Columns2, Diff, Layers, RotateCcw, SplitSquareHorizontal } from 'lucide-react';
import type { BlockChange, Commit, DocumentComparison, FileChange, SlideChange, Snapshot, VersionComparison } from '@omnix/core';
import { useProject, useProjectStore } from '../state/project.js';
import { get } from '../lib/api.js';
import { Dialog, Spinner } from '../ui/primitives.js';
import { ToolIcon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { formatDuration, formatRelative, plural, t } from '../i18n/index.js';
import { DiffView } from './ProposalsPanel.js';

type CommitSummary = Omit<Commit, 'op' | 'inverse'>;
interface Resolved {
  commitId: string | null;
  label: string;
  at: string | null;
}
interface Pixels {
  fraction: number;
  bbox: { x: number; y: number; width: number; height: number } | null;
  width: number;
  height: number;
}
type Mode = 'side' | 'swipe' | 'overlay' | 'diff';

const TOOL_OF: Record<DocumentComparison['kind'], 'image' | 'video' | 'code' | 'document' | 'slides'> = { canvas: 'image', sequence: 'video', codeWorkspace: 'code', document: 'document', deck: 'slides' };

/**
 * Compare any two versions of a project (feature 52): pick the versions and a document, then see
 * pictures side by side, with a swipe or an overlay, or as a difference image with the changed
 * area highlighted; documents and code show their text changes.
 */
export function CompareVersions({ from: initialFrom, to: initialTo, documentId, onClose }: { from?: string; to?: string; documentId?: string | null; onClose: () => void }) {
  const store = useProjectStore();
  const projectId = store.getState().projectId;
  const snapshots = useProject((s) => s.snapshots);
  const canEdit = useProject((s) => s.meta?.role !== 'viewer');
  const activeDocId = useProject((s) => s.activeDocId);
  const [from, setFrom] = useState(initialFrom ?? snapshots[snapshots.length - 1]?.id ?? 'base');
  const [to, setTo] = useState(initialTo ?? 'current');
  const [doc, setDoc] = useState<string | null>(documentId ?? activeDocId);
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [data, setData] = useState<{ from: Resolved; to: Resolved; comparison: VersionComparison } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<{ commits: CommitSummary[] }>(`/api/projects/${projectId}/history`).then((h) => setCommits(h.commits.slice(-40).reverse()), () => {});
  }, [projectId]);
  useEffect(() => {
    setData(null);
    setError(null);
    get<{ from: Resolved; to: Resolved; comparison: VersionComparison }>(`/api/projects/${projectId}/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then(setData, (e: Error) => setError(e.message));
  }, [projectId, from, to]);

  // Start on the requested document, else the open one if it changed, else the first that changed.
  const docs = data?.comparison.documents ?? [];
  const current = docs.find((d) => d.documentId === doc) ?? docs.find((d) => data!.comparison.changed.includes(d.documentId)) ?? docs[0];

  return (
    <Dialog title={t('versions.title')} onClose={onClose} full>
      <div className="compare">
        <div className="compare-bar">
          <VersionSelect label={t('versions.from')} value={from} onChange={setFrom} snapshots={snapshots} commits={commits} />
          <button type="button" className="icon-btn" aria-label={t('versions.swap')} title={t('versions.swap')} onClick={() => (setFrom(to), setTo(from))}>
            <ArrowLeftRight />
          </button>
          <VersionSelect label={t('versions.to')} value={to} onChange={setTo} snapshots={snapshots} commits={commits} />
          <span className="spacer" />
          {canEdit && data && data.from.commitId !== data.to.commitId && from !== 'current' && (
            <button
              className="btn btn-sm"
              onClick={() =>
                void store
                  .getState()
                  .checkout(data.from.commitId)
                  .then(onClose, (e: Error) => toast.error(e.message))
              }
            >
              <RotateCcw /> {t('versions.restoreOlder', { name: data.from.label })}
            </button>
          )}
        </div>
        {error && <p className="error-text">{error}</p>}
        {!data && !error && (
          <div className="compare-loading">
            <Spinner /> {t('versions.loading')}
          </div>
        )}
        {data && (
          <>
            <p className="compare-summary" role="status">
              <strong>{data.from.label}</strong> <ArrowRight size={14} aria-label="to" /> <strong>{data.to.label}</strong>
              <span className="muted">{data.comparison.summary}</span>
            </p>
            <div className="compare-docs" role="tablist" aria-label={t('versions.document')}>
              {docs.map((d) => {
                const changed = data.comparison.changed.includes(d.documentId);
                return (
                  <button key={d.documentId} role="tab" aria-selected={d.documentId === current?.documentId} className={`compare-doc${changed ? ' changed' : ''}`} onClick={() => setDoc(d.documentId)}>
                    <ToolIcon tool={TOOL_OF[d.kind]} size={14} />
                    <span className="truncate">{d.name}</span>
                    {changed && <span className="dot" aria-label={t('versions.status.changed')} />}
                  </button>
                );
              })}
            </div>
            {current && <DocumentDiff key={`${current.documentId}|${from}|${to}`} projectId={projectId} d={current} from={from} to={to} labels={[data.from.label, data.to.label]} />}
          </>
        )}
      </div>
    </Dialog>
  );
}

function VersionSelect({ label, value, onChange, snapshots, commits }: { label: string; value: string; onChange: (v: string) => void; snapshots: Snapshot[]; commits: CommitSummary[] }) {
  const known = value === 'current' || value === 'base' || snapshots.some((s) => s.id === value) || commits.some((c) => c.id === value);
  return (
    <label className="compare-select">
      <span className="label">{label}</span>
      <select className="select sm" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="current">{t('versions.current')}</option>
        {snapshots.length > 0 && (
          <optgroup label={t('versions.saved')}>
            {[...snapshots].reverse().map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {formatRelative(s.createdAt)}
              </option>
            ))}
          </optgroup>
        )}
        {commits.length > 0 && (
          <optgroup label={t('versions.changes')}>
            {commits.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} · {c.author.name} · {formatRelative(c.timestamp)}
              </option>
            ))}
          </optgroup>
        )}
        <option value="base">{t('versions.base')}</option>
        {!known && <option value={value}>{value}</option>}
      </select>
    </label>
  );
}

function DocumentDiff({ projectId, d, from, to, labels }: { projectId: string; d: DocumentComparison; from: string; to: string; labels: [string, string] }) {
  const visual = d.kind === 'canvas' || d.kind === 'sequence' || d.kind === 'deck';
  const total = d.structural.added.length + d.structural.removed.length + d.structural.changed.length;
  return (
    <div className="compare-body">
      <p className="muted" style={{ margin: 0 }}>
        {d.summary}
        {!d.existsBefore && ` · ${t('versions.missingBefore')}`}
        {!d.existsAfter && ` · ${t('versions.missingAfter')}`}
      </p>
      {visual && <VisualDiff projectId={projectId} d={d} from={from} to={to} labels={labels} />}
      {d.blocks && <BlocksDiff blocks={d.blocks} />}
      {d.files && <FilesDiff files={d.files} />}
      {!visual && d.structural.empty && <p className="muted">{t('versions.noDocChanges')}</p>}
      {total > 0 && (
        <details className="compare-all">
          <summary>{t('versions.allChanges', { count: total })}</summary>
          <DiffView diff={d.structural} />
        </details>
      )}
    </div>
  );
}

function VisualDiff({ projectId, d, from, to, labels }: { projectId: string; d: DocumentComparison; from: string; to: string; labels: [string, string] }) {
  const state = useProject((s) => s.state);
  const [mode, setMode] = useState<Mode>('side');
  const firstSlide = d.slides?.find((s) => s.status !== 'same')?.slideId ?? d.slides?.[0]?.slideId ?? null;
  const [slide, setSlide] = useState<string | null>(firstSlide);
  const duration = d.kind === 'sequence' ? ((state?.nodes[d.documentId]?.props as { duration?: number } | undefined)?.duration ?? 10) : 0;
  const [time, setTime] = useState(0);
  const [committedTime, setCommittedTime] = useState(0);
  const [swipe, setSwipe] = useState(50);
  const [opacity, setOpacity] = useState(50);
  const [pixels, setPixels] = useState<Pixels | null>(null);
  const node = d.kind === 'deck' ? slide : d.documentId;
  const query = useMemo(() => (node ? `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&node=${encodeURIComponent(node)}&size=1280${d.kind === 'sequence' ? `&t=${committedTime}` : ''}` : null), [from, to, node, committedTime, d.kind]);
  useEffect(() => {
    setPixels(null);
    if (!query) return;
    get<Pixels>(`/api/projects/${projectId}/compare/pixels?${query}`).then(setPixels, () => {});
  }, [projectId, query]);
  const img = (which: 'before' | 'after' | 'diff') => `/api/projects/${projectId}/compare/image?${query}&which=${which}`;
  const percent = pixels ? Math.round(pixels.fraction * 1000) / 10 : null;
  const ratio = pixels ? `${pixels.width} / ${pixels.height}` : '16 / 9';

  return (
    <div className="compare-visual">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="segmented" role="group" aria-label={t('versions.mode')}>
          {(
            [
              ['side', <Columns2 size={14} key="i" />],
              ['swipe', <SplitSquareHorizontal size={14} key="i" />],
              ['overlay', <Layers size={14} key="i" />],
              ['diff', <Diff size={14} key="i" />],
            ] as const
          ).map(([m, icon]) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
              {icon} {t(`versions.modes.${m}`)}
            </button>
          ))}
        </div>
        {d.kind === 'sequence' && (
          <label className="row" style={{ gap: 6, fontSize: 'var(--fs-sm)' }}>
            {t('versions.at')}
            <input type="range" min={0} max={Math.max(0.1, duration)} step={0.1} value={time} onChange={(e) => setTime(Number(e.target.value))} onPointerUp={() => setCommittedTime(time)} onKeyUp={() => setCommittedTime(time)} aria-valuetext={formatDuration(time)} style={{ width: 200 }} />
            <span className="tabular">{formatDuration(time)}</span>
          </label>
        )}
        <span className="spacer" />
        {percent !== null && <span className={`badge${percent > 0 ? ' accent' : ''}`}>{percent > 0 ? t('versions.changedPercent', { percent }) : t('versions.unchanged')}</span>}
      </div>
      <div className={d.slides ? 'compare-with-slides' : undefined}>
        {d.slides && <SlideList slides={d.slides} value={slide} onChange={setSlide} />}
        {query && (
          <div className="compare-stage">
            {mode === 'side' && (
              <div className="compare-side">
                <figure>
                  <img src={img('before')} alt={labels[0]} style={{ aspectRatio: ratio }} />
                  <figcaption>{labels[0]}</figcaption>
                </figure>
                <figure>
                  <img src={img('after')} alt={labels[1]} style={{ aspectRatio: ratio }} />
                  <figcaption>{labels[1]}</figcaption>
                </figure>
              </div>
            )}
            {mode === 'swipe' && (
              <figure className="compare-stack">
                <div
                  className="compare-frame swipe"
                  style={{ aspectRatio: ratio }}
                  onPointerDown={(e) => {
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                    const r = e.currentTarget.getBoundingClientRect();
                    setSwipe(Math.round(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100))));
                  }}
                  onPointerMove={(e) => {
                    if (!e.buttons) return;
                    const r = e.currentTarget.getBoundingClientRect();
                    setSwipe(Math.round(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100))));
                  }}
                >
                  <img src={img('before')} alt={labels[0]} draggable={false} />
                  <img src={img('after')} alt={labels[1]} draggable={false} style={{ clipPath: `inset(0 0 0 ${swipe}%)` }} />
                  <div className="compare-handle" style={{ left: `${swipe}%` }} aria-hidden="true" />
                  <span className="compare-tag left">{labels[0]}</span>
                  <span className="compare-tag right">{labels[1]}</span>
                </div>
                <input type="range" min={0} max={100} value={swipe} onChange={(e) => setSwipe(Number(e.target.value))} aria-label={t('versions.swipeLabel')} className="compare-range" />
              </figure>
            )}
            {mode === 'overlay' && (
              <figure className="compare-stack">
                <div className="compare-frame" style={{ aspectRatio: ratio }}>
                  <img src={img('before')} alt={labels[0]} />
                  <img src={img('after')} alt={labels[1]} style={{ opacity: opacity / 100 }} />
                </div>
                <input type="range" min={0} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label={t('versions.overlayLabel')} className="compare-range" />
              </figure>
            )}
            {mode === 'diff' && (
              <figure className="compare-stack">
                <div className="compare-frame" style={{ aspectRatio: ratio }}>
                  <img src={img('diff')} alt={percent !== null ? t('versions.changedPercent', { percent }) : t('versions.modes.diff')} />
                </div>
              </figure>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SlideList({ slides, value, onChange }: { slides: SlideChange[]; value: string | null; onChange: (id: string) => void }) {
  return (
    <ol className="compare-slides" aria-label={t('versions.slides')}>
      {slides.map((s) => (
        <li key={s.slideId}>
          <button type="button" aria-current={s.slideId === value} onClick={() => onChange(s.slideId)} className={`status-${s.status}`}>
            <span className="tabular muted">{(s.indexAfter ?? s.indexBefore ?? 0) + 1}</span>
            <span className="grow truncate">{s.name}</span>
            {s.status !== 'same' && <span className={`compare-status ${s.status}`}>{t(`versions.status.${s.status}`)}</span>}
          </button>
        </li>
      ))}
    </ol>
  );
}

function BlocksDiff({ blocks }: { blocks: BlockChange[] }) {
  const [showAll, setShowAll] = useState(false);
  // Runs of unchanged paragraphs fold into one line unless expanded.
  const groups: ({ kind: 'change'; b: BlockChange } | { kind: 'same'; items: BlockChange[] })[] = [];
  for (const b of blocks) {
    const last = groups[groups.length - 1];
    if (b.status === 'same' && !showAll) {
      if (last?.kind === 'same') last.items.push(b);
      else groups.push({ kind: 'same', items: [b] });
    } else groups.push({ kind: 'change', b });
  }
  return (
    <div className="compare-text">
      {groups.map((g, i) =>
        g.kind === 'same' ? (
          <button key={`s${i}`} type="button" className="compare-fold" onClick={() => setShowAll(true)}>
            {plural('versions.unchangedParagraphs', g.items.length)}
          </button>
        ) : (
          <div key={g.b.blockId} className={`compare-block ${g.b.status}`}>
            <span className={`compare-status ${g.b.status}`}>{t(`versions.status.${g.b.status}`)}</span>
            {g.b.words ? (
              <p>
                {g.b.words.map((w, j) =>
                  w.kind === 'same' ? (
                    <span key={j}>{w.text}</span>
                  ) : w.kind === 'added' ? (
                    <ins key={j}>{w.text}</ins>
                  ) : (
                    <del key={j}>{w.text}</del>
                  ),
                )}
              </p>
            ) : g.b.status === 'removed' ? (
              <p>
                <del>{g.b.before}</del>
              </p>
            ) : g.b.status === 'added' ? (
              <p>
                <ins>{g.b.after}</ins>
              </p>
            ) : (
              <p>{g.b.after}</p>
            )}
          </div>
        ),
      )}
    </div>
  );
}

function FilesDiff({ files }: { files: FileChange[] }) {
  if (!files.length) return null;
  return (
    <div className="col" style={{ gap: 12 }}>
      {files.map((f) => {
        let a = 0;
        let b = 0;
        return (
          <section key={f.fileId} className="compare-file">
            <header>
              <span className={`compare-status ${f.status}`}>{t(`versions.status.${f.status}`)}</span>
              <code className="grow truncate">{f.previousPath ? `${f.previousPath} → ${f.path}` : f.path}</code>
              <span className="tabular" style={{ color: 'var(--success)' }}>+{f.additions}</span>
              <span className="tabular" style={{ color: 'var(--danger)' }}>−{f.deletions}</span>
            </header>
            <table className="compare-lines">
              <tbody>
                {f.runs.map((r, i) => {
                  if (r.kind === 'skip') {
                    a = r.aStart + r.count;
                    b = r.bStart + r.count;
                    return (
                      <tr key={i} className="skip">
                        <td colSpan={3}>{plural('versions.unchangedLines', r.count)}</td>
                      </tr>
                    );
                  }
                  a = r.aStart;
                  b = r.bStart;
                  return r.lines.map((line, j) => {
                    const row = (
                      <tr key={`${i}-${j}`} className={r.kind}>
                        <td className="num">{r.kind !== 'added' ? a + 1 : ''}</td>
                        <td className="num">{r.kind !== 'removed' ? b + 1 : ''}</td>
                        <td className="code">
                          <span aria-hidden="true">{r.kind === 'added' ? '+' : r.kind === 'removed' ? '−' : ' '}</span>
                          {line || ' '}
                        </td>
                      </tr>
                    );
                    if (r.kind !== 'added') a++;
                    if (r.kind !== 'removed') b++;
                    return row;
                  });
                })}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}
