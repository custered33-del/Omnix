import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { Copy, Trash2, KeyRound } from 'lucide-react';
import { useAuth, type Theme } from '../state/auth.js';
import { del, get, patch, post } from '../lib/api.js';
import { Dialog, NumberField, Select } from '../ui/primitives.js';
import { toast } from '../ui/toast.js';
import { useCommandStore } from '../state/commands.js';
import { formatRelative, t } from '../i18n/index.js';
import { ClaudeConnections } from '../components/ClaudeConnections.js';
import { PluginSettings } from '../components/Plugins.js';

function Section(props: { title: string; children: React.ReactNode; description?: string }) {
  return (
    <section className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 'var(--fs-lg)' }}>{props.title}</h2>
        {props.description && <p className="text-2" style={{ marginTop: 4, fontSize: 'var(--fs-sm)' }}>{props.description}</p>}
      </div>
      {props.children}
    </section>
  );
}

function AccountSettings() {
  const user = useAuth((s) => s.user)!;
  const setUser = useAuth((s) => s.setUser);
  const [name, setName] = useState(user.name);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  return (
    <div className="col" style={{ gap: 24 }}>
      <Section title={t('settings.account')}>
        <dl className="kv">
          <dt>{t('auth.email')}</dt>
          <dd>{user.email}</dd>
          <dt>Role</dt>
          <dd>{user.role === 'owner' ? 'Server owner' : 'Member'}</dd>
        </dl>
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await patch<{ user: typeof user }>('/api/auth/me', { name });
            setUser(r.user);
            toast.success(t('app.save'));
          }}
        >
          <div className="field grow">
            <label htmlFor="acct-name">{t('auth.name')}</label>
            <input id="acct-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <button className="btn" type="submit" style={{ alignSelf: 'flex-end' }}>
            {t('app.save')}
          </button>
        </form>
      </Section>
      <Section title={t('settings.password')}>
        <form
          className="col"
          style={{ gap: 12, maxWidth: 360 }}
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await post('/api/auth/password', { current, next });
              setCurrent('');
              setNext('');
              toast.success(t('settings.passwordChanged'));
            } catch (err) {
              toast.error((err as Error).message);
            }
          }}
        >
          <div className="field">
            <label htmlFor="pw-cur">{t('settings.currentPassword')}</label>
            <input id="pw-cur" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="pw-new">{t('settings.newPassword')}</label>
            <input id="pw-new" className="input" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
          <button className="btn" type="submit" style={{ alignSelf: 'flex-start' }} disabled={!current || next.length < 8}>
            {t('settings.password')}
          </button>
        </form>
      </Section>
    </div>
  );
}

function AppearanceSettings() {
  const user = useAuth((s) => s.user)!;
  const update = useAuth((s) => s.updatePreferences);
  const openShortcuts = useCommandStore((s) => s.openShortcuts);
  const prefs = user.preferences;
  return (
    <div className="col" style={{ gap: 24 }}>
      <Section title={t('settings.appearance')}>
        <div className="field">
          <span className="label">{t('settings.theme')}</span>
          <div className="segmented" role="group" aria-label={t('settings.theme')}>
            {(
              [
                ['system', t('settings.themeSystem')],
                ['light', t('settings.themeLight')],
                ['dark', t('settings.themeDark')],
                ['high-contrast', t('settings.themeContrast')],
              ] as [Theme, string][]
            ).map(([v, label]) => (
              <button key={v} aria-pressed={prefs.theme === v} onClick={() => void update({ theme: v })}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="label">{t('settings.motion')}</span>
          <div className="segmented" role="group" aria-label={t('settings.motion')}>
            {(
              [
                ['system', t('settings.motionSystem')],
                ['on', t('settings.motionReduced')],
                ['off', t('settings.motionFull')],
              ] as ['system' | 'on' | 'off', string][]
            ).map(([v, label]) => (
              <button key={v} aria-pressed={prefs.reducedMotion === v} onClick={() => void update({ reducedMotion: v })}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ maxWidth: 260 }}>
          <Select
            label={t('settings.language')}
            value={prefs.locale || 'en'}
            options={[{ value: 'en', label: 'English' }]}
            onChange={(v) => void update({ locale: v })}
          />
        </div>
      </Section>
      <Section title={t('settings.pen')} description={t('settings.penHint')}>
        <div style={{ maxWidth: 360 }}>
          <NumberField label="Pressure curve" value={prefs.pressureGamma} min={0.3} max={3} step={0.1} onCommit={(v) => void update({ pressureGamma: v })} />
        </div>
      </Section>
      <Section title={t('settings.shortcuts')}>
        <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => openShortcuts(true)}>
          {t('shortcuts.title')}
        </button>
      </Section>
    </div>
  );
}

interface TokenRow {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  prefix: string;
}

export function TokenSettings() {
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [name, setName] = useState('Claude Desktop');
  const [mode, setMode] = useState<'view' | 'approve' | 'autonomous'>('approve');
  const [created, setCreated] = useState<string | null>(null);
  const load = () => get<{ tokens: TokenRow[] }>('/api/auth/tokens').then((r) => setTokens(r.tokens), (e) => toast.error(e.message));
  useEffect(() => {
    void load();
  }, []);
  const scopes = mode === 'autonomous' ? ['omnix:read', 'omnix:edit', 'omnix:autonomous'] : mode === 'approve' ? ['omnix:read', 'omnix:edit'] : ['omnix:read'];
  return (
    <Section title={t('settings.tokens')} description={t('settings.tokensHint')}>
      <form
        className="row"
        style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await post<{ token: string }>('/api/auth/tokens', { name, scopes });
            setCreated(r.token);
            void load();
          } catch (err) {
            toast.error((err as Error).message);
          }
        }}
      >
        <div className="field" style={{ width: 220 }}>
          <label htmlFor="tok-name">{t('settings.tokenName')}</label>
          <input id="tok-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div style={{ width: 220 }}>
          <Select
            label="Permission"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'view', label: t('claude.modeView') },
              { value: 'approve', label: t('claude.modeApprove') },
              { value: 'autonomous', label: t('claude.modeAutonomous') },
            ]}
          />
        </div>
        <button className="btn btn-primary" type="submit" disabled={!name.trim()}>
          <KeyRound /> {t('settings.newToken')}
        </button>
      </form>
      <ul className="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {tokens?.map((tk) => (
          <li key={tk.id} className="list-row" style={{ cursor: 'default' }}>
            <KeyRound size={16} className="muted" aria-hidden="true" />
            <span className="grow">
              <strong>{tk.name}</strong> <span className="muted mono">{tk.prefix}…</span>
              <br />
              <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
                {tk.scopes.includes('omnix:autonomous') ? t('claude.modeAutonomous') : tk.scopes.includes('omnix:edit') ? t('claude.modeApprove') : t('claude.modeView')} · created {formatRelative(tk.createdAt)}
                {tk.lastUsedAt ? ` · used ${formatRelative(tk.lastUsedAt)}` : ''}
              </span>
            </span>
            <button className="btn btn-sm btn-danger" onClick={() => void del(`/api/auth/tokens/${tk.id}`).then(load)}>
              <Trash2 /> {t('settings.revoke')}
            </button>
          </li>
        ))}
      </ul>
      {created && (
        <Dialog title={t('settings.newToken')} onClose={() => setCreated(null)} description={t('settings.tokenCreated')}>
          <div className="row">
            <input className="input mono" readOnly value={created} aria-label="Token" onFocus={(e) => e.currentTarget.select()} />
            <button
              className="btn"
              onClick={() => {
                void navigator.clipboard.writeText(created);
                toast.success(t('app.copied'));
              }}
            >
              <Copy /> {t('app.copy')}
            </button>
          </div>
        </Dialog>
      )}
    </Section>
  );
}

export function SettingsPage() {
  const tabs = [
    ['', t('settings.account')],
    ['appearance', t('settings.appearance')],
    ['claude', t('settings.claude')],
    ['plugins', t('plugins.title')],
  ] as const;
  return (
    <div className="page" style={{ maxWidth: 960 }}>
      <header className="page-header">
        <h1>{t('settings.title')}</h1>
      </header>
      <nav className="tabs" style={{ marginBottom: 24 }} aria-label={t('settings.title')}>
        {tabs.map(([path, label]) => (
          <NavLink key={path} to={`/settings${path ? `/${path}` : ''}`} end className="tab" style={({ isActive }) => (isActive ? { color: 'var(--text)', borderBottomColor: 'var(--accent)' } : {})}>
            {label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<AccountSettings />} />
        <Route path="appearance" element={<AppearanceSettings />} />
        <Route path="plugins" element={<PluginSettings />} />
        <Route
          path="claude"
          element={
            <div className="col" style={{ gap: 24 }}>
              <ClaudeConnections />
              <TokenSettings />
            </div>
          }
        />
      </Routes>
    </div>
  );
}
