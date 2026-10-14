import { Link } from 'react-router-dom';
import { Copy, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { refreshClaudeStatus, setConnectionMode, useClaudeStatus, type ClaudeStatusData } from './ClaudeStatus.js';
import { ConfirmDialog } from '../ui/primitives.js';
import { del } from '../lib/api.js';
import { toast } from '../ui/toast.js';
import { formatRelative, plural, t } from '../i18n/index.js';

const MODE = { view: 'claude.modeView', approve: 'claude.modeApprove', autonomous: 'claude.modeAutonomous' } as const;

/** Connected Claude clients (connector grants and access tokens) and the connector URL. */
export function ClaudeConnections() {
  const data = useClaudeStatus();
  const [revoking, setRevoking] = useState<ClaudeStatusData['connections'][number] | null>(null);
  return (
    <section className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="row">
        <Sparkles size={18} style={{ color: 'var(--ai)' }} aria-hidden="true" />
        <h2 style={{ fontSize: 'var(--fs-lg)', flex: 1 }}>{t('settings.claude')}</h2>
        <Link to="/setup" className="btn btn-sm">
          {t('nav.setupGuide')}
        </Link>
      </div>
      {data && (
        <div className="field">
          <span className="label">Connector URL</span>
          <div className="row">
            <input className="input mono" readOnly value={data.mcpUrl} aria-label="Connector URL" onFocus={(e) => e.currentTarget.select()} />
            <button
              className="btn"
              onClick={() => {
                void navigator.clipboard.writeText(data.mcpUrl);
                toast.success(t('app.copied'));
              }}
            >
              <Copy /> {t('app.copy')}
            </button>
          </div>
        </div>
      )}
      {data && data.connections.length === 0 && <p className="muted">{t('claude.notConnected')}</p>}
      <ul className="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {data?.connections.map((c) => (
          <li key={c.id} className="list-row" style={{ cursor: 'default', gap: 10 }}>
            <span className={`dot ${c.lastUsedAt ? 'on' : ''}`} aria-hidden="true" />
            <span className="grow">
              <strong>{c.name}</strong> <span className="badge">{c.kind === 'oauth' ? 'Connector' : 'Token'}</span>
              <br />
              <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
                {c.projectIds === 'all' ? t('claude.allProjects') : plural('claude.someProjects', c.projectIds.length)}
                {c.lastUsedAt ? ` · ${t('claude.lastSeen', { when: formatRelative(c.lastUsedAt) })}` : ` · ${t('claude.neverUsed')}`}
              </span>
            </span>
            <select className="select sm" aria-label={t('claude.permission', { name: c.name })} value={c.mode} onChange={(e) => void setConnectionMode(c.id, e.target.value as 'view' | 'approve' | 'autonomous').then(() => toast.success(t('claude.modeChanged')), (err: Error) => toast.error(err.message))}>
              {(['view', 'approve', 'autonomous'] as const).map((m) => (
                <option key={m} value={m}>
                  {t(MODE[m])}
                </option>
              ))}
            </select>
            <button className="btn btn-sm btn-danger" onClick={() => setRevoking(c)}>
              {t('claude.disconnect')}
            </button>
          </li>
        ))}
      </ul>
      {revoking && (
        <ConfirmDialog
          title={t('claude.disconnectTitle', { name: revoking.name })}
          message={t('claude.disconnectBody')}
          confirmLabel={t('claude.disconnect')}
          danger
          onConfirm={async () => {
            await del(`/api/claude/connections/${encodeURIComponent(revoking.id)}`);
            refreshClaudeStatus();
            toast.success(t('claude.disconnected', { name: revoking.name }));
          }}
          onClose={() => setRevoking(null)}
        />
      )}
    </section>
  );
}
