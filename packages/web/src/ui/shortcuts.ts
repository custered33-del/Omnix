import { useEffect } from 'react';

/** Platform-aware modifier label. */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl';

export function formatShortcut(s: string): string {
  return s
    .split('+')
    .map((p) => (p === 'mod' ? MOD : p === 'shift' ? '⇧' : p === 'alt' ? (isMac ? '⌥' : 'Alt') : p.length === 1 ? p.toUpperCase() : p))
    .join(isMac ? '' : '+');
}

/** True when the event target is a text field (shortcuts must not hijack typing). */
export function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || !!el.closest('.cm-editor');
}

/** Match "mod+shift+z" style shortcuts. */
export function matches(e: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.toLowerCase().split('+');
  const key = parts[parts.length - 1]!;
  const mod = parts.includes('mod');
  const shift = parts.includes('shift');
  const alt = parts.includes('alt');
  const k = e.key.toLowerCase();
  const keyOk = k === key || (key === 'space' && k === ' ') || (key === 'esc' && k === 'escape') || (key === 'del' && (k === 'delete' || k === 'backspace'));
  return keyOk && mod === (isMac ? e.metaKey : e.ctrlKey) && shift === e.shiftKey && alt === e.altKey;
}

/**
 * Register keyboard shortcuts while the component is mounted. Handlers return false to let
 * the event continue. `allowInInputs` marks shortcuts that work while typing (e.g. mod+s).
 */
export function useShortcuts(map: Record<string, (e: KeyboardEvent) => void | boolean>, deps: unknown[], options: { allowInInputs?: string[] } = {}): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      for (const [sc, fn] of Object.entries(map)) {
        if (!matches(e, sc)) continue;
        if (isTyping(e) && !options.allowInInputs?.includes(sc)) continue;
        if (fn(e) !== false) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
