import { Link } from 'react-router-dom';
import { Copy, Sparkles } from 'lucide-react';
import { useClaudeStatus } from './ClaudeStatus.js';
import { toast } from '../ui/toast.js';
import { formatRelative, t } from '../i18n/index.js';

const MODE = { view: 'claude.modeView', approve: 'claude.modeApprove', autonomous: 'claude.modeAutonomous' } as const;

/** Connected Claude clients (connector grants and access tokens) and the connector URL. */
export function ClaudeConnections() {
  const data = useClaudeStatus();
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
          <li key={c.id} className="list-row" style={{ cursor: 'default' }}>
            <span className={`dot ${c.lastUsedAt ? 'on' : ''}`} aria-hidden="true" />
            <span className="grow">
              <strong>{c.name}</strong> <span className="badge">{c.kind === 'oauth' ? 'Connector' : 'Token'}</span>
              <br />
              <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
                {t(MODE[c.mode])}
                {c.lastUsedAt ? ` · ${t('claude.lastSeen', { when: formatRelative(c.lastUsedAt) })}` : ''}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
