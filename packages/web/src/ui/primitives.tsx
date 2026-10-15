import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { X, CheckCircle2, AlertCircle, Info, Sparkles } from 'lucide-react';
import { useToasts } from './toast.js';
import { t } from '../i18n/index.js';

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open dialogs, innermost last: Escape closes only the top one, wherever focus is. */
const dialogStack: { close: () => void; el: () => HTMLElement | null }[] = [];
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    const top = dialogStack[dialogStack.length - 1];
    if (!top || e.defaultPrevented) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      top.close();
    } else if (e.key === 'Tab' && !top.el()?.contains(document.activeElement)) {
      // Focus fell out of the dialog (its button disappeared, say): bring it back in.
      e.preventDefault();
      top.el()?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }
  });
}

export function Dialog(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; full?: boolean; description?: string; icon?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const close = useRef(props.onClose);
  close.current = props.onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const entry = { close: () => close.current(), el: () => ref.current };
    dialogStack.push(entry);
    return () => {
      dialogStack.splice(dialogStack.indexOf(entry), 1);
      prev?.focus?.();
    };
  }, []);
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      props.onClose();
    }
    if (e.key === 'Tab' && ref.current) {
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div ref={ref} className={`dialog${props.wide ? ' wide' : ''}${props.full ? ' full' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={props.description ? descId : undefined} onKeyDown={onKey}>
        <div className="dialog-header">
          {props.icon}
          <h2 id={titleId}>{props.title}</h2>
          <button className="icon-btn" onClick={props.onClose} aria-label={t('app.close')}>
            <X />
          </button>
        </div>
        <div className="dialog-body">
          {props.description && (
            <p id={descId} className="text-2" style={{ marginBottom: 16 }}>
              {props.description}
            </p>
          )}
          {props.children}
        </div>
        {props.footer && <div className="dialog-footer">{props.footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog(props: { title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={props.title}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            {t('app.cancel')}
          </button>
          <button
            className={`btn ${props.danger ? 'btn-danger' : 'btn-primary'}`}
            data-autofocus
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await props.onConfirm();
                props.onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-2">{props.message}</p>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Menu (anchored, keyboard navigable)                                 */
/* ------------------------------------------------------------------ */

export interface MenuItemDef {
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  heading?: boolean;
}

export function Menu(props: { anchor: HTMLElement | { x: number; y: number }; items: MenuItemDef[]; onClose: () => void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });
  useLayoutEffect(() => {
    const el = ref.current!;
    const a = props.anchor;
    const r = a instanceof HTMLElement ? a.getBoundingClientRect() : { left: a.x, bottom: a.y, top: a.y, right: a.x };
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = r.left;
    let top = r.bottom + 4;
    if (left + w > window.innerWidth - 8) left = Math.max(8, r.right - w);
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    setPos({ left, top });
    el.querySelector<HTMLElement>('.menu-item:not(:disabled)')?.focus();
  }, [props.anchor]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) props.onClose();
    };
    const onScroll = () => props.onClose();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [props.onClose]);
  const onKey = (e: ReactKeyboardEvent) => {
    const items = [...ref.current!.querySelectorAll<HTMLElement>('.menu-item:not(:disabled)')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    } else if (e.key === 'Home') {
      items[0]?.focus();
    } else if (e.key === 'End') {
      items[items.length - 1]?.focus();
    }
  };
  return createPortal(
    <div ref={ref} className="menu" role="menu" aria-label={props.label} style={pos} onKeyDown={onKey}>
      {props.items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : it.heading ? (
          <div key={i} className="menu-label">
            {it.label}
          </div>
        ) : (
          <button
            key={i}
            className={`menu-item${it.danger ? ' danger' : ''}`}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              props.onClose();
              it.onSelect?.();
            }}
          >
            {it.icon}
            <span className="grow truncate">{it.label}</span>
            {it.shortcut && <span className="shortcut">{it.shortcut}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** A button that opens a menu. */
export function MenuButton(props: { label: string; items: MenuItemDef[] | (() => MenuItemDef[]); children: ReactNode; className?: string; title?: string }) {
  const [open, setOpen] = useState<HTMLElement | null>(null);
  return (
    <>
      <button className={props.className ?? 'icon-btn'} aria-haspopup="menu" aria-expanded={!!open} aria-label={props.label} title={props.title ?? props.label} onClick={(e) => setOpen(open ? null : e.currentTarget)}>
        {props.children}
      </button>
      {open && <Menu anchor={open} items={typeof props.items === 'function' ? props.items() : props.items} onClose={() => setOpen(null)} label={props.label} />}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Tooltip                                                             */
/* ------------------------------------------------------------------ */

export function Tooltip(props: { label: string; shortcut?: string; children: (handlers: { onMouseEnter: (e: React.MouseEvent<HTMLElement>) => void; onMouseLeave: () => void; onFocus: (e: React.FocusEvent<HTMLElement>) => void; onBlur: () => void }) => ReactNode }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<number | null>(null);
  const show = (el: HTMLElement) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAnchor(el.getBoundingClientRect()), 450);
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    setAnchor(null);
  };
  useEffect(() => () => hide(), []);
  return (
    <>
      {props.children({ onMouseEnter: (e) => show(e.currentTarget), onMouseLeave: hide, onFocus: (e) => show(e.currentTarget), onBlur: hide })}
      {anchor &&
        createPortal(
          <div className="tooltip" role="tooltip" style={{ left: Math.min(window.innerWidth - 200, Math.max(8, anchor.left + anchor.width / 2 - 40)), top: anchor.bottom + 6 }}>
            {props.label}
            {props.shortcut && <span style={{ opacity: 0.7, marginLeft: 8 }}>{props.shortcut}</span>}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Icon button with tooltip and accessible label. */
export function IconButton(props: { label: string; shortcut?: string; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; children: ReactNode; pressed?: boolean; disabled?: boolean; small?: boolean; className?: string }) {
  return (
    <Tooltip label={props.label} {...(props.shortcut ? { shortcut: props.shortcut } : {})}>
      {(h) => (
        <button
          {...h}
          className={`icon-btn${props.small ? ' sm' : ''}${props.className ? ` ${props.className}` : ''}`}
          aria-label={props.label}
          aria-pressed={props.pressed}
          disabled={props.disabled}
          onClick={props.onClick}
        >
          {props.children}
        </button>
      )}
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

export function Toasts() {
  const items = useToasts((s) => s.items);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((it) => (
        <div key={it.id} className={`toast ${it.kind}`}>
          {it.kind === 'error' ? <AlertCircle /> : it.kind === 'success' ? <CheckCircle2 /> : it.kind === 'ai' ? <Sparkles /> : <Info />}
          <div className="grow">{it.message}</div>
          {it.action && (
            <button
              className="btn btn-sm"
              onClick={() => {
                it.action!.run();
                dismiss(it.id);
              }}
            >
              {it.action.label}
            </button>
          )}
          <button className="icon-btn sm" aria-label={t('app.close')} onClick={() => dismiss(it.id)}>
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Form controls                                                       */
/* ------------------------------------------------------------------ */

export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="track" aria-hidden="true" />
      <span className="col" style={{ gap: 2 }}>
        <span>{props.label}</span>
        {props.hint && <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>{props.hint}</span>}
      </span>
    </label>
  );
}

/**
 * Number control: a slider plus an exact numeric field. Fires `onInput` continuously while
 * dragging (for live preview) and `onCommit` once when the change is final.
 */
export function NumberField(props: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onInput?: (v: number) => void; onCommit: (v: number) => void; slider?: boolean; compact?: boolean }) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const step = props.step ?? 1;
  const fmt = (v: number) => String(Math.round(v / step) * step).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
  const clamp = (v: number) => Math.min(props.max, Math.max(props.min, v));
  return (
    <div className="field" style={props.compact ? { gap: 2 } : undefined}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <label htmlFor={id} className="label">
          {props.label}
        </label>
        <div className="row" style={{ gap: 4 }}>
          <input
            id={id}
            className="input sm num"
            style={{ width: 64 }}
            inputMode="decimal"
            value={draft ?? fmt(props.value)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft !== null) {
                const v = Number(draft);
                if (Number.isFinite(v)) props.onCommit(clamp(v));
                setDraft(null);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setDraft(null);
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                const v = clamp(props.value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
                props.onCommit(v);
              }
            }}
            aria-label={props.label}
          />
          {props.unit && <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>{props.unit}</span>}
        </div>
      </div>
      {props.slider !== false && (
        <input
          type="range"
          className="range"
          min={props.min}
          max={props.max}
          step={step}
          value={props.value}
          aria-label={props.label}
          onChange={(e) => (props.onInput ?? props.onCommit)(Number(e.target.value))}
          onPointerUp={(e) => props.onCommit(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => props.onCommit(Number((e.target as HTMLInputElement).value))}
        />
      )}
    </div>
  );
}

export function ColorField(props: { label: string; value: string | null; onChange: (v: string) => void; onInput?: (v: string) => void; allowNone?: boolean; onClear?: () => void }) {
  const id = useId();
  const hex = (props.value ?? '#000000').slice(0, 7);
  return (
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <label htmlFor={id} className="label">
        {props.label}
      </label>
      <div className="color-input">
        {props.allowNone && props.value === null ? (
          <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
            {t('app.none')}
          </span>
        ) : null}
        <input id={id} type="color" value={hex} onInput={(e) => props.onInput?.((e.target as HTMLInputElement).value)} onChange={(e) => props.onChange(e.target.value)} aria-label={props.label} />
        <input className="input sm mono" style={{ width: 86 }} value={props.value ?? ''} placeholder="#rrggbb" onChange={(e) => /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(e.target.value) && props.onChange(e.target.value)} aria-label={`${props.label} hex`} />
        {props.allowNone && props.value !== null && (
          <button className="icon-btn sm" aria-label={`${t('app.remove')} ${props.label}`} onClick={props.onClear}>
            <X />
          </button>
        )}
      </div>
    </div>
  );
}

export function Select<T extends string>(props: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; hideLabel?: boolean; small?: boolean }) {
  const id = useId();
  return (
    <div className={props.hideLabel ? '' : 'field'}>
      {!props.hideLabel && (
        <label htmlFor={id} className="label">
          {props.label}
        </label>
      )}
      <select id={id} className={`select${props.small ? ' sm' : ''}`} value={props.value} onChange={(e) => props.onChange(e.target.value as T)} aria-label={props.hideLabel ? props.label : undefined}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Spinner(props: { label?: string }) {
  return <span className="spinner" role="progressbar" aria-label={props.label ?? t('app.loading')} />;
}

export function Avatar(props: { name: string; color?: string; ai?: boolean; title?: string }) {
  const initials = props.name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className={`avatar${props.ai ? ' ai' : ''}`} style={props.ai ? undefined : { background: props.color ?? '#5c6070' }} title={props.title ?? props.name} aria-label={props.title ?? props.name}>
      {props.ai ? <Sparkles size={14} /> : initials}
    </span>
  );
}
