import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t, type MessageKey } from '../i18n/index.js';
import { formatShortcut } from '../ui/shortcuts.js';

export interface TourStep {
  /** CSS selector of the element to point at. Steps whose element is missing are skipped. */
  target: string;
  title: MessageKey;
  body: MessageKey;
}

export const DASHBOARD_TOUR: TourStep[] = [
  { target: '.create-row', title: 'tour.createTitle', body: 'tour.createBody' },
  { target: 'section[aria-labelledby="recent-title"]', title: 'tour.recentTitle', body: 'tour.recentBody' },
  { target: '.status-card', title: 'tour.claudeTitle', body: 'tour.claudeBody' },
  { target: 'section[aria-labelledby="activity-title"]', title: 'tour.activityTitle', body: 'tour.activityBody' },
  { target: '.topbar .palette-btn', title: 'tour.searchTitle', body: 'tour.searchBody' },
  // The Help menu is the first menu button in the top bar (the account menu follows it).
  { target: '.topbar button[aria-haspopup="menu"]', title: 'tour.helpTitle', body: 'tour.helpBody' },
];

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A short guided tour: a ring around one part of the page and a card explaining it.
 * Arrow keys move between steps, Escape ends the tour, and focus stays on the card.
 */
export function Tour({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const available = steps.filter((s) => document.querySelector(s.target));
  const [i, setI] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [pop, setPop] = useState<{ left: number; top: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const step = available[i];

  const measure = useCallback(() => {
    if (!step) return;
    const el = document.querySelector(step.target);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 6;
    const b = { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 };
    setBox(b);
    const cw = card.current?.offsetWidth ?? 340;
    const ch = card.current?.offsetHeight ?? 180;
    const below = b.y + b.h + 12;
    const top = below + ch < window.innerHeight - 8 ? below : Math.max(8, b.y - ch - 12);
    const left = Math.min(Math.max(8, b.x), window.innerWidth - cw - 8);
    setPop({ left, top: top + ch > window.innerHeight ? Math.max(8, window.innerHeight - ch - 8) : top });
  }, [step]);

  useLayoutEffect(() => {
    if (!step) return;
    const el = document.querySelector(step.target);
    el?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    measure();
    heading.current?.focus();
  }, [step, measure]);

  useEffect(() => {
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [measure]);

  useEffect(() => {
    if (!available.length) onClose();
  }, [available.length, onClose]);

  if (!step) return null;
  const last = i === available.length - 1;
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowRight' && !last) setI(i + 1);
    else if (e.key === 'ArrowLeft' && i > 0) setI(i - 1);
    else if (e.key === 'Tab') {
      // Keep focus inside the card.
      const items = card.current?.querySelectorAll<HTMLElement>('button, [tabindex="-1"]');
      if (!items?.length) return;
      const list = Array.from(items);
      const idx = list.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (idx <= 0 ? list.length - 1 : idx - 1) : idx === list.length - 1 ? 0 : idx + 1;
      e.preventDefault();
      list[next]!.focus();
    }
  };

  return (
    <>
      {box && <div className="tour-ring" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} aria-hidden="true" />}
      <div ref={card} className="tour-pop" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body" style={pop ? { left: pop.left, top: pop.top } : { left: -9999, top: 0 }} onKeyDown={onKey}>
        <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
          {t('tour.label')} · {t('tour.stepOf', { n: i + 1, total: available.length })}
        </span>
        <h2 id="tour-title" ref={heading} tabIndex={-1}>
          {t(step.title)}
        </h2>
        <p id="tour-body">{t(step.body, { shortcut: formatShortcut('mod+k') })}</p>
        <footer>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            {t('tour.skip')}
          </button>
          <span className="grow" />
          {i > 0 && (
            <button className="btn btn-sm" onClick={() => setI(i - 1)}>
              {t('tour.back')}
            </button>
          )}
          <button className="btn btn-primary btn-sm" onClick={() => (last ? onClose() : setI(i + 1))}>
            {last ? t('tour.done') : t('tour.next')}
          </button>
        </footer>
      </div>
    </>
  );
}
