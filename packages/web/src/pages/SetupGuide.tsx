import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Check, CheckCircle2, ChevronLeft, ChevronRight, CircleSlash, Copy, ExternalLink, FolderOpen, Globe, HardDrive, KeyRound, Loader2, Play, ShieldCheck, Sparkles, XCircle } from 'lucide-react';
import { useAuth } from '../state/auth.js';
import { get, post } from '../lib/api.js';
import { formatRelative, t, type MessageKey } from '../i18n/index.js';
import { formatShortcut } from '../ui/shortcuts.js';
import { toast } from '../ui/toast.js';
import { useClaudeStatus } from '../components/ClaudeStatus.js';
import { PresetPicker, MODE_LABEL } from '../components/PresetPicker.js';
import '../styles/setup.css';

export const SETUP_STEPS = ['account', 'open-connectors', 'add-connector', 'oauth', 'scope', 'test', 'first-project'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
type Mode = 'view' | 'approve' | 'autonomous';

const STEP_TITLE: Record<SetupStep, MessageKey> = {
  account: 'setup.steps.account',
  'open-connectors': 'setup.steps.openConnectors',
  'add-connector': 'setup.steps.addConnector',
  oauth: 'setup.steps.oauth',
  scope: 'setup.steps.scope',
  test: 'setup.steps.test',
  'first-project': 'setup.steps.firstProject',
};


/** Claude's connector settings (the same page serves claude.ai and the Claude apps). */
export const CLAUDE_CONNECTORS_URL = 'https://claude.ai/settings/connectors';

interface SetupInfo {
  publicUrl: string;
  mcpUrl: string;
  local: boolean;
  https: boolean;
  storage: 'file' | 'postgres' | 'memory';
  blobs: 'local' | 's3';
  dataDir?: string;
  installDir?: string;
}

export interface SelfCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  detail: string;
  fix?: string;
  help?: string;
}

/** Read-only value with a copy button that announces the copy to screen readers. */
export function CopyField({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      },
      () => toast.error('Copy failed. Select the text and copy it yourself.'),
    );
  };
  return (
    <div className="copy-field">
      <span className="label">{label}</span>
      <div className="copy-row">
        {multiline ? (
          <pre className="copy-value mono" tabIndex={0} aria-label={label}>
            {value}
          </pre>
        ) : (
          <input className="input mono copy-value" readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
        )}
        <button className="btn" onClick={copy} aria-label={`${t('app.copy')}: ${label}`}>
          {copied ? <Check /> : <Copy />} {copied ? t('app.copied') : t('app.copy')}
        </button>
      </div>
      <span className="sr-only" aria-live="polite">
        {copied ? t('app.copied') : ''}
      </span>
    </div>
  );
}

function Callout({ tone, title, children }: { tone: 'warn' | 'info' | 'danger'; title?: string; children: ReactNode }) {
  const Icon = tone === 'info' ? ShieldCheck : AlertTriangle;
  return (
    <div className={`callout ${tone}`} role={tone === 'info' ? undefined : 'note'}>
      <Icon aria-hidden="true" />
      <div>
        {title && <strong>{title}</strong>}
        <div>{children}</div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Steps                                                             */
/* ---------------------------------------------------------------- */

function AccountStep({ info }: { info: SetupInfo | null }) {
  const user = useAuth((s) => s.user)!;
  return (
    <>
      <p>{t('setup.account.signedIn', { name: user.name, email: user.email })}</p>
      <h3>{t('setup.account.storedTitle')}</h3>
      <ul className="setup-list">
        <li>
          <FolderOpen aria-hidden="true" />
          {info?.storage === 'postgres' ? t('setup.account.projectsPostgres') : info?.storage === 'memory' ? t('setup.account.projectsMemory') : t('setup.account.projectsFile')}
        </li>
        <li>
          <HardDrive aria-hidden="true" />
          {info?.blobs === 's3' ? t('setup.account.filesS3') : t('setup.account.filesLocal')}
        </li>
        <li>
          <KeyRound aria-hidden="true" />
          {t('setup.account.account')}
        </li>
        <li>
          <ShieldCheck aria-hidden="true" />
          {t('setup.account.connections')}
        </li>
      </ul>
      {info?.dataDir && (
        <p className="muted">
          {t('setup.account.dataDir')}: <code>{info.dataDir}</code>
        </p>
      )}
      <Callout tone="info">{t('setup.account.anthropic')}</Callout>
    </>
  );
}

/** A drawing of Claude's Settings → Connectors page, so people know what to look for. */
function ConnectorsMock() {
  return (
    <figure className="claude-mock" aria-describedby="claude-mock-caption">
      <div className="claude-mock-window" aria-hidden="true">
        <div className="claude-mock-side">
          <span>{t('setup.open.mockSettings')}</span>
          <span className="on">{t('setup.open.mockConnectors')}</span>
          <span className="ghost" />
          <span className="ghost" />
        </div>
        <div className="claude-mock-main">
          <strong>{t('setup.open.mockYours')}</strong>
          <span className="ghost-row" />
          <span className="ghost-row" />
          <span className="claude-mock-add">+ {t('setup.open.mockAdd')}</span>
        </div>
      </div>
      <figcaption id="claude-mock-caption">{t('setup.open.mockCaption')}</figcaption>
    </figure>
  );
}

function OpenStep({ info }: { info: SetupInfo | null }) {
  const [other, setOther] = useState(false);
  const mcpUrl = info?.mcpUrl ?? `${location.origin}/mcp`;
  const desktop = JSON.stringify(
    {
      mcpServers: {
        omnix: {
          command: 'pnpm',
          args: ['--dir', info?.installDir ?? '/path/to/omnix', 'mcp:stdio'],
          env: { OMNIX_URL: info?.publicUrl ?? location.origin, OMNIX_TOKEN: 'omx_…' },
        },
      },
    },
    null,
    2,
  );
  return (
    <>
      <p>{t('setup.open.intro')}</p>
      <p>
        <a className="btn btn-primary" href={CLAUDE_CONNECTORS_URL} target="_blank" rel="noreferrer">
          <ExternalLink /> {t('setup.open.button')}
        </a>
      </p>
      <p className="muted">{t('setup.open.where')}</p>
      <ConnectorsMock />
      <Callout tone="info">{t('setup.open.team')}</Callout>
      <div className="disclosure">
        <button className="btn btn-ghost btn-sm" aria-expanded={other} onClick={() => setOther(!other)}>
          <ChevronRight className={other ? 'rot-90' : ''} /> {t('setup.open.otherTitle')}
        </button>
        {other && (
          <div className="disclosure-body">
            <p>{t('setup.open.codeBody')}</p>
            <CopyField label="Claude Code" value={`claude mcp add --transport http omnix ${mcpUrl} --header "Authorization: Bearer omx_…"`} />
            <p>{t('setup.open.desktopBody')}</p>
            <CopyField label="claude_desktop_config.json" value={desktop} multiline />
            <p>
              <Link to="/settings/claude">{t('settings.tokens')}</Link>
            </p>
          </div>
        )}
      </div>
    </>
  );
}

function AddStep({ info }: { info: SetupInfo | null }) {
  if (!info) return <div className="skeleton" style={{ height: 120 }} />;
  return (
    <>
      <p>{t('setup.add.intro')}</p>
      <div className="setup-fields">
        <CopyField label={t('setup.add.nameLabel')} value="Omnix" />
        <CopyField label={t('setup.add.urlLabel')} value={info.mcpUrl} />
      </div>
      {info.local && (
        <Callout tone="warn" title={t('setup.add.localTitle')}>
          <p>{t('setup.add.localBody', { url: info.publicUrl })}</p>
          <p>{t('setup.add.localFix')}</p>
          <Link to="/help/troubleshooting#local-address">{t('setup.add.howTo')}</Link>
        </Callout>
      )}
      {!info.local && !info.https && (
        <Callout tone="danger" title={t('setup.add.httpsTitle')}>
          <p>{t('setup.add.httpsBody', { url: info.publicUrl })}</p>
          <Link to="/help/troubleshooting#https">{t('setup.add.howTo')}</Link>
        </Callout>
      )}
      <p className="muted">{t('setup.add.advanced')}</p>
      <p>{t('setup.add.confirm')}</p>
    </>
  );
}

function OAuthStep() {
  const perms: { icon: ReactNode; title: MessageKey; body: MessageKey }[] = [
    { icon: <FolderOpen />, title: 'setup.oauth.readTitle', body: 'setup.oauth.readBody' },
    { icon: <Sparkles />, title: 'setup.oauth.editTitle', body: 'setup.oauth.editBody' },
    { icon: <Play />, title: 'setup.oauth.autoTitle', body: 'setup.oauth.autoBody' },
    { icon: <ShieldCheck />, title: 'setup.oauth.projectsTitle', body: 'setup.oauth.projectsBody' },
  ];
  return (
    <>
      <p>{t('setup.oauth.intro')}</p>
      <p>{t('setup.oauth.signIn')}</p>
      <ul className="perm-list">
        {perms.map((p) => (
          <li key={p.title}>
            <span className="perm-icon" aria-hidden="true">
              {p.icon}
            </span>
            <div>
              <strong>{t(p.title)}</strong>
              <p>{t(p.body)}</p>
            </div>
          </li>
        ))}
      </ul>
      <p>{t('setup.oauth.limit')}</p>
      <p className="muted">{t('setup.oauth.after')}</p>
    </>
  );
}

function ScopeStep({ preset, onChange }: { preset: Mode; onChange: (m: Mode) => void }) {
  return (
    <>
      <p>{t('setup.scope.intro')}</p>
      <PresetPicker value={preset} onChange={onChange} label={t('setup.steps.scope')} />
      <Callout tone="info">{t('setup.scope.consent')}</Callout>
    </>
  );
}

const STATUS_ICON = { pass: CheckCircle2, warn: AlertTriangle, fail: XCircle, skip: CircleSlash } as const;

function TestStep({ preset, onPassed }: { preset: Mode; onPassed: () => void }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; checks: SelfCheck[]; testProjectId: string | null } | null>(null);
  const status = useClaudeStatus(5000);
  const lastCall = status?.connections
    .filter((c) => c.lastUsedAt && c.name !== 'Omnix connection test')
    .sort((a, b) => b.lastUsedAt!.localeCompare(a.lastUsedAt!))[0];
  const run = async () => {
    setRunning(true);
    try {
      const r = await post<{ ok: boolean; checks: SelfCheck[]; testProjectId: string | null }>('/api/claude/self-test', { mode: preset });
      setResult(r);
      if (r.ok) onPassed();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  const summary = result ? (result.checks.some((c) => c.status === 'fail') ? 'fail' : result.checks.some((c) => c.status === 'warn') ? 'warn' : 'pass') : null;
  return (
    <>
      <p>{t('setup.test.intro')}</p>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={() => void run()} disabled={running} aria-describedby="test-mode">
          {running ? <Loader2 className="spin" /> : <Play />} {running ? t('setup.test.running') : result ? t('setup.test.again') : t('setup.test.run')}
        </button>
        <span id="test-mode" className="muted">
          {t('setup.test.as', { mode: t(MODE_LABEL[preset]) })}
        </span>
      </div>
      <div aria-live="polite" aria-busy={running}>
        {result && (
          <>
            <p className={`test-summary ${summary}`}>{summary === 'fail' ? t('setup.test.failed') : summary === 'warn' ? t('setup.test.someNotes') : t('setup.test.allGood')}</p>
            <ol className="check-list">
              {result.checks.map((c) => {
                const Icon = STATUS_ICON[c.status];
                return (
                  <li key={c.id} className={`check ${c.status}`}>
                    <Icon aria-hidden="true" />
                    <div>
                      <div className="check-head">
                        <strong>{c.label}</strong>
                        <span className={`badge ${c.status === 'pass' ? 'success' : c.status === 'fail' ? 'danger' : c.status === 'warn' ? 'warning' : ''}`}>{t(`setup.test.status.${c.status}`)}</span>
                      </div>
                      <p>{c.detail}</p>
                      {c.fix && (
                        <p className="check-fix">
                          <strong>{t('setup.test.fix')}:</strong> {c.fix}
                          {c.help && (
                            <>
                              {' '}
                              <Link to={`/help/troubleshooting#${c.help}`}>{t('setup.test.more')}</Link>
                            </>
                          )}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
            {result.testProjectId && (
              <Link className="btn btn-sm" style={{ alignSelf: 'flex-start', marginTop: 4 }} to={`/projects/${result.testProjectId}`}>
                <FolderOpen /> {t('setup.test.openTestProject')}
              </Link>
            )}
          </>
        )}
      </div>
      <section className="ask-claude" aria-labelledby="ask-claude-title">
        <h3 id="ask-claude-title">{t('setup.test.askTitle')}</h3>
        <p>{t('setup.test.askBody')}</p>
        <CopyField label={t('setup.test.promptLabel')} value={t('setup.test.prompt')} />
        <p className="ask-status" aria-live="polite">
          {lastCall ? (
            <>
              <CheckCircle2 className="ok" aria-hidden="true" /> {t('setup.test.arrived', { name: lastCall.name, when: formatRelative(lastCall.lastUsedAt!) })}
            </>
          ) : (
            <>
              <Loader2 className="spin" aria-hidden="true" /> {t('setup.test.waiting')}
            </>
          )}
        </p>
        {!lastCall && <p className="muted">{t('setup.test.notYet')}</p>}
      </section>
    </>
  );
}

function FirstProjectStep({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const [allowAi, setAllowAi] = useState(true);
  const [creating, setCreating] = useState(false);
  const openSample = async () => {
    setCreating(true);
    try {
      const r = await post<{ project: { id: string } }>('/api/projects', { name: 'Sample: Launch kit', primaryTool: 'slides', templateId: 'builtin-launch-kit', aiConsent: allowAi });
      onDone();
      navigate(`/projects/${r.project.id}`);
    } catch (e) {
      toast.error((e as Error).message);
      setCreating(false);
    }
  };
  return (
    <>
      <p>{t('setup.first.intro')}</p>
      <div className="first-grid">
        <section className="first-card" aria-labelledby="sample-title">
          <h3 id="sample-title">{t('setup.first.sampleTitle')}</h3>
          <p>{t('setup.first.sampleBody')}</p>
          <label className="check-label">
            <input type="checkbox" checked={allowAi} onChange={(e) => setAllowAi(e.target.checked)} /> {t('setup.first.allowAi')}
          </label>
          <button className="btn btn-primary" onClick={() => void openSample()} disabled={creating}>
            {creating ? <Loader2 className="spin" /> : <Sparkles />} {creating ? t('setup.first.creating') : t('setup.first.openSample')}
          </button>
        </section>
        <section className="first-card" aria-labelledby="blank-title">
          <h3 id="blank-title">{t('setup.first.blankTitle')}</h3>
          <p>{t('setup.first.blankBody')}</p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn"
              onClick={() => {
                onDone();
                navigate('/');
              }}
            >
              {t('setup.first.toDashboard')}
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                onDone();
                navigate('/?tour=1');
              }}
            >
              <Globe /> {t('setup.first.tour')}
            </button>
          </div>
        </section>
      </div>
      <h3>{t('setup.first.tryTitle')}</h3>
      <ul className="try-list">
        {(['setup.first.try1', 'setup.first.try2', 'setup.first.try3'] as const).map((k) => (
          <li key={k}>“{t(k)}”</li>
        ))}
      </ul>
    </>
  );
}

/* ---------------------------------------------------------------- */
/* Guide                                                             */
/* ---------------------------------------------------------------- */

/**
 * The Claude setup guide: seven steps from account to first project. Each step shows where
 * you are, lets you go back, and saves progress to your account so it resumes anywhere.
 */
export function SetupGuide() {
  const user = useAuth((s) => s.user)!;
  const updateSetup = useAuth((s) => s.updateSetup);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const asked = params.get('step') as SetupStep | null;
  const saved = (SETUP_STEPS as readonly string[]).includes(user.setup.current) ? (user.setup.current as SetupStep) : 'open-connectors';
  const [step, setStep] = useState<SetupStep>(asked && SETUP_STEPS.includes(asked) ? asked : saved);
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [preset, setPreset] = useState<Mode>(user.setup.preset ?? 'approve');
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  const completed = new Set(user.setup.completed);
  const index = SETUP_STEPS.indexOf(step);

  useEffect(() => {
    get<SetupInfo>('/api/claude/setup-info').then(setInfo, () => {});
  }, []);

  useEffect(() => {
    // Move focus to the new step's heading (not on first load) so keyboard and screen reader users follow along.
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  const save = (patch: Parameters<typeof updateSetup>[0]) => void updateSetup(patch).catch((e: Error) => toast.error(e.message));

  const go = (s: SetupStep) => {
    setStep(s);
    setParams({ step: s }, { replace: true });
    save({ current: s });
  };

  const complete = (s: SetupStep, advance = true) => {
    const done = SETUP_STEPS.filter((x) => completed.has(x) || x === s);
    const next = SETUP_STEPS[SETUP_STEPS.indexOf(s) + 1];
    save({ completed: done, current: advance && next ? next : s });
    if (advance && next) {
      setStep(next);
      setParams({ step: next }, { replace: true });
    }
  };

  const allDone = SETUP_STEPS.every((s) => completed.has(s));

  return (
    <div className="page setup-page">
      <header className="page-header setup-header">
        <div className="grow">
          <h1>{t('setup.title')}</h1>
          <p className="subtitle">{t('setup.intro')}</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn btn-ghost"
            onClick={() => {
              save({ dismissed: true });
              navigate('/');
            }}
          >
            {t('setup.later')}
          </button>
        </div>
      </header>
      <div className="setup-progress" role="progressbar" aria-label={t('setup.progressLabel')} aria-valuemin={0} aria-valuemax={SETUP_STEPS.length} aria-valuenow={completed.size} aria-valuetext={`${completed.size} / ${SETUP_STEPS.length}`}>
        <span style={{ width: `${(completed.size / SETUP_STEPS.length) * 100}%` }} />
      </div>
      <div className="setup-body">
        <nav aria-label={t('setup.progressLabel')}>
          <ol className="setup-steps">
            {SETUP_STEPS.map((s, i) => {
              const done = completed.has(s);
              return (
                <li key={s}>
                  <button className={`setup-step${s === step ? ' current' : ''}${done ? ' done' : ''}`} aria-current={s === step ? 'step' : undefined} aria-label={done ? `${t(STEP_TITLE[s])} (${t('setup.completed')})` : undefined} onClick={() => go(s)}>
                    <span className="setup-step-num" aria-hidden="true">
                      {done ? <Check /> : i + 1}
                    </span>
                    <span className="setup-step-label">{t(STEP_TITLE[s])}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        <section className="card setup-panel" aria-labelledby="setup-step-title">
          <p className="setup-count">{t('setup.stepOf', { n: index + 1, total: SETUP_STEPS.length })}</p>
          <h2 id="setup-step-title" ref={heading} tabIndex={-1}>
            {t(STEP_TITLE[step])}
          </h2>
          <div className="setup-content">
            {step === 'account' && <AccountStep info={info} />}
            {step === 'open-connectors' && <OpenStep info={info} />}
            {step === 'add-connector' && <AddStep info={info} />}
            {step === 'oauth' && <OAuthStep />}
            {step === 'scope' && (
              <ScopeStep
                preset={preset}
                onChange={(m) => {
                  setPreset(m);
                  save({ preset: m });
                }}
              />
            )}
            {step === 'test' && <TestStep preset={preset} onPassed={() => complete('test', false)} />}
            {step === 'first-project' && <FirstProjectStep onDone={() => complete('first-project', false)} />}
          </div>
          <footer className="setup-footer">
            <button className="btn btn-ghost" onClick={() => go(SETUP_STEPS[index - 1]!)} disabled={index === 0}>
              <ChevronLeft /> {t('setup.back')}
            </button>
            <span className="grow" />
            {step !== 'first-project' ? (
              <button className="btn btn-primary" onClick={() => complete(step)}>
                {t('setup.continue')} <ChevronRight />
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={() => {
                  complete('first-project', false);
                  toast.success(t('setup.first.finished'));
                  navigate('/');
                }}
              >
                <Check /> {allDone ? t('setup.done') : t('setup.finish')}
              </button>
            )}
          </footer>
        </section>
      </div>
      <p className="muted setup-shortcut">
        <Link to="/help/troubleshooting">{t('troubleshoot.title')}</Link> · {t('tour.searchBody', { shortcut: formatShortcut('mod+k') })}
      </p>
    </div>
  );
}
