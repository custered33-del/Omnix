import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Clock, ShieldCheck, Hourglass } from 'lucide-react';
import { get } from '../lib/api.js';
import { realtime } from '../state/realtime.js';
import { formatRelative, plural, t } from '../i18n/index.js';

export interface ClaudeStatusData {
  connected: boolean;
  connections: { id: string; kind: 'token' | 'oauth'; name: string; mode: 'view' | 'approve' | 'autonomous'; lastUsedAt: string | null }[];
  lastActivity: { ts: string; summary: string; projectId: string | null; projectName: string | null } | null;
  jobs: { running: number; awaitingApproval: number; list: { id: string; title: string; status: string; progress: number; projectId: string | null; message: string }[] };
  openProposals: number;
  proposalsByProject: { projectId: string; name: string; count: number }[];
  mcpUrl: string;
}

/** Claude connection status, refreshed on live events (and every `pollMs` when given, for read-only calls that emit none). */
export function useClaudeStatus(pollMs?: number) {
  const [data, setData] = useState<ClaudeStatusData | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => get<ClaudeStatusData>('/api/claude/status').then((d) => alive && setData(d)).catch(() => {});
    void load();
    const poll = pollMs ? window.setInterval(load, pollMs) : null;
    let timer: number | null = null;
    const debounced = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(load, 600);
    };
    const offs = [realtime.on('proposal', debounced), realtime.on('job', debounced), realtime.on('activity', (m: { entry: { actor: { type: string } } }) => m.entry.actor.type === 'ai' && debounced())];
    return () => {
      alive = false;
      if (poll) window.clearInterval(poll);
      offs.forEach((o) => o());
    };
  }, [pollMs]);
  return data;
}

const MODE_LABEL = { view: 'claude.modeView', approve: 'claude.modeApprove', autonomous: 'claude.modeAutonomous' } as const;

export function ClaudeStatusCard() {
  const data = useClaudeStatus();
  const main = data?.connections.slice().sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))[0];
  return (
    <section className="card status-card" aria-labelledby="claude-status-title">
      <div className="row">
        <Sparkles size={18} style={{ color: 'var(--ai)' }} aria-hidden="true" />
        <h2 id="claude-status-title" style={{ fontSize: 'var(--fs-lg)', flex: 1 }}>
          {t('dashboard.claude')}
        </h2>
        {data && (
          <span className={`badge ${data.connected ? 'success' : ''}`}>
            <span className={`dot ${data.connected ? 'on' : ''}`} aria-hidden="true" />
            {data.connected ? t('claude.connected') : t('claude.notConnected')}
          </span>
        )}
      </div>
      {!data && <div className="skeleton" style={{ height: 60 }} />}
      {data && !data.connected && (
        <>
          <p className="text-2" style={{ fontSize: 'var(--fs-sm)' }}>
            Connect Claude so it can read your projects, make edits you approve, and work on longer jobs.
          </p>
          <Link to="/setup" className="btn btn-ai">
            <Sparkles /> {t('claude.connectCta')}
          </Link>
        </>
      )}
      {data && data.connected && (
        <>
          {main && (
            <div className="status-line">
              <ShieldCheck aria-hidden="true" />
              <span>
                {t(MODE_LABEL[main.mode])} · {main.name}
              </span>
            </div>
          )}
          <div className="status-line">
            <Clock aria-hidden="true" />
            <span>{data.lastActivity ? t('claude.lastSeen', { when: formatRelative(data.lastActivity.ts) }) : t('dashboard.noActivity')}</span>
          </div>
          <div className="status-line">
            <Hourglass aria-hidden="true" />
            <span>
              {data.jobs.running || data.jobs.awaitingApproval
                ? [data.jobs.running ? plural('claude.jobsRunning', data.jobs.running) : null, data.jobs.awaitingApproval ? plural('claude.waitingApproval', data.jobs.awaitingApproval) : null].filter(Boolean).join(' · ')
                : t('claude.noJobs')}
            </span>
          </div>
          {data.jobs.list.length > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {data.jobs.list.map((j) => (
                <li key={j.id} className="col" style={{ gap: 4 }}>
                  <div className="row" style={{ fontSize: 'var(--fs-sm)' }}>
                    {j.projectId ? <Link to={`/projects/${j.projectId}?job=${j.id}`}>{j.title}</Link> : j.title}
                    <span className="spacer" />
                    <span className={`badge ${j.status === 'awaiting_approval' ? 'warning' : 'ai'}`}>{j.status === 'awaiting_approval' ? 'Needs approval' : j.message}</span>
                  </div>
                  <div className="progress" aria-hidden="true">
                    <span style={{ width: `${Math.round(j.progress * 100)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          {data.openProposals > 0 && (
            <div className="col" style={{ gap: 4 }}>
              {data.proposalsByProject.map((p) => (
                <Link key={p.projectId} to={`/projects/${p.projectId}?panel=proposals`} className="badge ai" style={{ alignSelf: 'flex-start' }}>
                  {plural('claude.proposals', p.count)} · {p.name}
                </Link>
              ))}
            </div>
          )}
          <Link to="/settings/claude" style={{ fontSize: 'var(--fs-sm)' }}>
            {t('settings.claude')}
          </Link>
        </>
      )}
    </section>
  );
}
