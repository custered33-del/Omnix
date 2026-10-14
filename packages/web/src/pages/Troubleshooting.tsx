import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, Play } from 'lucide-react';
import { t, type MessageKey } from '../i18n/index.js';
import '../styles/setup.css';

type ItemKey = 'localAddress' | 'https' | 'unreachable' | 'wrongUrl' | 'mcp' | 'noConnection' | 'noCalls' | 'expired' | 'expiredWindow' | 'aiOff' | 'viewOnly' | 'missingProject' | 'proposals' | 'disconnect' | 'afterDisconnect' | 'oneProject' | 'testProject';

/** Anchors match the `help` ids the connection test links to. */
const SECTIONS: { id: string; title: MessageKey; items: { anchor: string; key: ItemKey }[] }[] = [
  {
    id: 'connection',
    title: 'troubleshoot.sections.connection',
    items: [
      { anchor: 'local-address', key: 'localAddress' },
      { anchor: 'https', key: 'https' },
      { anchor: 'unreachable', key: 'unreachable' },
      { anchor: 'wrong-url', key: 'wrongUrl' },
      { anchor: 'mcp', key: 'mcp' },
      { anchor: 'no-connection', key: 'noConnection' },
      { anchor: 'no-calls', key: 'noCalls' },
    ],
  },
  {
    id: 'expired',
    title: 'troubleshoot.sections.expired',
    items: [
      { anchor: 'expired', key: 'expired' },
      { anchor: 'expired-window', key: 'expiredWindow' },
    ],
  },
  {
    id: 'permissions',
    title: 'troubleshoot.sections.permissions',
    items: [
      { anchor: 'permissions', key: 'aiOff' },
      { anchor: 'view-only', key: 'viewOnly' },
      { anchor: 'missing-project', key: 'missingProject' },
      { anchor: 'proposals', key: 'proposals' },
    ],
  },
  {
    id: 'disconnect',
    title: 'troubleshoot.sections.disconnect',
    items: [
      { anchor: 'disconnect', key: 'disconnect' },
      { anchor: 'after-disconnect', key: 'afterDisconnect' },
      { anchor: 'one-project', key: 'oneProject' },
      { anchor: 'test-project', key: 'testProject' },
    ],
  },
];

const text = (key: ItemKey, part: 'title' | 'why' | 'fix') => t(`troubleshoot.items.${key}.${part}` as MessageKey);

/**
 * Help for connecting Claude: connection errors, expired sign-ins, permission problems and
 * disconnecting. Each entry says what you see, why, and the fix. Links from the connection
 * test open the matching entry.
 */
export function Troubleshooting() {
  const { hash } = useLocation();
  const target = hash.replace('#', '');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set(target ? [target] : []));

  useEffect(() => {
    if (!target) return;
    setOpen((o) => new Set([...o, target]));
    // Wait a frame so the details element is open before scrolling to it.
    requestAnimationFrame(() => {
      const el = document.getElementById(target);
      el?.scrollIntoView({ block: 'start' });
      el?.querySelector('summary')?.focus();
    });
  }, [target]);

  const q = query.trim().toLowerCase();
  const sections = useMemo(
    () =>
      SECTIONS.map((s) => ({
        ...s,
        items: s.items.filter((i) => !q || [text(i.key, 'title'), text(i.key, 'why'), text(i.key, 'fix')].some((x) => x.toLowerCase().includes(q))),
      })).filter((s) => s.items.length),
    [q],
  );

  return (
    <div className="page trouble-page">
      <header className="page-header">
        <div className="grow">
          <h1>{t('troubleshoot.title')}</h1>
          <p className="subtitle">{t('troubleshoot.intro')}</p>
        </div>
      </header>
      <div className="trouble-tools">
        <input className="input" type="search" placeholder={t('troubleshoot.filter')} aria-label={t('troubleshoot.filter')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <Link className="btn btn-primary" to="/setup?step=test">
          <Play /> {t('troubleshoot.runTest')}
        </Link>
      </div>
      {sections.length === 0 && <p className="muted">{t('troubleshoot.noMatch')}</p>}
      {sections.map((s) => (
        <section key={s.id} className="trouble-section" aria-labelledby={`sec-${s.id}`}>
          <h2 id={`sec-${s.id}`}>{t(s.title)}</h2>
          {s.items.map((i) => (
            <details
              key={i.anchor}
              id={i.anchor}
              className={`trouble-item${target === i.anchor ? ' highlight' : ''}`}
              open={open.has(i.anchor) || !!q}
              onToggle={(e) => {
                const isOpen = (e.currentTarget as HTMLDetailsElement).open;
                setOpen((o) => {
                  const n = new Set(o);
                  if (isOpen) n.add(i.anchor);
                  else n.delete(i.anchor);
                  return n;
                });
              }}
            >
              <summary>
                <ChevronRight aria-hidden="true" />
                {text(i.key, 'title')}
              </summary>
              <dl className="trouble-body">
                <dt>{t('troubleshoot.why')}</dt>
                <dd>{text(i.key, 'why')}</dd>
                <dt>{t('troubleshoot.fix')}</dt>
                <dd>{text(i.key, 'fix')}</dd>
              </dl>
            </details>
          ))}
        </section>
      ))}
      <section className="card" style={{ padding: 20 }} aria-labelledby="still-stuck">
        <h2 id="still-stuck" style={{ fontSize: 'var(--fs-lg)' }}>
          {t('troubleshoot.stillStuck')}
        </h2>
        <p className="text-2">{t('troubleshoot.stillStuckBody')}</p>
        <Link className="btn btn-sm" to="/setup?step=test">
          <Play /> {t('troubleshoot.runTest')}
        </Link>
      </section>
    </div>
  );
}
