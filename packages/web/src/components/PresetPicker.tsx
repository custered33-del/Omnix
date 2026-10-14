import { useRef } from 'react';
import { Check, CircleSlash } from 'lucide-react';
import { t, type MessageKey } from '../i18n/index.js';

export type PermissionMode = 'view' | 'approve' | 'autonomous';

export const MODE_LABEL: Record<PermissionMode, MessageKey> = { view: 'claude.modeView', approve: 'claude.modeApprove', autonomous: 'claude.modeAutonomous' };

const CARDS: { mode: PermissionMode; can: MessageKey; cannot: MessageKey; recommended?: boolean }[] = [
  { mode: 'view', can: 'setup.scope.viewCan', cannot: 'setup.scope.viewCannot' },
  { mode: 'approve', can: 'setup.scope.approveCan', cannot: 'setup.scope.approveCannot', recommended: true },
  { mode: 'autonomous', can: 'setup.scope.autoCan', cannot: 'setup.scope.autoCannot' },
];

/**
 * The three permission presets as a radio group of cards (mouse or arrow keys), each saying
 * what Claude can and cannot do. Used by the setup guide and the connector approval screen.
 */
export function PresetPicker({ value, onChange, label, max = 'autonomous' }: { value: PermissionMode; onChange: (m: PermissionMode) => void; label: string; max?: PermissionMode }) {
  const order: PermissionMode[] = ['view', 'approve', 'autonomous'];
  const cards = CARDS.filter((c) => order.indexOf(c.mode) <= order.indexOf(max));
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = (i + d + cards.length) % cards.length;
    onChange(cards[j]!.mode);
    refs.current[j]?.focus();
  };
  return (
    <div className="preset-grid" role="radiogroup" aria-label={label}>
      {cards.map((c, i) => (
        <button key={c.mode} type="button" ref={(el) => void (refs.current[i] = el)} role="radio" aria-checked={value === c.mode} tabIndex={value === c.mode ? 0 : -1} className="preset-card" onClick={() => onChange(c.mode)} onKeyDown={(e) => onKey(e, i)}>
          <span className="preset-head">
            <strong>{t(MODE_LABEL[c.mode])}</strong>
            {c.recommended && <span className="badge accent">{t('setup.scope.recommended')}</span>}
          </span>
          <span className="preset-row ok">
            <Check aria-hidden="true" />
            <span>
              <span className="sr-only">{t('setup.scope.can')}: </span>
              {t(c.can)}
            </span>
          </span>
          <span className="preset-row no">
            <CircleSlash aria-hidden="true" />
            <span>
              <span className="sr-only">{t('setup.scope.cannot')}: </span>
              {t(c.cannot)}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
