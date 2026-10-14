import { en, type Messages } from './en.js';

/**
 * Localization: every user-facing string goes through `t()`. Messages are nested by area;
 * `{name}` placeholders are filled from `vars`. Add a locale by providing another `Messages`
 * object with the same keys and registering it below.
 */
const catalogs: Record<string, Messages> = { en };
let current: Messages = en;
let currentLocale = 'en';

export function setLocale(locale: string): void {
  const base = locale.split('-')[0]!;
  currentLocale = catalogs[locale] ? locale : catalogs[base] ? base : 'en';
  current = catalogs[currentLocale]!;
  document.documentElement.lang = currentLocale;
}

export function locale(): string {
  return currentLocale;
}

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type MessageKey = Leaves<Messages>;

function lookup(obj: unknown, path: string): string | undefined {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return typeof cur === 'string' ? cur : undefined;
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const raw = lookup(current, key) ?? lookup(en, key) ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}

/** Pluralize with an `_one`/`_other` pair: t.plural('dashboard.projectCount', n). */
export function plural(key: string, n: number, vars: Record<string, string | number> = {}): string {
  const form = new Intl.PluralRules(currentLocale).select(n);
  const k = `${key}_${form === 'one' ? 'one' : 'other'}`;
  return t(k as MessageKey, { count: n, ...vars });
}

export function formatRelative(iso: string | number): string {
  const d = typeof iso === 'number' ? iso : new Date(iso).getTime();
  const diff = (d - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(currentLocale, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 45) return t('time.justNow');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
  return new Intl.DateTimeFormat(currentLocale, { month: 'short', day: 'numeric', year: abs > 86400 * 300 ? 'numeric' : undefined }).format(d);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${new Intl.NumberFormat(currentLocale, { maximumFractionDigits: v < 10 ? 1 : 0 }).format(v)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}

export function formatTimecode(seconds: number, fps: number): string {
  const total = Math.max(0, Math.round(seconds * fps));
  const f = total % Math.round(fps);
  const s = Math.floor(total / Math.round(fps));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${hh ? pad(hh) + ':' : ''}${pad(mm)}:${pad(ss)}:${pad(f)}`;
}
