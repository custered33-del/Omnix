import { normalizeColor, parseColor, rgbToHsl, hslToRgb, toHex } from '@omnix/core';

/** Words the command parser understands: colors, tones, positions, ordinals and amounts. */

export const COLOR_WORDS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  'off-white': '#f5f3ee',
  cream: '#f3ead3',
  ivory: '#fffff0',
  beige: '#e8dcc4',
  red: '#e03131',
  crimson: '#b0122c',
  maroon: '#7a1f2b',
  coral: '#ff7f50',
  salmon: '#fa8072',
  orange: '#f08c00',
  amber: '#ffbf00',
  yellow: '#ffd43b',
  gold: '#d4a017',
  lime: '#82c91e',
  green: '#2f9e44',
  olive: '#6b7b2b',
  mint: '#96f2d7',
  teal: '#0c8599',
  turquoise: '#22b8cf',
  cyan: '#15aabf',
  sky: '#74c0fc',
  'sky blue': '#74c0fc',
  'light blue': '#a5d8ff',
  blue: '#1c7ed6',
  'dark blue': '#1d3557',
  navy: '#1b2a4a',
  indigo: '#4c3fbf',
  violet: '#7048e8',
  purple: '#862e9c',
  lavender: '#c5b3f6',
  magenta: '#d6336c',
  pink: '#f783ac',
  'hot pink': '#ff3f8e',
  rose: '#e64980',
  brown: '#8b5a2b',
  tan: '#d2b48c',
  gray: '#868e96',
  grey: '#868e96',
  'light gray': '#dee2e6',
  'light grey': '#dee2e6',
  'dark gray': '#343a40',
  'dark grey': '#343a40',
  charcoal: '#2b2f36',
  silver: '#c0c0c0',
};

const COLOR_RE = new RegExp(`^(?:#[0-9a-f]{3,8}|${Object.keys(COLOR_WORDS).sort((a, b) => b.length - a.length).map((w) => w.replace(/[-\s]/g, '[-\\s]')).join('|')})$`, 'i');

/** A color from a word or hex code, or null. */
export function colorFrom(word: string): string | null {
  const w = word.trim().toLowerCase().replace(/^the\s+/, '').replace(/\s+(?:color|colour)$/, '');
  if (!COLOR_RE.test(w)) return null;
  const named = COLOR_WORDS[w.replace(/\s+/g, ' ')] ?? COLOR_WORDS[w.replace(/-/g, ' ')];
  try {
    return normalizeColor(named ?? w);
  } catch {
    return null;
  }
}

export type Tone = 'warmer' | 'cooler' | 'brighter' | 'darker' | 'more-saturated' | 'less-saturated' | 'grayscale' | 'sepia' | 'more-contrast' | 'less-contrast' | 'moodier';

const TONE_PATTERNS: [RegExp, Tone][] = [
  [/^(?:warmer|warm|warm(?:ed)? up|sunnier|golden)$/, 'warmer'],
  [/^(?:cooler|cool|colder|cold|bluer)$/, 'cooler'],
  [/^(?:brighter|bright|lighter|light(?:er)?|brightened)$/, 'brighter'],
  [/^(?:darker|dark|dimmer|darkened)$/, 'darker'],
  [/^(?:more (?:saturated|vivid|colou?rful|vibrant)|(?:saturated|vivid|colou?rful|vibrant|punchier|richer))$/, 'more-saturated'],
  [/^(?:less (?:saturated|vivid|colou?rful|vibrant)|(?:muted|desaturated|washed out|faded|duller|more muted))$/, 'less-saturated'],
  [/^(?:black (?:and|&) white|b&w|grayscale|greyscale|monochrome|gr[ae]y)$/, 'grayscale'],
  [/^(?:sepia|vintage|old[- ]fashioned)$/, 'sepia'],
  [/^(?:(?:higher|more) contrast|contrasty|crisper)$/, 'more-contrast'],
  [/^(?:(?:lower|less) contrast|flatter|softer)$/, 'less-contrast'],
  [/^(?:moodier|moody|more dramatic|dramatic|cinematic)$/, 'moodier'],
];

/** Parse "a bit warmer", "much darker", "black and white" into a tone and a strength multiplier. */
export function toneFrom(phrase: string): { tone: Tone; strength: number } | null {
  let p = phrase.trim().toLowerCase().replace(/^look\s+/, '');
  let strength = 1;
  const mod = /^(a (?:little|tiny) (?:bit )?|a bit |slightly |somewhat |subtly |much |a lot |way |far |even |really |very |a little )/.exec(p);
  if (mod) {
    const m = mod[1]!;
    strength = /little|tiny|bit|slightly|somewhat|subtly/.test(m) ? 0.5 : /even/.test(m) ? 1 : 2;
    p = p.slice(m.length);
  }
  for (const [re, tone] of TONE_PATTERNS) if (re.test(p)) return { tone, strength };
  return null;
}

/** Shift a single color the way a tone command would shift an image. */
export function shiftColor(hex: string, tone: Tone, strength = 1): string {
  const c = parseColor(hex);
  let [h, s, l] = rgbToHsl(c.r, c.g, c.b);
  const k = 0.12 * strength;
  switch (tone) {
    case 'warmer':
    case 'cooler': {
      const target = tone === 'warmer' ? 30 : 215;
      const d = ((target - h + 540) % 360) - 180;
      h = (h + d * Math.min(1, 0.35 * strength) + 360) % 360;
      if (s < 0.15) s = Math.min(1, s + 0.12 * strength);
      break;
    }
    case 'brighter':
      l = Math.min(1, l + k);
      break;
    case 'darker':
      l = Math.max(0, l - k);
      break;
    case 'more-saturated':
      s = Math.min(1, s + 0.2 * strength);
      break;
    case 'less-saturated':
      s = Math.max(0, s - 0.25 * strength);
      break;
    case 'grayscale':
      s = 0;
      break;
    case 'sepia':
      h = 35;
      s = 0.35;
      break;
    case 'more-contrast':
      l = l > 0.5 ? Math.min(1, l + k) : Math.max(0, l - k);
      break;
    case 'less-contrast':
      l = l + (0.5 - l) * 0.25 * strength;
      break;
    case 'moodier':
      l = Math.max(0, l - k * 0.6);
      s = Math.max(0, s - 0.1 * strength);
      break;
  }
  const [r, g, b] = hslToRgb(h, s, l);
  return toHex({ r, g, b, a: c.a });
}

export type Position = 'lower-third' | 'upper-third' | 'top' | 'bottom' | 'left' | 'right' | 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'middle-third';

export function positionFrom(phrase: string): Position | null {
  const p = phrase
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/\s+(?:of|on|in)\s+the\s+(?:frame|canvas|slide|image|screen|video|page|picture|shot)$/, '')
    .replace(/\s+(?:corner|edge|side)$/, '')
    .replace(/\s+/g, ' ');
  if (/^(?:lower|bottom) third$/.test(p)) return 'lower-third';
  if (/^(?:upper|top) third$/.test(p)) return 'upper-third';
  if (/^middle third$/.test(p)) return 'middle-third';
  if (/^(?:center|centre|middle)$/.test(p)) return 'center';
  if (/^top[- ]?left$|^upper[- ]left$/.test(p)) return 'top-left';
  if (/^top[- ]?right$|^upper[- ]right$/.test(p)) return 'top-right';
  if (/^bottom[- ]?left$|^lower[- ]left$/.test(p)) return 'bottom-left';
  if (/^bottom[- ]?right$|^lower[- ]right$/.test(p)) return 'bottom-right';
  if (/^top$/.test(p)) return 'top';
  if (/^bottom$/.test(p)) return 'bottom';
  if (/^left$/.test(p)) return 'left';
  if (/^right$/.test(p)) return 'right';
  return null;
}

/** Where a box of size w×h goes in a frame of W×H for a position (top-left corner). Keeps the unspecified axis. */
export function placeBox(pos: Position, box: { x: number; y: number; w: number; h: number }, W: number, H: number, margin = 0.05): { x: number; y: number } {
  const mx = W * margin;
  const my = H * margin;
  let { x, y } = box;
  const cx = (W - box.w) / 2;
  const cy = (H - box.h) / 2;
  switch (pos) {
    case 'lower-third':
      y = H * (2 / 3) + (H / 3 - box.h) / 2;
      break;
    case 'upper-third':
      y = (H / 3 - box.h) / 2;
      break;
    case 'middle-third':
    case 'center':
      y = cy;
      if (pos === 'center') x = cx;
      break;
    case 'top':
      y = my;
      break;
    case 'bottom':
      y = H - box.h - my;
      break;
    case 'left':
      x = mx;
      break;
    case 'right':
      x = W - box.w - mx;
      break;
    case 'top-left':
      x = mx;
      y = my;
      break;
    case 'top-right':
      x = W - box.w - mx;
      y = my;
      break;
    case 'bottom-left':
      x = mx;
      y = H - box.h - my;
      break;
    case 'bottom-right':
      x = W - box.w - mx;
      y = H - box.h - my;
      break;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5 };
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, half: 0.5, twice: 2, double: 2, triple: 3 };

export function ordinalFrom(word: string): number | 'last' | null {
  const w = word.toLowerCase();
  if (w === 'last' || w === 'final') return 'last';
  if (ORDINALS[w]) return ORDINALS[w]!;
  if (/^\d+$/.test(w)) return Number(w);
  return null;
}

export function numberFrom(word: string): number | null {
  const w = word.toLowerCase().trim();
  if (NUMBER_WORDS[w] !== undefined) return NUMBER_WORDS[w]!;
  const n = Number(w.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Strip quotes from a value ("Spring sale" → Spring sale). */
export function unquote(s: string): string {
  const t = s.trim();
  const m = /^["“'‘](.*)["”'’]$/s.exec(t);
  return m ? m[1]! : t;
}
