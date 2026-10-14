import { XMLParser } from 'fast-xml-parser';
import { strFromU8, unzipSync } from 'fflate';

/**
 * Minimal Office Open XML reading: a zip of XML parts, relationships between parts, and a
 * small element tree with child lookups. Shared by the PowerPoint importer.
 */

export interface XNode {
  tag: string;
  attrs: Record<string, string>;
  children: XNode[];
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  htmlEntities: false,
});

function toNodes(list: unknown[]): XNode[] {
  const out: XNode[] = [];
  for (const item of list) {
    const rec = item as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (key === ':@' || key === '?xml') continue;
      if (key === '#text') {
        out.push({ tag: '#text', attrs: { value: String(rec[key]) }, children: [] });
        continue;
      }
      out.push({ tag: key, attrs: (rec[':@'] as Record<string, string> | undefined) ?? {}, children: toNodes((rec[key] as unknown[]) ?? []) });
    }
  }
  return out;
}

export function parseXml(xml: string): XNode {
  const nodes = toNodes(parser.parse(xml) as unknown[]);
  return nodes.find((n) => n.tag !== '#text') ?? { tag: '#empty', attrs: {}, children: [] };
}

/** First child with the tag. */
export function kid(n: XNode | null | undefined, tag: string): XNode | null {
  return n?.children.find((c) => c.tag === tag) ?? null;
}

export function kids(n: XNode | null | undefined, tag?: string): XNode[] {
  return n ? n.children.filter((c) => (tag ? c.tag === tag : c.tag !== '#text')) : [];
}

/** Follow a chain of child tags. */
export function at(n: XNode | null | undefined, ...path: string[]): XNode | null {
  let cur: XNode | null = n ?? null;
  for (const t of path) cur = kid(cur, t);
  return cur;
}

/** Depth-first first descendant with the tag. */
export function find(n: XNode | null | undefined, tag: string): XNode | null {
  if (!n) return null;
  for (const c of n.children) {
    if (c.tag === tag) return c;
    const f = find(c, tag);
    if (f) return f;
  }
  return null;
}

export function findAll(n: XNode | null | undefined, tag: string, out: XNode[] = []): XNode[] {
  if (!n) return out;
  for (const c of n.children) {
    if (c.tag === tag) out.push(c);
    findAll(c, tag, out);
  }
  return out;
}

/** Concatenated text of a node's text children. */
export function textOf(n: XNode | null | undefined): string {
  return n ? n.children.map((c) => (c.tag === '#text' ? c.attrs.value : '')).join('') : '';
}

export function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export interface Rel {
  id: string;
  type: string;
  /** Resolved part path inside the package, or the raw URL for external targets. */
  target: string;
  external: boolean;
}

/** An opened OOXML package with cached XML parsing. */
export class OoxmlPackage {
  readonly files: Record<string, Uint8Array>;
  private xmlCache = new Map<string, XNode | null>();
  private relCache = new Map<string, Map<string, Rel>>();

  constructor(data: Uint8Array, limits: { maxEntries?: number; maxBytes?: number } = {}) {
    const maxEntries = limits.maxEntries ?? 20_000;
    const maxBytes = limits.maxBytes ?? 1_500_000_000;
    let entries = 0;
    let total = 0;
    try {
      this.files = unzipSync(data, {
        filter: (f) => {
          entries += 1;
          total += f.originalSize;
          if (entries > maxEntries || total > maxBytes) throw new Error('The file is too large to import');
          return true;
        },
      });
    } catch (e) {
      const msg = (e as Error).message;
      throw new Error(msg.includes('too large') ? msg : 'The file is not a valid Office document (it could not be unzipped)');
    }
  }

  has(path: string): boolean {
    return !!this.files[path];
  }

  bytes(path: string): Uint8Array | null {
    return this.files[path] ?? null;
  }

  xml(path: string): XNode | null {
    if (this.xmlCache.has(path)) return this.xmlCache.get(path)!;
    const data = this.files[path];
    let node: XNode | null = null;
    if (data) {
      try {
        node = parseXml(strFromU8(data));
      } catch {
        node = null;
      }
    }
    this.xmlCache.set(path, node);
    return node;
  }

  /** Relationships of a part, keyed by id. */
  rels(part: string): Map<string, Rel> {
    const hit = this.relCache.get(part);
    if (hit) return hit;
    const dir = part.includes('/') ? part.slice(0, part.lastIndexOf('/')) : '';
    const file = part.slice(part.lastIndexOf('/') + 1);
    const relPath = `${dir ? `${dir}/` : ''}_rels/${file}.rels`;
    const map = new Map<string, Rel>();
    for (const r of kids(this.xml(relPath), 'Relationship')) {
      const external = r.attrs.TargetMode === 'External';
      const target = r.attrs.Target ?? '';
      map.set(r.attrs.Id ?? '', { id: r.attrs.Id ?? '', type: r.attrs.Type ?? '', target: external ? target : resolvePart(dir, target), external });
    }
    this.relCache.set(part, map);
    return map;
  }

  /** First relationship whose type ends with `suffix` (e.g. "/slideLayout"). */
  relOfType(part: string, suffix: string): Rel | null {
    for (const r of this.rels(part).values()) if (r.type.endsWith(suffix)) return r;
    return null;
  }
}

/** Resolve a relationship target relative to the source part's folder. */
export function resolvePart(dir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = dir ? dir.split('/') : [];
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/* ------------------------------------------------------------------ */
/* Colors                                                              */
/* ------------------------------------------------------------------ */

const PRESET_COLORS: Record<string, string> = {
  black: '000000',
  white: 'FFFFFF',
  red: 'FF0000',
  green: '008000',
  blue: '0000FF',
  yellow: 'FFFF00',
  gray: '808080',
  grey: '808080',
  darkGray: 'A9A9A9',
  lightGray: 'D3D3D3',
  orange: 'FFA500',
  purple: '800080',
  navy: '000080',
  teal: '008080',
};

function hexToRgb(h: string): [number, number, number] {
  const x = h.replace('#', '').padEnd(6, '0');
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `${c(r)}${c(g)}${c(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

export interface ColorContext {
  /** Theme scheme colors by name (dk1, lt1, accent1, hlink, …), hex without '#'. */
  scheme: Record<string, string>;
  /** Master color map (bg1 → lt1, tx1 → dk1, …). */
  map: Record<string, string>;
  /** Color substituted for "phClr" (style references). */
  placeholder?: string;
}

/**
 * Resolve a color element (a:srgbClr, a:schemeClr, a:sysClr, a:prstClr, a:scrgbClr) with its
 * modifiers into "#rrggbb" or "#rrggbbaa".
 */
export function resolveColor(el: XNode | null, ctx: ColorContext): string | null {
  if (!el) return null;
  let hex: string | null = null;
  switch (el.tag) {
    case 'a:srgbClr':
      hex = el.attrs.val ?? null;
      break;
    case 'a:sysClr':
      hex = el.attrs.lastClr ?? (el.attrs.val === 'window' ? 'FFFFFF' : '000000');
      break;
    case 'a:prstClr':
      hex = PRESET_COLORS[el.attrs.val ?? ''] ?? '000000';
      break;
    case 'a:scrgbClr':
      hex = rgbToHex((num(el.attrs.r, 0) / 100000) * 255, (num(el.attrs.g, 0) / 100000) * 255, (num(el.attrs.b, 0) / 100000) * 255);
      break;
    case 'a:schemeClr': {
      const name = el.attrs.val ?? '';
      if (name === 'phClr') hex = ctx.placeholder?.replace('#', '').slice(0, 6) ?? null;
      else hex = ctx.scheme[ctx.map[name] ?? name] ?? ctx.scheme[name] ?? null;
      break;
    }
    default:
      return null;
  }
  if (!hex) return null;
  let [r, g, b] = hexToRgb(hex);
  let alpha = 1;
  for (const m of kids(el)) {
    const v = num(m.attrs.val, 100000) / 100000;
    switch (m.tag) {
      case 'a:lumMod':
      case 'a:lumOff': {
        const [h, s, l] = rgbToHsl(r, g, b);
        const nl = m.tag === 'a:lumMod' ? l * v : l + v;
        [r, g, b] = hslToRgb(h, s, Math.max(0, Math.min(1, nl)));
        break;
      }
      case 'a:tint':
        r = 255 - (255 - r) * v;
        g = 255 - (255 - g) * v;
        b = 255 - (255 - b) * v;
        break;
      case 'a:shade':
        r *= v;
        g *= v;
        b *= v;
        break;
      case 'a:alpha':
        alpha = v;
        break;
    }
  }
  const out = `#${rgbToHex(r, g, b)}`;
  return alpha < 0.999 ? `${out}${Math.round(alpha * 255).toString(16).padStart(2, '0')}` : out;
}

/** The color inside a fill container (a:solidFill, first gradient stop) or null for no fill. */
export function fillColor(container: XNode | null, ctx: ColorContext): string | null | undefined {
  if (!container) return undefined;
  const solid = kid(container, 'a:solidFill');
  if (solid) return resolveColor(kids(solid)[0] ?? null, ctx);
  if (kid(container, 'a:noFill')) return null;
  const grad = kid(container, 'a:gradFill');
  if (grad) {
    const stops = kids(at(grad, 'a:gsLst'), 'a:gs');
    return resolveColor(kids(stops[0])[0] ?? null, ctx);
  }
  return undefined;
}
