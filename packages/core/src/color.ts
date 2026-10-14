export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#00a000',
  blue: '#0000ff',
  yellow: '#ffff00',
  orange: '#ff8800',
  purple: '#800080',
  pink: '#ff69b4',
  gray: '#808080',
  grey: '#808080',
  transparent: '#00000000',
  teal: '#008080',
  navy: '#000080',
  gold: '#ffd700',
};

/** Parse #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() or a few named colors. Channels 0..255, alpha 0..1. */
export function parseColor(input: string): RGBA {
  const s = input.trim().toLowerCase();
  if (NAMED[s]) return parseColor(NAMED[s]!);
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(h)) throw new Error(`Invalid color: ${input}`);
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: clamp255(+m[1]!), g: clamp255(+m[2]!), b: clamp255(+m[3]!), a: Math.max(0, Math.min(1, a)) };
  }
  throw new Error(`Invalid color: ${input}`);
}

export function isColor(input: unknown): boolean {
  if (typeof input !== 'string') return false;
  try {
    parseColor(input);
    return true;
  } catch {
    return false;
  }
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

const hex2 = (n: number) => clamp255(n).toString(16).padStart(2, '0');

export function toHex({ r, g, b, a }: RGBA): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ''}`;
}

/** Normalize any accepted color string to #rrggbb or #rrggbbaa. */
export function normalizeColor(input: string): string {
  return toHex(parseColor(input));
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const conv = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [Math.round(conv(hh + 1 / 3) * 255), Math.round(conv(hh) * 255), Math.round(conv(hh - 1 / 3) * 255)];
}

/** Relative luminance (WCAG). */
export function luminance({ r, g, b }: RGBA): number {
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** WCAG contrast ratio between two colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(parseColor(a));
  const lb = luminance(parseColor(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Linear blend between two colors. */
export function mixColors(a: string, b: string, t: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  return toHex({
    r: ca.r + (cb.r - ca.r) * t,
    g: ca.g + (cb.g - ca.g) * t,
    b: ca.b + (cb.b - ca.b) * t,
    a: ca.a + (cb.a - ca.a) * t,
  });
}
