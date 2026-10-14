import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../lib/api.js';
import { realtime } from '../state/realtime.js';
import { Avatar } from '../ui/primitives.js';
import { formatRelative, t } from '../i18n/index.js';

export interface ActivityEntry {
  id: string;
  ts: string;
  projectId: string | null;
  projectName: string | null;
  actor: { type: 'human' | 'ai' | 'system'; id: string; name: string };
  kind: string;
  summary: string;
  via: 'ui' | 'mcp' | 'api' | 'agent' | 'system';
  commitId?: string;
  proposalId?: string;
  tool?: string;
  ok?: boolean;
}

export function useActivity(options: { projectId?: string; actor?: 'ai' | 'human'; limit?: number; changesOnly?: boolean }) {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(options);
  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams({ limit: String(options.limit ?? 30) });
    if (options.projectId) params.set('projectId', options.projectId);
    if (options.actor) params.set('actor', options.actor);
    get<{ entries: ActivityEntry[] }>(`/api/activity?${params}`)
      .then((r) => alive && setEntries(r.entries))
      .catch((e) => alive && setError(e.message));
    const off = realtime.on('activity', (msg: { entry: ActivityEntry }) => {
      const e = msg.entry;
      if (options.projectId && e.projectId !== options.projectId) return;
      if (options.actor && e.actor.type !== options.actor) return;
      setEntries((cur) => [e, ...(cur ?? [])].slice(0, options.limit ?? 30));
    });
    return () => {
      alive = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const filtered = options.changesOnly && entries ? entries.filter((e) => e.kind !== 'tool' || e.ok === false) : entries;
  return { entries: filtered, error };
}

export function ActivityItem({ e, showProject = true }: { e: ActivityEntry; showProject?: boolean }) {
  const via = t(`activity.via.${e.via}`);
  return (
    <li className="feed-item">
      <Avatar name={e.actor.name} ai={e.actor.type === 'ai'} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="what">
          <strong>{e.actor.name}</strong> {e.summary}
          {e.ok === false && <span className="badge danger" style={{ marginLeft: 6 }}>{t('activity.failed')}</span>}
        </div>
        <div className="when">
          {formatRelative(e.ts)}
          {via ? ` · ${via}` : ''}
          {showProject && e.projectId && e.projectName && (
            <>
              {' · '}
              <Link to={`/projects/${e.projectId}${e.commitId ? `?commit=${e.commitId}` : e.proposalId ? `?proposal=${e.proposalId}` : ''}`}>{e.projectName}</Link>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

export function ActivityFeed(props: { projectId?: string; limit?: number; showProject?: boolean; filter?: boolean; changesOnly?: boolean }) {
  const [actor, setActor] = useState<'all' | 'human' | 'ai'>('all');
  const { entries, error } = useActivity({ ...(props.projectId ? { projectId: props.projectId } : {}), ...(actor !== 'all' ? { actor } : {}), limit: props.limit ?? 30, ...(props.changesOnly ? { changesOnly: true } : {}) });
  return (
    <div>
      {props.filter && (
        <div className="segmented" role="group" aria-label={t('activity.title')} style={{ marginBottom: 8 }}>
          {(['all', 'human', 'ai'] as const).map((a) => (
            <button key={a} aria-pressed={actor === a} onClick={() => setActor(a)}>
              {a === 'all' ? t('activity.filterAll') : a === 'human' ? t('activity.filterHuman') : t('activity.filterAi')}
            </button>
          ))}
        </div>
      )}
      {error && <p className="muted">{error}</p>}
      {entries && entries.length === 0 && <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>{t('dashboard.noActivity')}</p>}
      {!entries && !error && <div className="skeleton" style={{ height: 120 }} />}
      <ul className="feed" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {entries?.map((e) => <ActivityItem key={e.id} e={e} showProject={props.showProject ?? true} />)}
      </ul>
    </div>
  );
}
