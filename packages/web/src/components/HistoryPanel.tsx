import { useCallback, useEffect, useState } from 'react';
import { RotateCcw, GitBranch, Bookmark, Undo } from 'lucide-react';
import type { Commit, Snapshot, StateDiff } from '@omnix/core';
import { useProject, useProjectStore } from '../state/project.js';
import { get, post } from '../lib/api.js';
import { Avatar, Dialog, Spinner } from '../ui/primitives.js';
import { toast } from '../ui/toast.js';
import { DiffView } from './ProposalsPanel.js';
import { realtime } from '../state/realtime.js';
import { formatRelative, t } from '../i18n/index.js';

type CommitSummary = Omit<Commit, 'op' | 'inverse'>;

export function HistoryPanel({ focusCommit }: { focusCommit: string | null }) {
  const store = useProjectStore();
  const projectId = store.getState().projectId;
  const head = useProject((s) => s.head);
  const snapshots = useProject((s) => s.snapshots);
  const canEdit = useProject((s) => s.meta?.role !== 'viewer');
  const [data, setData] = useState<{ commits: CommitSummary[]; tips: string[] } | null>(null);
  const [detail, setDetail] = useState<string | null>(focusCommit);
  const [snapName, setSnapName] = useState('');
  const load = useCallback(() => {
    get<{ commits: CommitSummary[]; tips: string[] }>(`/api/projects/${projectId}/history`).then(setData, (e) => toast.error(e.message));
  }, [projectId]);
  useEffect(() => {
    load();
  }, [load, head]);
  useEffect(() => realtime.on('snapshot', load), [load]);
  const commits = data ? [...data.commits].reverse() : null;
  return (
    <div className="col" style={{ gap: 16 }}>
      {canEdit && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void store
              .getState()
              .snapshot(snapName || new Date().toLocaleString())
              .then(() => {
                setSnapName('');
                toast.success(t('project.snapshot'));
              });
          }}
        >
          <input className="input sm" placeholder={t('project.snapshotName')} value={snapName} onChange={(e) => setSnapName(e.target.value)} aria-label={t('project.snapshotName')} />
          <button className="btn btn-sm" type="submit">
            <Bookmark /> {t('project.snapshot')}
          </button>
        </form>
      )}
      {snapshots.length > 0 && (
        <section>
          <h3 className="section-title" style={{ marginBottom: 6 }}>
            {t('history.versions')}
          </h3>
          <ul className="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {[...snapshots].reverse().map((s: Snapshot) => (
              <li key={s.id} className="list-row" onClick={() => s.commitId && setDetail(s.commitId)}>
                <Bookmark size={14} aria-hidden="true" />
                <span className="grow truncate">{s.name}</span>
                <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
                  {formatRelative(s.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
        {t('project.branchNote')}
      </p>
      {!commits && <Spinner />}
      {commits && commits.length === 0 && <p className="muted">{t('history.empty')}</p>}
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {commits?.map((c) => (
          <li key={c.id}>
            <button className="list-row" style={{ width: '100%', border: 'none', background: c.id === detail ? 'var(--accent-soft)' : 'transparent', textAlign: 'left', alignItems: 'flex-start', padding: '8px 6px' }} onClick={() => setDetail(c.id)} aria-current={c.id === head ? 'true' : undefined}>
              <Avatar name={c.author.name} ai={c.author.type === 'ai'} />
              <span className="grow" style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 'var(--fs-sm)' }}>
                  {c.label} {c.id === head && <span className="badge accent">{t('history.current')}</span>}
                  {data?.tips.includes(c.id) && c.id !== head && (
                    <span className="badge">
                      <GitBranch /> branch
                    </span>
                  )}
                </span>
                <span className="muted" style={{ display: 'block', fontSize: 'var(--fs-xs)' }}>
                  {c.author.name} · {formatRelative(c.timestamp)}
                  {c.approvedBy ? ` · ${t('history.approvedBy', { name: c.approvedBy.name })}` : ''}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      {detail && <CommitDialog commitId={detail} onClose={() => setDetail(null)} canEdit={canEdit} />}
    </div>
  );
}

function CommitDialog({ commitId, onClose, canEdit }: { commitId: string; onClose: () => void; canEdit: boolean }) {
  const store = useProjectStore();
  const projectId = store.getState().projectId;
  const [data, setData] = useState<{ commit: Commit; diff: StateDiff } | null>(null);
  useEffect(() => {
    get<{ commit: Commit; diff: StateDiff }>(`/api/projects/${projectId}/commits/${commitId}`).then(setData, (e) => toast.error(e.message));
  }, [commitId, projectId]);
  return (
    <Dialog
      title={data?.commit.label ?? t('history.title')}
      onClose={onClose}
      wide
      footer={
        canEdit && data ? (
          <>
            <button
              className="btn"
              onClick={() =>
                void post(`/api/projects/${projectId}/revert`, { commitId }).then(
                  () => {
                    toast.success(t('history.revert'));
                    onClose();
                  },
                  (e) => toast.error(e.message),
                )
              }
            >
              <Undo /> {t('history.revert')}
            </button>
            <button
              className="btn btn-primary"
              onClick={() =>
                void store
                  .getState()
                  .checkout(commitId)
                  .then(onClose, (e) => toast.error(e.message))
              }
            >
              <RotateCcw /> {t('history.restore')}
            </button>
          </>
        ) : undefined
      }
    >
      {!data && <Spinner />}
      {data && (
        <div className="col" style={{ gap: 16 }}>
          <div className="row">
            <Avatar name={data.commit.author.name} ai={data.commit.author.type === 'ai'} />
            <span>
              {data.commit.author.name} · {new Date(data.commit.timestamp).toLocaleString()}
              {data.commit.approvedBy ? ` · ${t('history.approvedBy', { name: data.commit.approvedBy.name })}` : ''}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <figure style={{ margin: 0 }}>
              <img src={`/api/projects/${projectId}/render-at?commit=${data.commit.parentId ?? 'base'}&size=480`} alt="Before" style={{ borderRadius: 8, border: '1px solid var(--border)' }} />
              <figcaption className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
                Before
              </figcaption>
            </figure>
            <figure style={{ margin: 0 }}>
              <img src={`/api/projects/${projectId}/render-at?commit=${data.commit.id}&size=480`} alt="After" style={{ borderRadius: 8, border: '1px solid var(--border)' }} />
              <figcaption className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
                After
              </figcaption>
            </figure>
          </div>
          <DiffView diff={data.diff} />
        </div>
      )}
    </Dialog>
  );
}
