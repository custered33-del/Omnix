import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Wand2 } from 'lucide-react';
import { useCommandStore, type Command } from '../state/commands.js';
import { formatShortcut } from '../ui/shortcuts.js';
import { t } from '../i18n/index.js';

/** Fuzzy-ish match: every query word must appear in label, section or keywords. */
function score(c: Command, q: string): number {
  if (!q) return 1;
  const hay = `${c.label} ${c.section} ${c.keywords ?? ''}`.toLowerCase();
  let s = 0;
  for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    const i = hay.indexOf(w);
    if (i < 0) return 0;
    s += i === 0 ? 3 : c.label.toLowerCase().startsWith(w) ? 2 : 1;
  }
  return s;
}

export function CommandPalette() {
  const open = useCommandStore((s) => s.paletteOpen);
  const setOpen = useCommandStore((s) => s.openPalette);
  const scopes = useCommandStore((s) => s.scopes);
  const freeText = useCommandStore((s) => s.freeText);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => {
    const all = Object.values(scopes).flat();
    const found = all
      .map((c) => ({ c, s: score(c, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map((x) => x.c);
    // Words that are not a command can be a request ("make the title bigger"): offer to run it.
    const text = q.trim();
    if (freeText && text.split(/\s+/).length >= 2) {
      const ask: Command = { id: 'free-text', label: freeText.label(text), section: t('palette.askSection'), icon: <Wand2 size={16} className="ai-ink" />, run: () => freeText.run(text) };
      return found.length ? [...found, ask] : [ask];
    }
    return found;
  }, [scopes, q, freeText]);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;
  const run = (c: Command | undefined) => {
    if (!c) return;
    setOpen(false);
    c.run();
  };
  let lastSection = '';
  return createPortal(
    <div className="dialog-backdrop" style={{ alignItems: 'flex-start', paddingTop: '12vh' }} onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={t('nav.commandPalette')} style={{ width: 'min(620px, 100%)' }}>
        <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <Search size={18} className="muted" aria-hidden="true" />
          <input
            ref={inputRef}
            autoFocus
            className="grow"
            style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 'var(--fs-lg)' }}
            placeholder={t('palette.placeholder')}
            value={q}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[active] ? `cmd-${results[active]!.id}` : undefined}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(results.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(results[active]);
              } else if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
          />
        </div>
        <div ref={listRef} id="palette-list" role="listbox" style={{ maxHeight: '50vh', overflow: 'auto', padding: 6 }}>
          {results.length === 0 && <div className="empty">{t('palette.empty')}</div>}
          {results.map((c, i) => {
            const header = !q && c.section !== lastSection ? c.section : null;
            lastSection = c.section;
            return (
              <div key={c.id}>
                {header && <div className="menu-label">{header}</div>}
                <div id={`cmd-${c.id}`} role="option" aria-selected={i === active} data-index={i} className="menu-item" data-active={i === active} onMouseEnter={() => setActive(i)} onClick={() => run(c)}>
                  {c.icon}
                  <span className="grow">{c.label}</span>
                  {q && <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>{c.section}</span>}
                  {c.shortcut && <span className="shortcut">{formatShortcut(c.shortcut)}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
