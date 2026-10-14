import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Check, FolderOpen, Loader2, Play, ShieldCheck, Sparkles, X } from 'lucide-react';
import { useAuth } from '../state/auth.js';
import { get, post } from '../lib/api.js';
import { formatRelative, t, type MessageKey } from '../i18n/index.js';
import { PresetPicker, MODE_LABEL, type PermissionMode } from '../components/PresetPicker.js';
import { ToolIcon } from '../ui/icons.js';
import type { ToolKind } from '@omnix/core';
import '../styles/setup.css';

interface RequestInfo {
  client: { name: string; redirectHost: string; clientUri: string | null };
  maxMode: PermissionMode;
  defaultMode: PermissionMode;
  projects: { id: string; name: string; primaryTool: ToolKind; aiConsent: boolean }[];
  expiresAt: string;
}

const PERMS: { icon: typeof FolderOpen; title: MessageKey; body: MessageKey; mode: PermissionMode }[] = [
  { icon: FolderOpen, title: 'setup.oauth.readTitle', body: 'setup.oauth.readBody', mode: 'view' },
  { icon: Sparkles, title: 'setup.oauth.editTitle', body: 'setup.oauth.editBody', mode: 'approve' },
  { icon: Play, title: 'setup.oauth.autoTitle', body: 'setup.oauth.autoBody', mode: 'autonomous' },
];

/**
 * The approval screen Claude sends people to when they click Connect. It names the app,
 * explains each permission in plain words, and lets the person choose the permission mode
 * and which projects the connection may reach before approving or denying.
 */
export function ConnectPage() {
  const { requestId = '' } = useParams();
  const user = useAuth((s) => s.user)!;
  const logout = useAuth((s) => s.logout);
  const [info, setInfo] = useState<RequestInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<PermissionMode>('approve');
  const [scope, setScope] = useState<'all' | 'some'>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);

  useEffect(() => {
    get<RequestInfo>(`/api/oauth/requests/${encodeURIComponent(requestId)}`).then(
      (r) => {
        setInfo(r);
        const order: PermissionMode[] = ['view', 'approve', 'autonomous'];
        setMode(order.indexOf(r.defaultMode) > order.indexOf(r.maxMode) ? r.maxMode : r.defaultMode);
        document.title = `${t('connect.title', { client: r.client.name })} · Omnix`;
      },
      (e: Error) => setError(e.message),
    );
  }, [requestId]);

  const decide = async (approve: boolean) => {
    setSending(true);
    try {
      const r = await post<{ redirect: string }>(`/api/oauth/requests/${encodeURIComponent(requestId)}/decision`, { approve, mode, projectIds: scope === 'all' ? 'all' : [...picked] });
      window.location.assign(r.redirect);
    } catch (e) {
      setError((e as Error).message);
      setSending(false);
    }
  };

  if (error) {
    return (
      <main className="connect-page" id="main">
        <section className="card connect-card">
          <h1>{t('connect.errorTitle')}</h1>
          <p>{error}</p>
          <Link to="/help/troubleshooting#expired-window">{t('troubleshoot.title')}</Link>
        </section>
      </main>
    );
  }
  if (!info) {
    return (
      <main className="connect-page" id="main" aria-busy="true">
        <div className="skeleton" style={{ width: 'min(640px, 92vw)', height: 420 }} />
      </main>
    );
  }
  const client = info.client.name;
  const order: PermissionMode[] = ['view', 'approve', 'autonomous'];
  const canApprove = !sending && (scope === 'all' || picked.size > 0);
  return (
    <main className="connect-page" id="main">
      <section className="card connect-card" aria-labelledby="connect-title">
        <div className="connect-brand" aria-hidden="true">
          <span className="brand-mark" />
          <ShieldCheck />
        </div>
        <h1 id="connect-title">{t('connect.title', { client })}</h1>
        <p className="muted">
          {t('connect.signedInAs', { name: user.name, email: user.email })}{' '}
          <button className="link-btn" onClick={() => void logout()}>
            {t('connect.notYou')}
          </button>
        </p>

        <h2>{t('connect.whatTitle', { client })}</h2>
        <ul className="perm-list">
          {PERMS.filter((p) => order.indexOf(p.mode) <= order.indexOf(mode)).map((p) => (
            <li key={p.title}>
              <span className="perm-icon" aria-hidden="true">
                <p.icon />
              </span>
              <div>
                <strong>{t(p.title)}</strong>
                <p>{t(p.body)}</p>
              </div>
            </li>
          ))}
        </ul>

        <h2>{t('connect.modeTitle')}</h2>
        <PresetPicker value={mode} onChange={setMode} label={t('connect.modeTitle')} max={info.maxMode} />
        {info.maxMode !== 'autonomous' && <p className="muted">{t('connect.limitedByApp', { mode: t(MODE_LABEL[info.maxMode]) })}</p>}

        <fieldset className="connect-projects">
          <legend>
            <h2>{t('connect.projectsTitle')}</h2>
          </legend>
          <label className="check-label">
            <input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} /> {t('connect.allProjects')}
          </label>
          <label className="check-label">
            <input type="radio" name="scope" checked={scope === 'some'} onChange={() => setScope('some')} disabled={!info.projects.length} /> {t('connect.someProjects')}
          </label>
          {!info.projects.length && <p className="muted">{t('connect.noProjects')}</p>}
          {scope === 'some' && (
            <ul className="connect-project-list">
              {info.projects.map((p) => (
                <li key={p.id}>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={picked.has(p.id)}
                      onChange={(e) => {
                        const n = new Set(picked);
                        if (e.target.checked) n.add(p.id);
                        else n.delete(p.id);
                        setPicked(n);
                      }}
                    />
                    <ToolIcon tool={p.primaryTool} />
                    <span className="grow">{p.name}</span>
                    {!p.aiConsent && <span className="badge">{t('connect.aiOff')}</span>}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="muted">{t('connect.aiOffNote')}</p>
          {scope === 'some' && picked.size === 0 && (
            <p className="muted" role="status">
              {t('connect.pickOne')}
            </p>
          )}
        </fieldset>

        <p className="muted">
          {t('connect.returnsTo', { host: info.client.redirectHost })} {t('connect.changeLater')} {t('connect.expires', { when: formatRelative(info.expiresAt) })}
        </p>
        <footer className="connect-actions">
          <button className="btn" onClick={() => void decide(false)} disabled={sending}>
            <X /> {t('connect.deny')}
          </button>
          <button className="btn btn-primary" onClick={() => void decide(true)} disabled={!canApprove}>
            {sending ? <Loader2 className="spin" /> : <Check />} {sending ? t('connect.sending', { client }) : t('connect.approve')}
          </button>
        </footer>
      </section>
    </main>
  );
}
