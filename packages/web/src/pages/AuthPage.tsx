import { useState, type FormEvent } from 'react';
import { useAuth } from '../state/auth.js';
import { t } from '../i18n/index.js';

export function AuthPage() {
  const needsFirst = useAuth((s) => s.needsFirstAccount);
  const login = useAuth((s) => s.login);
  const signup = useAuth((s) => s.signup);
  const [mode, setMode] = useState<'login' | 'signup'>(needsFirst ? 'signup' : 'login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isSignup = mode === 'signup';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isSignup) await signup(email, name, password);
      else await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth" id="main">
      <form className="card auth-card" onSubmit={submit} aria-labelledby="auth-title">
        <div className="brand" aria-hidden="true">
          <span className="brand-mark" />
          {t('app.name')}
        </div>
        <h1 id="auth-title">{isSignup ? t('auth.welcome') : t('auth.welcomeBack')}</h1>
        <p className="text-2">{needsFirst ? t('auth.firstAccount') : t('auth.signInPrompt')}</p>
        {isSignup && (
          <div className="field">
            <label htmlFor="name">{t('auth.name')}</label>
            <input id="name" className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label htmlFor="email">{t('auth.email')}</label>
          <input id="email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label htmlFor="password">{t('auth.password')}</label>
          <input id="password" className="input" type="password" autoComplete={isSignup ? 'new-password' : 'current-password'} required minLength={isSignup ? 8 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby={isSignup ? 'pw-hint' : undefined} />
          {isSignup && (
            <span id="pw-hint" className="hint">
              {t('auth.passwordHint')}
            </span>
          )}
        </div>
        {error && (
          <p className="error" role="alert" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
          {isSignup ? t('auth.signUp') : t('auth.signIn')}
        </button>
        {!needsFirst && (
          <button type="button" className="btn btn-ghost" onClick={() => setMode(isSignup ? 'login' : 'signup')}>
            {isSignup ? t('auth.haveAccount') : t('auth.noAccount')}
          </button>
        )}
      </form>
    </main>
  );
}
