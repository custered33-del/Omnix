import type { ChartSpec, ElementAnimationKind, InlineSpan, PathAnchor, SlideElementProps, SlideLayout, SlideTransitionKind, VectorShape } from '@omnix/core';
import { spansToInline } from '@omnix/core';
import { at, fillColor, find, findAll, kid, kids, num, OoxmlPackage, resolveColor, textOf, type ColorContext, type XNode } from './ooxml.js';

/**
 * PowerPoint import. Reads slides in order with their placeholders resolved through layouts
 * and masters, and returns elements in the target deck's pixel space (the slide is fitted and
 * centred when aspect ratios differ). Text keeps bold, italic, strike, links and bullets;
 * shapes, pictures (with crops), video, native charts, backgrounds, speaker notes,
 * transitions and entrance/emphasis/exit animations come across. The caller stores media.
 */

export interface ImportBox {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

export interface ImportedAnimation {
  kind: ElementAnimationKind;
  trigger: 'on-enter' | 'on-click' | 'with-previous';
  click: number | null;
  delay: number;
  duration: number;
}

export type ImportedElement = ImportBox & { animations: ImportedAnimation[] } & (
    | { kind: 'text'; role: SlideElementProps['role']; text: string; fontSize: number | null; fontFamily: string | null; color: string | null; align: 'left' | 'center' | 'right'; valign: 'top' | 'middle' | 'bottom'; bold: boolean }
    | { kind: 'image'; role: 'image' | null; media: string; crop: { l: number; t: number; r: number; b: number } | null; alt: string }
    | { kind: 'video'; media: string; poster: string | null; name: string }
    | { kind: 'shape'; shape: Omit<VectorShape, 'id'> }
    | { kind: 'chart'; spec: ChartSpec }
  );

export interface ImportedSlide {
  hidden: boolean;
  layout: SlideLayout;
  background: string;
  backgroundMedia: string | null;
  notes: string;
  transition: { kind: SlideTransitionKind; duration: number } | null;
  elements: ImportedElement[];
}

export interface ImportedPresentation {
  /** Source slide size in EMU. */
  slideWidth: number;
  slideHeight: number;
  slides: ImportedSlide[];
  /** Media part bytes by path (images, video). */
  media(path: string): Uint8Array | null;
  /** Things that could not be imported exactly, for the person importing. */
  notes: string[];
  fonts: { heading: string | null; body: string | null };
}

const EMU_PER_PT = 12700;
const MONO = /courier|consolas|menlo|monaco|mono|source code|inconsolata|fira code/i;
const UNSUPPORTED_IMAGE = /\.(emf|wmf|emz|wmz)$/i;

interface Ph {
  type: string;
  idx: string | null;
}

interface Part {
  path: string;
  tree: XNode;
}

interface SlideCtx {
  pkg: OoxmlPackage;
  slide: Part;
  layout: Part | null;
  master: Part | null;
  color: ColorContext;
  fonts: { major: string | null; minor: string | null };
  txStyles: { title: XNode | null; body: XNode | null; other: XNode | null };
  defaultTextStyle: XNode | null;
  lineWidths: number[];
  layoutPhs: XNode[];
  masterPhs: XNode[];
}

/** What a shape id became, so animations can find their elements. */
type ElementSink = (spid: string, el: ImportedElement) => void;

type Transform = (b: ImportBox) => ImportBox;

class Notes {
  private seen = new Set<string>();
  readonly list: string[] = [];
  add(msg: string): void {
    if (this.seen.has(msg)) return;
    this.seen.add(msg);
    this.list.push(msg);
  }
}

const SHAPE_TAGS = new Set(['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp', 'p:cxnSp', 'mc:AlternateContent', 'p:contentPart']);

function phOf(el: XNode): Ph | null {
  const nv = el.children.find((c) => c.tag.startsWith('p:nv'));
  const ph = at(nv, 'p:nvPr', 'p:ph');
  if (!ph) return null;
  return { type: ph.attrs.type ?? 'obj', idx: ph.attrs.idx ?? null };
}

function cNvPr(el: XNode): XNode | null {
  const nv = el.children.find((c) => c.tag.startsWith('p:nv'));
  return kid(nv, 'p:cNvPr');
}

const phGroup = (t: string) => (t === 'title' || t === 'ctrTitle' ? 'title' : t === 'body' || t === 'obj' || t === 'subTitle' ? 'body' : t);

function matchPh(candidates: XNode[], ph: Ph, byIdx: boolean): XNode | null {
  if (byIdx && ph.idx !== null) {
    const hit = candidates.find((c) => phOf(c)?.idx === ph.idx);
    if (hit) return hit;
  }
  return candidates.find((c) => phOf(c)?.type === ph.type) ?? candidates.find((c) => phGroup(phOf(c)!.type) === phGroup(ph.type)) ?? null;
}

function spTree(part: Part | null): XNode | null {
  return part ? at(part.tree, 'p:cSld', 'p:spTree') : null;
}

/** Shapes with placeholders in a layout or master (looking inside groups is not needed for placeholders). */
function placeholders(part: Part | null): XNode[] {
  return kids(spTree(part)).filter((c) => phOf(c));
}

function xfrmOf(el: XNode | null): XNode | null {
  if (!el) return null;
  return at(el, 'p:spPr', 'a:xfrm') ?? kid(el, 'p:xfrm') ?? at(el, 'p:grpSpPr', 'a:xfrm');
}

function boxOf(x: XNode): ImportBox & { flipH: boolean; flipV: boolean } {
  const off = kid(x, 'a:off');
  const ext = kid(x, 'a:ext');
  return {
    x: num(off?.attrs.x, 0),
    y: num(off?.attrs.y, 0),
    w: num(ext?.attrs.cx, 0),
    h: num(ext?.attrs.cy, 0),
    rotation: num(x.attrs.rot, 0) / 60000,
    flipH: x.attrs.flipH === '1' || x.attrs.flipH === 'true',
    flipV: x.attrs.flipV === '1' || x.attrs.flipV === 'true',
  };
}

const truthy = (v: string | undefined) => v === '1' || v === 'true';

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

interface RunInfo {
  span: InlineSpan;
  size: number | null;
  color: string | null;
  font: string | null;
}

interface ParaInfo {
  bullet: 'none' | 'char' | 'number';
  startAt: number;
  level: number;
  align: 'left' | 'center' | 'right' | null;
  runs: RunInfo[];
}

function styleKind(ph: Ph | null): 'title' | 'body' | 'other' {
  if (!ph) return 'other';
  const g = phGroup(ph.type);
  return g === 'title' ? 'title' : g === 'body' ? 'body' : 'other';
}

/** Text body of a shape with formatting inherited from layout, master and presentation defaults. */
function readText(el: XNode, chain: XNode[], ph: Ph | null, ctx: SlideCtx, slideRels: ReturnType<OoxmlPackage['rels']>): { paras: ParaInfo[]; anchor: 'top' | 'middle' | 'bottom'; insets: [number, number, number, number]; fontScale: number } {
  const bodies = chain.map((c) => kid(c, 'p:txBody')).filter((b): b is XNode => !!b);
  const body = bodies[0] ?? null;
  const kind = styleKind(ph);
  const lstStyles = [...bodies.map((b) => kid(b, 'a:lstStyle')), ctx.txStyles[kind], kind === 'other' ? ctx.defaultTextStyle : null].filter((x): x is XNode => !!x);
  const bodyPrs = bodies.map((b) => kid(b, 'a:bodyPr')).filter((x): x is XNode => !!x);
  const bodyAttr = (name: string) => bodyPrs.find((b) => b.attrs[name] !== undefined)?.attrs[name];
  const anchorAttr = bodyAttr('anchor');
  const anchor = anchorAttr === 'ctr' ? 'middle' : anchorAttr === 'b' ? 'bottom' : 'top';
  const insets: [number, number, number, number] = [num(bodyAttr('lIns'), 91440), num(bodyAttr('tIns'), 45720), num(bodyAttr('rIns'), 91440), num(bodyAttr('bIns'), 45720)];
  const autofit = bodyPrs.map((b) => kid(b, 'a:normAutofit')).find((x) => x);
  const fontScale = autofit ? num(autofit.attrs.fontScale, 100000) / 100000 : 1;
  // Shapes with a style reference get their default text color from it.
  const styleFont = at(el, 'p:style', 'a:fontRef');
  const styleColor = styleFont ? resolveColor(kids(styleFont)[0] ?? null, ctx.color) : null;

  const paras: ParaInfo[] = [];
  const numberCounters = new Map<number, number>();
  for (const p of kids(body, 'a:p')) {
    const pPr = kid(p, 'a:pPr');
    const level = Math.max(0, Math.min(8, num(pPr?.attrs.lvl, 0)));
    const levels = [pPr, ...lstStyles.map((ls) => kid(ls, `a:lvl${level + 1}pPr`))].filter((x): x is XNode => !!x);
    const algn = levels.find((l) => l.attrs.algn)?.attrs.algn;
    let bullet: ParaInfo['bullet'] = 'none';
    let startAt = 1;
    for (const l of levels) {
      if (kid(l, 'a:buNone')) break;
      if (kid(l, 'a:buChar') || kid(l, 'a:buBlip')) {
        bullet = 'char';
        break;
      }
      const auto = kid(l, 'a:buAutoNum');
      if (auto) {
        bullet = 'number';
        startAt = num(auto.attrs.startAt, 1);
        break;
      }
    }
    const defs = [kid(pPr, 'a:defRPr'), ...levels.map((l) => kid(l, 'a:defRPr'))].filter((x): x is XNode => !!x);
    // Formatting set on this shape itself wins over its style reference; inherited defaults lose to it.
    const ownLevel = kid(kid(body, 'a:lstStyle'), `a:lvl${level + 1}pPr`);
    const ownDefs = new Set([kid(pPr, 'a:defRPr'), kid(ownLevel, 'a:defRPr')].filter((x): x is XNode => !!x));
    const runs: RunInfo[] = [];
    const pushRun = (rPr: XNode | null, text: string) => {
      const props = [rPr, ...defs].filter((x): x is XNode => !!x);
      const attr = (name: string) => props.find((x) => x.attrs[name] !== undefined)?.attrs[name];
      let color: string | null | undefined;
      for (const x of props) {
        if (styleColor && x !== rPr && !ownDefs.has(x)) {
          color = styleColor;
          break;
        }
        color = fillColor(x, ctx.color);
        if (color !== undefined) break;
      }
      const latin = props.map((x) => kid(x, 'a:latin')?.attrs.typeface).find((t) => t);
      const font = latin === '+mj-lt' ? ctx.fonts.major : latin === '+mn-lt' ? ctx.fonts.minor : (latin ?? (kind === 'title' ? ctx.fonts.major : ctx.fonts.minor));
      const link = rPr ? kid(rPr, 'a:hlinkClick')?.attrs['r:id'] : undefined;
      const url = link ? slideRels.get(link) : undefined;
      const strike = attr('strike');
      const span: InlineSpan = { text };
      if (truthy(attr('b'))) span.bold = true;
      if (truthy(attr('i'))) span.italic = true;
      if (strike && strike !== 'noStrike') span.strike = true;
      if (url?.external && /^(https?:|mailto:)/i.test(url.target)) span.link = url.target;
      if (font && MONO.test(font)) span.code = true;
      const sz = attr('sz');
      runs.push({ span, size: sz ? (num(sz, 1800) / 100) * fontScale : null, color: color ?? styleColor ?? null, font: font ?? null });
    };
    for (const c of p.children) {
      if (c.tag === 'a:r' || c.tag === 'a:fld') pushRun(kid(c, 'a:rPr'), textOf(kid(c, 'a:t')));
      else if (c.tag === 'a:br') runs.push({ span: { text: '\n' }, size: null, color: null, font: null });
    }
    if (bullet === 'number') {
      const n = (numberCounters.get(level) ?? startAt - 1) + 1;
      numberCounters.set(level, n);
      startAt = n;
    } else {
      numberCounters.delete(level);
    }
    if (!runs.length) {
      const end = kid(p, 'a:endParaRPr');
      const sz = end?.attrs.sz ?? defs.find((d) => d.attrs.sz)?.attrs.sz;
      runs.push({ span: { text: '' }, size: sz ? (num(sz, 1800) / 100) * fontScale : null, color: null, font: null });
    }
    paras.push({ bullet, startAt, level, align: algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : algn ? 'left' : null, runs });
    // Paragraph-level default size when no run sets one.
    const defSz = defs.find((d) => d.attrs.sz)?.attrs.sz;
    for (const r of runs) if (r.size === null && defSz) r.size = (num(defSz, 1800) / 100) * fontScale;
  }
  return { paras, anchor, insets, fontScale };
}

/** Paragraphs to inline markdown with one size, color and font for the element (the dominant run's). */
function textElement(paras: ParaInfo[]): { text: string; size: number | null; color: string | null; font: string | null; bold: boolean; align: 'left' | 'center' | 'right' } | null {
  const all = paras.flatMap((p) => p.runs).filter((r) => r.span.text.trim() && r.span.text !== '\n');
  if (!all.length) return null;
  const weight = new Map<RunInfo, number>();
  for (const r of all) weight.set(r, r.span.text.length);
  const dominant = [...all].sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0))[0]!;
  const sizes = all.map((r) => r.size).filter((s): s is number => s !== null);
  const allBold = all.every((r) => r.span.bold);
  const lines: string[] = [];
  for (const p of paras) {
    // Soft line breaks become separate lines; only the first keeps the bullet.
    const pieces: InlineSpan[][] = [[]];
    for (const r of p.runs) {
      if (r.span.text === '\n') pieces.push([]);
      else pieces[pieces.length - 1]!.push(allBold ? { ...r.span, bold: false } : r.span);
    }
    pieces.forEach((spans, i) => {
      let md = spansToInline(spans);
      if (i === 0 && p.bullet !== 'none' && md.trim()) md = `${'  '.repeat(p.level)}${p.bullet === 'number' ? `${p.startAt}.` : '-'} ${md}`;
      lines.push(md);
    });
  }
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  while (lines.length && !lines[0]!.trim()) lines.shift();
  return {
    text: lines.join('\n'),
    size: dominant.size ?? (sizes.length ? Math.max(...sizes) : null),
    color: dominant.color,
    font: dominant.font,
    bold: allBold,
    align: paras.find((p) => p.runs.some((r) => r.span.text.trim()))?.align ?? 'left',
  };
}

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

type Pt = { x: number; y: number };

function regular(n: number, inner?: number): Pt[] {
  const pts: Pt[] = [];
  const count = inner ? n * 2 : n;
  for (let i = 0; i < count; i++) {
    const r = inner && i % 2 === 1 ? inner : 1;
    const a = -Math.PI / 2 + (i * Math.PI * 2) / count;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  // Normalize to the unit box like PowerPoint does for its presets.
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  return pts.map((p) => ({ x: (p.x - minX) / (maxX - minX), y: (p.y - minY) / (maxY - minY) }));
}

/** Preset geometry as a unit-box polygon (null for presets drawn natively). */
function presetPolygon(prst: string, adj: (name: string, def: number) => number, w: number, h: number): Pt[] | null {
  const m = Math.min(w, h) || 1;
  const ox = (v: number) => (v * m) / (w || 1);
  const oy = (v: number) => (v * m) / (h || 1);
  switch (prst) {
    case 'triangle': {
      const a = adj('adj', 50000) / 100000;
      return [{ x: a, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    }
    case 'rtTriangle':
      return [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    case 'diamond':
    case 'flowChartDecision':
      return [{ x: 0.5, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 0.5 }];
    case 'parallelogram':
    case 'flowChartInputOutput': {
      const o = ox(adj('adj', 25000) / 100000);
      return [{ x: o, y: 0 }, { x: 1, y: 0 }, { x: 1 - o, y: 1 }, { x: 0, y: 1 }];
    }
    case 'trapezoid': {
      const o = ox(adj('adj', 25000) / 100000);
      return [{ x: o, y: 0 }, { x: 1 - o, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    }
    case 'pentagon':
      return regular(5);
    case 'hexagon': {
      const o = ox(adj('adj', 25000) / 100000);
      return [{ x: o, y: 0 }, { x: 1 - o, y: 0 }, { x: 1, y: 0.5 }, { x: 1 - o, y: 1 }, { x: o, y: 1 }, { x: 0, y: 0.5 }];
    }
    case 'heptagon':
      return regular(7);
    case 'octagon': {
      const a = adj('adj', 29289) / 100000;
      const x = ox(a);
      const y = oy(a);
      return [{ x, y: 0 }, { x: 1 - x, y: 0 }, { x: 1, y }, { x: 1, y: 1 - y }, { x: 1 - x, y: 1 }, { x, y: 1 }, { x: 0, y: 1 - y }, { x: 0, y }];
    }
    case 'decagon':
      return regular(10);
    case 'dodecagon':
      return regular(12);
    case 'star4':
      return regular(4, adj('adj', 12500) / 50000);
    case 'star5':
      return regular(5, adj('adj', 19098) / 50000);
    case 'star6':
      return regular(6, adj('adj', 28868) / 50000);
    case 'star7':
      return regular(7, adj('adj', 34601) / 50000);
    case 'star8':
      return regular(8, adj('adj', 37500) / 50000);
    case 'star10':
      return regular(10, adj('adj', 42533) / 50000);
    case 'star12':
      return regular(12, adj('adj', 37500) / 50000);
    case 'rightArrow':
    case 'leftArrow':
    case 'upArrow':
    case 'downArrow': {
      const t = adj('adj1', 50000) / 200000;
      const vertical = prst === 'upArrow' || prst === 'downArrow';
      const hl = vertical ? oy(adj('adj2', 50000) / 100000) : ox(adj('adj2', 50000) / 100000);
      let pts: Pt[] = [{ x: 0, y: 0.5 - t }, { x: 1 - hl, y: 0.5 - t }, { x: 1 - hl, y: 0 }, { x: 1, y: 0.5 }, { x: 1 - hl, y: 1 }, { x: 1 - hl, y: 0.5 + t }, { x: 0, y: 0.5 + t }];
      if (prst === 'leftArrow') pts = pts.map((p) => ({ x: 1 - p.x, y: p.y }));
      if (vertical) pts = pts.map((p) => ({ x: p.y, y: prst === 'downArrow' ? p.x : 1 - p.x }));
      return pts;
    }
    case 'chevron': {
      const o = ox(adj('adj', 50000) / 100000);
      return [{ x: 0, y: 0 }, { x: 1 - o, y: 0 }, { x: 1, y: 0.5 }, { x: 1 - o, y: 1 }, { x: 0, y: 1 }, { x: o, y: 0.5 }];
    }
    case 'homePlate': {
      const o = ox(adj('adj', 50000) / 100000);
      return [{ x: 0, y: 0 }, { x: 1 - o, y: 0 }, { x: 1, y: 0.5 }, { x: 1 - o, y: 1 }, { x: 0, y: 1 }];
    }
    case 'plus':
    case 'mathPlus': {
      const a = adj('adj', 25000) / 100000;
      const x = ox(a);
      const y = oy(a);
      return [
        { x, y: 0 },
        { x: 1 - x, y: 0 },
        { x: 1 - x, y },
        { x: 1, y },
        { x: 1, y: 1 - y },
        { x: 1 - x, y: 1 - y },
        { x: 1 - x, y: 1 },
        { x, y: 1 },
        { x, y: 1 - y },
        { x: 0, y: 1 - y },
        { x: 0, y },
        { x, y },
      ];
    }
    default:
      return null;
  }
}

const RECT_LIKE = new Set(['rect', 'flowChartProcess', 'flowChartPredefinedProcess', 'flowChartInternalStorage', 'snip1Rect', 'snip2SameRect', 'snip2DiagRect', 'snipRoundRect', 'frame', 'halfFrame', 'plaque', 'bevel', 'foldedCorner', 'textBox', 'wedgeRectCallout', 'borderCallout1', 'callout1', 'accentCallout1', 'actionButtonBlank', 'can', 'cube']);
const ROUND_LIKE = new Set(['roundRect', 'round1Rect', 'round2SameRect', 'round2DiagRect', 'flowChartAlternateProcess', 'wedgeRoundRectCallout']);
const ELLIPSE_LIKE = new Set(['ellipse', 'flowChartConnector', 'donut', 'pie', 'chord', 'arc', 'blockArc', 'wedgeEllipseCallout', 'cloud', 'cloudCallout', 'smileyFace', 'sun', 'moon', 'heart', 'flowChartOr', 'flowChartSummingJunction']);
const LINE_LIKE = new Set(['line', 'straightConnector1', 'bentConnector2', 'bentConnector3', 'bentConnector4', 'bentConnector5', 'curvedConnector2', 'curvedConnector3', 'curvedConnector4', 'curvedConnector5']);

/** Custom geometry to a bezier path in the shape's own frame (the longest sub-path). */
function customPath(geom: XNode, w: number, h: number): BezierPathLike | null {
  const paths = kids(at(geom, 'a:pathLst'), 'a:path');
  let best: BezierPathLike | null = null;
  for (const p of paths) {
    const pw = num(p.attrs.w, 0) || w;
    const ph = num(p.attrs.h, 0) || h;
    const sx = pw ? w / pw : 1;
    const sy = ph ? h / ph : 1;
    const pt = (n: XNode | null): Pt => ({ x: num(n?.attrs.x, 0) * sx, y: num(n?.attrs.y, 0) * sy });
    const subs: BezierPathLike[] = [];
    let cur: BezierPathLike | null = null;
    let last: Pt = { x: 0, y: 0 };
    for (const c of kids(p)) {
      const pts = kids(c, 'a:pt');
      switch (c.tag) {
        case 'a:moveTo':
          last = pt(pts[0] ?? null);
          cur = { closed: false, anchors: [{ ...last }] };
          subs.push(cur);
          break;
        case 'a:lnTo':
          last = pt(pts[0] ?? null);
          cur?.anchors.push({ ...last });
          break;
        case 'a:cubicBezTo': {
          if (!cur || pts.length < 3) break;
          const [c1, c2, end] = [pt(pts[0]!), pt(pts[1]!), pt(pts[2]!)];
          cur.anchors[cur.anchors.length - 1]!.out = c1;
          cur.anchors.push({ ...end, in: c2 });
          last = end;
          break;
        }
        case 'a:quadBezTo': {
          if (!cur || pts.length < 2) break;
          const [q, end] = [pt(pts[0]!), pt(pts[1]!)];
          cur.anchors[cur.anchors.length - 1]!.out = { x: last.x + ((q.x - last.x) * 2) / 3, y: last.y + ((q.y - last.y) * 2) / 3 };
          cur.anchors.push({ ...end, in: { x: end.x + ((q.x - end.x) * 2) / 3, y: end.y + ((q.y - end.y) * 2) / 3 } });
          last = end;
          break;
        }
        case 'a:arcTo': {
          if (!cur) break;
          const wR = num(c.attrs.wR, 0) * sx;
          const hR = num(c.attrs.hR, 0) * sy;
          const st = (num(c.attrs.stAng, 0) / 60000) * (Math.PI / 180);
          const sw = (num(c.attrs.swAng, 0) / 60000) * (Math.PI / 180);
          const cx = last.x - wR * Math.cos(st);
          const cy = last.y - hR * Math.sin(st);
          const steps = Math.max(2, Math.ceil(Math.abs(sw) / (Math.PI / 8)));
          for (let i = 1; i <= steps; i++) {
            const a = st + (sw * i) / steps;
            last = { x: cx + wR * Math.cos(a), y: cy + hR * Math.sin(a) };
            cur.anchors.push({ ...last });
          }
          break;
        }
        case 'a:close':
          if (cur) cur.closed = true;
          break;
      }
    }
    for (const s of subs) {
      if (s.closed && s.anchors.length > 1) {
        const a = s.anchors[0]!;
        const b = s.anchors[s.anchors.length - 1]!;
        if (Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01) {
          if (b.in) a.in = b.in;
          s.anchors.pop();
        }
      }
      if (!best || s.anchors.length > best.anchors.length) best = s;
    }
  }
  return best && best.anchors.length >= 2 ? best : null;
}

type BezierPathLike = { closed: boolean; anchors: PathAnchor[] };

/* ------------------------------------------------------------------ */
/* Charts                                                              */
/* ------------------------------------------------------------------ */

function cacheValues(ref: XNode | null): (string | null)[] {
  if (!ref) return [];
  const cache = find(ref, 'c:strCache') ?? find(ref, 'c:numCache') ?? find(ref, 'c:lvl');
  const direct = kid(ref, 'c:strLit') ?? kid(ref, 'c:numLit');
  const src = cache ?? direct;
  if (!src) return [];
  const count = num(kid(src, 'c:ptCount')?.attrs.val, 0);
  const pts = kids(src, 'c:pt');
  const out: (string | null)[] = Array.from({ length: Math.max(count, pts.length) }, () => null);
  pts.forEach((p, i) => {
    const idx = num(p.attrs.idx, i);
    if (idx >= 0 && idx < 100_000) out[idx] = textOf(kid(p, 'c:v'));
  });
  return out;
}

function richText(n: XNode | null): string {
  return findAll(n, 'a:t')
    .map((t) => textOf(t))
    .join('')
    .trim();
}

export function parseChart(xml: XNode, color: ColorContext): { spec: ChartSpec; note: string | null } | null {
  const chart = kid(xml, 'c:chart');
  const plot = kid(chart, 'c:plotArea');
  if (!plot) return null;
  const order: [string, ChartSpec['type']][] = [
    ['c:barChart', 'bar'],
    ['c:bar3DChart', 'bar'],
    ['c:lineChart', 'line'],
    ['c:line3DChart', 'line'],
    ['c:areaChart', 'area'],
    ['c:area3DChart', 'area'],
    ['c:pieChart', 'pie'],
    ['c:pie3DChart', 'pie'],
    ['c:doughnutChart', 'pie'],
    ['c:ofPieChart', 'pie'],
    ['c:scatterChart', 'scatter'],
    ['c:bubbleChart', 'scatter'],
    ['c:radarChart', 'line'],
  ];
  const found = order.map(([tag, type]) => ({ node: kid(plot, tag), type, tag })).filter((x) => x.node);
  const first = found[0];
  if (!first) return null;
  const notes: string[] = [];
  if (found.length > 1) notes.push('combined chart types were simplified to one');
  if (first.tag.includes('3D')) notes.push('3-D charts became flat charts');
  if (kid(first.node, 'c:barDir')?.attrs.val === 'bar') notes.push('horizontal bars became vertical columns');
  if (first.tag === 'c:radarChart') notes.push('a radar chart became a line chart');
  let labels: string[] = [];
  const series: ChartSpec['series'] = [];
  for (const ser of kids(first.node, 'c:ser')) {
    const name = textOf(at(ser, 'c:tx', 'c:v')) || cacheValues(at(ser, 'c:tx', 'c:strRef'))[0] || `Series ${series.length + 1}`;
    const cat = kid(ser, 'c:cat') ?? kid(ser, 'c:xVal');
    const val = kid(ser, 'c:val') ?? kid(ser, 'c:yVal');
    const cats = cacheValues(cat);
    if (!labels.length && cats.length) labels = cats.map((c, i) => c ?? String(i + 1));
    const values = cacheValues(val).map((v) => (v === null || v === '' ? Number.NaN : Number(v)));
    const c = fillColor(kid(ser, 'c:spPr'), color);
    series.push({ name, values, ...(c ? { color: c.slice(0, 7) } : {}) });
  }
  if (!series.length) return null;
  if (!labels.length) labels = Array.from({ length: Math.max(...series.map((s) => s.values.length)) }, (_, i) => String(i + 1));
  const title = kid(chart, 'c:autoTitleDeleted')?.attrs.val === '1' ? '' : richText(kid(chart, 'c:title'));
  const axTitle = (tag: string, pos?: string[]) => {
    const ax = kids(plot, tag).find((a) => !pos || pos.includes(kid(a, 'c:axPos')?.attrs.val ?? '')) ?? null;
    return richText(kid(ax, 'c:title'));
  };
  const xLabel = first.type === 'scatter' ? axTitle('c:valAx', ['b', 't']) : axTitle('c:catAx') || axTitle('c:dateAx');
  const yLabel = first.type === 'scatter' ? axTitle('c:valAx', ['l', 'r']) : axTitle('c:valAx');
  const spec: ChartSpec = { type: first.type, labels, series, ...(title ? { title } : {}), ...(xLabel ? { xLabel } : {}), ...(yLabel ? { yLabel } : {}) };
  return { spec, note: notes.length ? notes.join(', ') : null };
}

/* ------------------------------------------------------------------ */
/* Animations and transitions                                          */
/* ------------------------------------------------------------------ */

function condDelay(cTn: XNode | null): number {
  const c = at(cTn, 'p:stCondLst', 'p:cond');
  const d = c?.attrs.delay;
  return d && d !== 'indefinite' ? num(d, 0) / 1000 : 0;
}

function effectKind(cls: string, preset: number): ElementAnimationKind | null {
  if (cls === 'entr') return preset === 2 ? 'fly-in' : preset === 23 || preset === 53 || preset === 21 ? 'zoom-in' : 'fade-in';
  if (cls === 'exit') return preset === 2 ? 'fly-out' : 'fade-out';
  if (cls === 'emph') return preset === 8 ? 'spin' : 'pulse';
  return null;
}

/** Main-sequence animations by shape id, mapped to click steps. */
function readTiming(sld: XNode, notes: Notes): Map<string, ImportedAnimation[]> {
  const out = new Map<string, ImportedAnimation[]>();
  const timing = kid(sld, 'p:timing');
  if (!timing) return out;
  const mainSeq = findAll(timing, 'p:cTn').find((c) => c.attrs.nodeType === 'mainSeq');
  if (!mainSeq) return out;
  let step = 0;
  for (const clickPar of kids(kid(mainSeq, 'p:childTnLst'), 'p:par')) {
    const groupTn = kid(clickPar, 'p:cTn');
    const effects: { eff: XNode; delay: number }[] = [];
    for (const sub of kids(kid(groupTn, 'p:childTnLst'), 'p:par')) {
      const subTn = kid(sub, 'p:cTn');
      const subDelay = condDelay(subTn);
      for (const effPar of kids(kid(subTn, 'p:childTnLst'), 'p:par')) {
        const eff = kid(effPar, 'p:cTn');
        if (eff?.attrs.presetClass) effects.push({ eff, delay: subDelay + condDelay(eff) });
      }
    }
    if (!effects.length) continue;
    if (effects[0]!.eff.attrs.nodeType === 'clickEffect') step += 1;
    const seenThisStep = new Set<string>();
    for (const { eff, delay } of effects) {
      const cls = eff.attrs.presetClass ?? '';
      const preset = num(eff.attrs.presetID, 0);
      const kind = effectKind(cls, preset);
      const spid = find(eff, 'p:spTgt')?.attrs.spid;
      if (!spid) continue;
      if (!kind) {
        notes.add('Motion-path animations were not imported.');
        continue;
      }
      const durs = findAll(eff, 'p:cTn')
        .map((c) => (c.attrs.dur && c.attrs.dur !== 'indefinite' ? num(c.attrs.dur, 0) : 0))
        .filter((d) => d > 1);
      const duration = preset === 1 && cls !== 'emph' ? 0.01 : Math.max(0.05, (durs.length ? Math.max(...durs) : 500) / 1000);
      const list = out.get(spid) ?? [];
      const first = !seenThisStep.has(spid);
      seenThisStep.add(spid);
      list.push({ kind, trigger: step === 0 ? 'on-enter' : first ? 'on-click' : 'with-previous', click: step === 0 || !first ? null : step, delay: Math.round(delay * 100) / 100, duration: Math.round(duration * 100) / 100 });
      out.set(spid, list);
    }
  }
  return out;
}

const TRANSITIONS: Record<string, SlideTransitionKind> = {
  fade: 'fade',
  dissolve: 'fade',
  cut: 'none',
  push: 'push',
  cover: 'push',
  pull: 'push',
  wipe: 'wipe',
  split: 'wipe',
  strips: 'wipe',
  blinds: 'wipe',
  checker: 'wipe',
  comb: 'wipe',
  randomBar: 'wipe',
  circle: 'wipe',
  diamond: 'wipe',
  plus: 'wipe',
  wedge: 'wipe',
  wheel: 'wipe',
  zoom: 'zoom',
  newsflash: 'zoom',
};

function readTransition(sld: XNode, notes: Notes): ImportedSlide['transition'] {
  let tr = kid(sld, 'p:transition');
  for (const alt of kids(sld, 'mc:AlternateContent')) {
    const fb = at(alt, 'mc:Fallback', 'p:transition');
    const choice = at(alt, 'mc:Choice', 'p:transition');
    const picked: XNode | null = tr ?? fb ?? choice;
    // The newer (p14) form carries the exact duration.
    tr = picked && choice && !picked.attrs['p14:dur'] && choice.attrs['p14:dur'] ? { ...picked, attrs: { ...picked.attrs, 'p14:dur': choice.attrs['p14:dur'] } } : picked;
  }
  if (!tr) return null;
  const effect = kids(tr).find((c) => !c.tag.endsWith('sndAc') && !c.tag.endsWith('extLst'));
  const name = effect ? effect.tag.replace(/^\w+:/, '') : 'cut';
  const kind = TRANSITIONS[name];
  if (!kind) notes.add(`Some slide transitions (${name}) became fades.`);
  const ms = tr.attrs['p14:dur'] ?? tr.attrs.dur;
  const duration = ms ? num(ms, 500) / 1000 : tr.attrs.spd === 'slow' ? 1 : tr.attrs.spd === 'fast' ? 0.5 : 0.75;
  return { kind: kind ?? 'fade', duration: Math.max(0.1, Math.min(10, duration)) };
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

const LAYOUTS: Record<string, SlideLayout> = {
  title: 'title',
  ctrTitle: 'title',
  obj: 'title-body',
  tx: 'title-body',
  titleOnly: 'title-body',
  picTx: 'title-body',
  objTx: 'title-body',
  txAndObj: 'title-body',
  twoObj: 'two-column',
  twoTxTwoObj: 'two-column',
  twoColTx: 'two-column',
  objAndTx: 'two-column',
  secHead: 'section',
  blank: 'blank',
};

function themeOf(pkg: OoxmlPackage, master: Part | null): { scheme: Record<string, string>; major: string | null; minor: string | null; lineWidths: number[] } {
  const rel = master ? pkg.relOfType(master.path, '/theme') : null;
  const theme = rel ? pkg.xml(rel.target) : null;
  const elements = at(theme, 'a:themeElements');
  const scheme: Record<string, string> = {};
  for (const c of kids(at(elements, 'a:clrScheme'))) {
    const v = kids(c)[0];
    const hex = v?.tag === 'a:srgbClr' ? v.attrs.val : v?.tag === 'a:sysClr' ? v.attrs.lastClr : undefined;
    if (hex) scheme[c.tag.replace('a:', '')] = hex;
  }
  scheme.dk1 ??= '000000';
  scheme.lt1 ??= 'FFFFFF';
  const fonts = at(elements, 'a:fontScheme');
  const lineWidths = kids(at(elements, 'a:fmtScheme', 'a:lnStyleLst'), 'a:ln').map((l) => num(l.attrs.w, 9525));
  return { scheme, major: at(fonts, 'a:majorFont', 'a:latin')?.attrs.typeface ?? null, minor: at(fonts, 'a:minorFont', 'a:latin')?.attrs.typeface ?? null, lineWidths };
}

export function importPptx(data: Uint8Array, target: { width: number; height: number }): ImportedPresentation {
  const pkg = new OoxmlPackage(data);
  const presPath = 'ppt/presentation.xml';
  const pres = pkg.xml(presPath);
  if (!pres) throw new Error('This is not a PowerPoint presentation (ppt/presentation.xml is missing)');
  const sz = kid(pres, 'p:sldSz');
  const cx = num(sz?.attrs.cx, 12192000);
  const cy = num(sz?.attrs.cy, 6858000);
  const scale = Math.min(target.width / cx, target.height / cy);
  const offX = (target.width - cx * scale) / 2;
  const offY = (target.height - cy * scale) / 2;
  const toDeck = (b: ImportBox): ImportBox => ({ x: offX + b.x * scale, y: offY + b.y * scale, w: b.w * scale, h: b.h * scale, rotation: b.rotation });
  const ptToPx = (pt: number) => pt * EMU_PER_PT * scale;
  const notes = new Notes();
  if (Math.abs(cx / cy - target.width / target.height) > 0.01) notes.add('The presentation has a different shape than this deck, so slides were fitted and centred.');
  const presRels = pkg.rels(presPath);
  const defaultTextStyle = kid(pres, 'p:defaultTextStyle');
  const slidePaths = kids(kid(pres, 'p:sldIdLst'), 'p:sldId')
    .map((s) => presRels.get(s.attrs['r:id'] ?? ''))
    .filter((r): r is NonNullable<typeof r> => !!r && pkg.has(r.target))
    .map((r) => r.target);
  if (!slidePaths.length) notes.add('The presentation has no slides.');

  const usedMedia = new Set<string>();
  let fonts: ImportedPresentation['fonts'] = { heading: null, body: null };
  const slides: ImportedSlide[] = [];

  for (const slidePath of slidePaths) {
    const tree = pkg.xml(slidePath);
    if (!tree) continue;
    const slide: Part = { path: slidePath, tree };
    const layoutRel = pkg.relOfType(slidePath, '/slideLayout');
    const layoutTree = layoutRel ? pkg.xml(layoutRel.target) : null;
    const layout: Part | null = layoutRel && layoutTree ? { path: layoutRel.target, tree: layoutTree } : null;
    const masterRel = layout ? pkg.relOfType(layout.path, '/slideMaster') : null;
    const masterTree = masterRel ? pkg.xml(masterRel.target) : null;
    const master: Part | null = masterRel && masterTree ? { path: masterRel.target, tree: masterTree } : null;
    const theme = themeOf(pkg, master);
    fonts = { heading: fonts.heading ?? theme.major, body: fonts.body ?? theme.minor };
    const clrMap = kid(master?.tree, 'p:clrMap')?.attrs ?? { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };
    const override = at(tree, 'p:clrMapOvr', 'a:overrideClrMapping')?.attrs;
    const color: ColorContext = { scheme: theme.scheme, map: { ...clrMap, ...(override ?? {}) } };
    const txStyles = kid(master?.tree, 'p:txStyles');
    const ctx: SlideCtx = {
      pkg,
      slide,
      layout,
      master,
      color,
      fonts: { major: theme.major, minor: theme.minor },
      txStyles: { title: kid(txStyles, 'p:titleStyle'), body: kid(txStyles, 'p:bodyStyle'), other: kid(txStyles, 'p:otherStyle') },
      defaultTextStyle,
      lineWidths: theme.lineWidths,
      layoutPhs: placeholders(layout),
      masterPhs: placeholders(master),
    };
    const slideRels = pkg.rels(slidePath);
    const elements: ImportedElement[] = [];
    const bySpid = new Map<string, ImportedElement[]>();
    const sink: ElementSink = (spid, el) => {
      elements.push(el);
      const list = bySpid.get(spid) ?? [];
      list.push(el);
      bySpid.set(spid, list);
    };

    const mediaOf = (relId: string | undefined, rels = slideRels): string | null => {
      const r = relId ? rels.get(relId) : undefined;
      if (!r || r.external || !pkg.has(r.target)) return null;
      if (UNSUPPORTED_IMAGE.test(r.target)) {
        notes.add('Windows metafile pictures (EMF/WMF) cannot be shown in Omnix and were skipped.');
        return null;
      }
      usedMedia.add(r.target);
      return r.target;
    };

    // Background: slide, then layout, then master.
    let background = '#ffffff';
    let backgroundMedia: string | null = null;
    for (const part of [slide, layout, master]) {
      const bg = part ? at(part.tree, 'p:cSld', 'p:bg') : null;
      if (!bg) continue;
      const bgPr = kid(bg, 'p:bgPr');
      const bgRef = kid(bg, 'p:bgRef');
      if (bgPr) {
        const blip = at(bgPr, 'a:blipFill', 'a:blip');
        if (blip) {
          backgroundMedia = mediaOf(blip.attrs['r:embed'], pkg.rels(part!.path));
          if (backgroundMedia) break;
        }
        if (kid(bgPr, 'a:gradFill')) notes.add('Gradient backgrounds became solid colours.');
        if (kid(bgPr, 'a:pattFill')) notes.add('Pattern backgrounds became solid colours.');
        const c = fillColor(bgPr, color) ?? (kid(bgPr, 'a:pattFill') ? resolveColor(kids(at(bgPr, 'a:pattFill', 'a:bgClr'))[0] ?? null, color) : null);
        if (c) {
          background = c.slice(0, 7);
          break;
        }
      } else if (bgRef) {
        const c = resolveColor(kids(bgRef)[0] ?? null, color);
        if (c) {
          background = c.slice(0, 7);
          break;
        }
      }
    }

    const walk = (container: XNode | null, transform: Transform) => {
      for (const child of kids(container)) {
        if (!SHAPE_TAGS.has(child.tag)) continue;
        if (child.tag === 'mc:AlternateContent') {
          const choice = kid(child, 'mc:Choice');
          const fallback = kid(child, 'mc:Fallback');
          const useful = (n: XNode | null) => kids(n).some((c) => SHAPE_TAGS.has(c.tag));
          walk(useful(choice) ? choice : fallback, transform);
          continue;
        }
        if (child.tag === 'p:contentPart') {
          notes.add('Ink drawings were not imported.');
          continue;
        }
        shape(child, transform);
      }
    };

    const shape = (el: XNode, transform: Transform) => {
      const ph = phOf(el);
      const layoutEl = ph ? matchPh(ctx.layoutPhs, ph, true) : null;
      const layoutPh = layoutEl ? phOf(layoutEl) : null;
      const masterEl = ph ? matchPh(ctx.masterPhs, layoutPh ?? ph, false) : null;
      const chain = [el, layoutEl, masterEl].filter((x): x is XNode => !!x);
      const xfrm = chain.map(xfrmOf).find((x) => x && kid(x, 'a:ext')) ?? null;
      const id = cNvPr(el)?.attrs.id ?? '';
      const name = cNvPr(el)?.attrs.name ?? '';
      if (cNvPr(el)?.attrs.hidden === '1') return;

      if (el.tag === 'p:grpSp') {
        const gx = at(el, 'p:grpSpPr', 'a:xfrm');
        if (!gx) return walk(el, transform);
        const off = boxOf(gx);
        const chOff = kid(gx, 'a:chOff');
        const chExt = kid(gx, 'a:chExt');
        const cox = num(chOff?.attrs.x, off.x);
        const coy = num(chOff?.attrs.y, off.y);
        const sx = num(chExt?.attrs.cx, 0) ? off.w / num(chExt?.attrs.cx, 1) : 1;
        const sy = num(chExt?.attrs.cy, 0) ? off.h / num(chExt?.attrs.cy, 1) : 1;
        if (off.rotation) notes.add('Rotated groups were imported without their rotation.');
        const inner: Transform = (b) => transform({ x: off.x + (b.x - cox) * sx, y: off.y + (b.y - coy) * sy, w: b.w * sx, h: b.h * sy, rotation: b.rotation });
        walk(el, inner);
        return;
      }
      if (!xfrm) {
        if (el.tag === 'p:sp' && !textElement(readText(el, chain, ph, ctx, slideRels).paras)) return;
        if (el.tag !== 'p:sp') return;
      }
      const raw = xfrm ? boxOf(xfrm) : { x: 0, y: 0, w: cx, h: cy, rotation: 0, flipH: false, flipV: false };
      const box = toDeck(transform(raw));

      if (el.tag === 'p:graphicFrame') {
        const gd = at(el, 'a:graphic', 'a:graphicData');
        const uri = gd?.attrs.uri ?? '';
        if (uri.endsWith('/chart')) {
          const rel = slideRels.get(kid(gd, 'c:chart')?.attrs['r:id'] ?? '');
          const xml = rel ? pkg.xml(rel.target) : null;
          const parsed = xml ? parseChart(xml, color) : null;
          if (parsed) {
            if (parsed.note) notes.add(`Charts: ${parsed.note}.`);
            sink(id, { kind: 'chart', ...box, spec: parsed.spec, animations: [] });
          } else notes.add('Some charts could not be read and were skipped.');
          return;
        }
        if (uri.endsWith('/table')) {
          const tbl = kid(gd, 'a:tbl');
          const rows = kids(tbl, 'a:tr').map((tr) =>
            kids(tr, 'a:tc')
              .filter((tc) => !truthy(tc.attrs.hMerge) && !truthy(tc.attrs.vMerge))
              .map((tc) =>
                findAll(tc, 'a:p')
                  .map((p) => findAll(p, 'a:t').map((t) => textOf(t)).join(''))
                  .join(' ')
                  .trim(),
              ),
          );
          if (!rows.length) return;
          const firstCell = find(tbl, 'a:rPr');
          const sz = num(firstCell?.attrs.sz, 1400) / 100;
          const text = rows.map((r, i) => r.map((c) => (i === 0 && c ? `**${c.replace(/([\\*_`~[\]])/g, '\\$1')}**` : c.replace(/([\\*_`~[\]])/g, '\\$1'))).join('   ·   ')).join('\n');
          notes.add('Tables were imported as text.');
          sink(id, { kind: 'text', ...box, role: null, text, fontSize: ptToPx(sz), fontFamily: ctx.fonts.minor, color: resolveColor(kids(kid(firstCell, 'a:solidFill'))[0] ?? null, color) ?? resolveColor({ tag: 'a:schemeClr', attrs: { val: 'tx1' }, children: [] }, color), align: 'left', valign: 'top', bold: false, animations: [] });
          return;
        }
        // OLE objects and others: use their preview picture when there is one.
        const pic = find(gd, 'p:pic');
        if (pic) {
          const media = mediaOf(find(pic, 'a:blip')?.attrs['r:embed']);
          if (media) sink(id, { kind: 'image', ...box, role: null, media, crop: null, alt: name, animations: [] });
          return;
        }
        if (uri.includes('diagram')) notes.add('SmartArt diagrams were not imported.');
        else notes.add('Some embedded objects were not imported.');
        return;
      }

      if (el.tag === 'p:pic') {
        const blip = at(el, 'p:blipFill', 'a:blip');
        const nvPr = at(el, 'p:nvPicPr', 'p:nvPr');
        const video = kid(nvPr, 'a:videoFile');
        const p14 = findAll(nvPr, 'p14:media')[0];
        const poster = mediaOf(blip?.attrs['r:embed']);
        if (video || p14) {
          const rel = slideRels.get((p14?.attrs['r:embed'] ?? video?.attrs['r:link']) || '') ?? slideRels.get(video?.attrs['r:link'] ?? '');
          if (rel && !rel.external && pkg.has(rel.target)) {
            usedMedia.add(rel.target);
            sink(id, { kind: 'video', ...box, media: rel.target, poster, name: name || 'Video', animations: [] });
          } else {
            notes.add('Linked (not embedded) videos were skipped.');
            if (poster) sink(id, { kind: 'image', ...box, role: null, media: poster, crop: null, alt: name, animations: [] });
          }
          return;
        }
        if (kid(nvPr, 'a:audioFile')) {
          notes.add('Audio on slides was not imported.');
          return;
        }
        if (!poster) return;
        const src = at(el, 'p:blipFill', 'a:srcRect');
        const crop = src ? { l: num(src.attrs.l, 0) / 100000, t: num(src.attrs.t, 0) / 100000, r: num(src.attrs.r, 0) / 100000, b: num(src.attrs.b, 0) / 100000 } : null;
        const role = ph && (ph.type === 'pic' || phGroup(ph.type) === 'body') ? 'image' : null;
        sink(id, { kind: 'image', ...box, role, media: poster, crop: crop && (crop.l || crop.t || crop.r || crop.b) ? crop : null, alt: cNvPr(el)?.attrs.descr ?? name, animations: [] });
        return;
      }

      // p:sp and p:cxnSp: geometry, then text.
      const spPrs = chain.map((c) => kid(c, 'p:spPr')).filter((x): x is XNode => !!x);
      const spPr = spPrs[0] ?? null;
      const blipFill = kid(spPr, 'a:blipFill');
      if (blipFill) {
        const media = mediaOf(kid(blipFill, 'a:blip')?.attrs['r:embed']);
        if (media) sink(id, { kind: 'image', ...box, role: null, media, crop: null, alt: cNvPr(el)?.attrs.descr ?? name, animations: [] });
      }
      const style = kid(el, 'p:style');
      let fill: string | null | undefined;
      for (const p of spPrs) {
        fill = fillColor(p, color);
        if (fill !== undefined) break;
      }
      if (fill === undefined) {
        const ref = kid(style, 'a:fillRef');
        fill = ref && num(ref.attrs.idx, 0) > 0 ? resolveColor(kids(ref)[0] ?? null, color) : null;
      }
      if (kid(spPr, 'a:gradFill')) notes.add('Gradient fills became solid colours.');
      let stroke: string | null | undefined;
      let strokeW = 0;
      const ln = spPrs.map((p) => kid(p, 'a:ln')).find((x) => x) ?? null;
      if (ln) {
        stroke = fillColor(ln, color);
        strokeW = num(ln.attrs.w, 12700);
      }
      if (stroke === undefined) {
        const ref = kid(style, 'a:lnRef');
        const idx = num(ref?.attrs.idx, 0);
        stroke = ref && idx > 0 ? resolveColor(kids(ref)[0] ?? null, color) : null;
        if (ref && idx > 0) strokeW = ln?.attrs.w ? num(ln.attrs.w, 12700) : (ctx.lineWidths[idx - 1] ?? 12700);
      }
      const geom = spPrs.map((p) => kid(p, 'a:prstGeom') ?? kid(p, 'a:custGeom')).find((x) => x) ?? null;
      const prst = geom?.tag === 'a:prstGeom' ? (geom.attrs.prst ?? 'rect') : geom ? 'custom' : 'rect';
      const isLine = el.tag === 'p:cxnSp' || LINE_LIKE.has(prst);
      const visibleShape = !blipFill && (isLine ? !!stroke : !!fill || !!stroke);
      if (visibleShape) {
        const sw = Math.max(0, strokeW * scale);
        const s = { x: 0, y: 0, width: box.w, height: box.h, fill: isLine ? null : (fill ?? null), stroke: stroke ?? null, strokeWidth: stroke ? Math.max(0.5, sw) : 0 };
        const avs = new Map(kids(at(geom, 'a:avLst'), 'a:gd').map((g) => [g.attrs.name ?? '', num((g.attrs.fmla ?? '').replace(/^val\s+/, ''), Number.NaN)]));
        const adj = (n: string, d: number) => {
          const v = avs.get(n);
          return v !== undefined && Number.isFinite(v) ? v : d;
        };
        let out: ImportedElement | null = null;
        if (isLine) {
          // Lines run corner to corner of their box; flips choose the corners.
          const w = Math.max(box.w, s.strokeWidth);
          const h = Math.max(box.h, s.strokeWidth);
          const dx = (w - box.w) / 2;
          const dy = (h - box.h) / 2;
          const a = { x: dx + (raw.flipH ? box.w : 0), y: dy + (raw.flipV ? box.h : 0) };
          const b = { x: dx + (raw.flipH ? 0 : box.w), y: dy + (raw.flipV ? 0 : box.h) };
          out = { kind: 'shape', x: box.x - dx, y: box.y - dy, w, h, rotation: box.rotation, shape: { ...s, kind: 'line', width: w, height: h, points: [a, b] }, animations: [] };
          if (prst.startsWith('bent') || prst.startsWith('curved')) notes.add('Elbow and curved connectors became straight lines.');
        } else if (prst === 'custom') {
          const path = customPath(geom!, box.w, box.h);
          out = path ? { kind: 'shape', ...box, shape: { ...s, kind: 'path', path }, animations: [] } : { kind: 'shape', ...box, shape: { ...s, kind: 'rect' }, animations: [] };
          if (!path) notes.add('Some freeform shapes became rectangles.');
        } else if (ELLIPSE_LIKE.has(prst)) {
          out = { kind: 'shape', ...box, shape: { ...s, kind: 'ellipse' }, animations: [] };
          if (prst !== 'ellipse' && prst !== 'flowChartConnector') notes.add('Some rounded shapes (arcs, clouds, hearts…) became ellipses.');
        } else if (ROUND_LIKE.has(prst)) {
          out = { kind: 'shape', ...box, shape: { ...s, kind: 'rect', radius: (adj('adj', 16667) / 100000) * Math.min(box.w, box.h) }, animations: [] };
        } else if (prst === 'flowChartTerminator') {
          out = { kind: 'shape', ...box, shape: { ...s, kind: 'rect', radius: Math.min(box.w, box.h) / 2 }, animations: [] };
        } else {
          const poly = presetPolygon(prst, adj, box.w, box.h);
          if (poly) {
            let pts = poly.map((p) => ({ x: p.x * box.w, y: p.y * box.h }));
            if (raw.flipH) pts = pts.map((p) => ({ x: box.w - p.x, y: p.y }));
            if (raw.flipV) pts = pts.map((p) => ({ x: p.x, y: box.h - p.y }));
            out = { kind: 'shape', ...box, shape: { ...s, kind: 'polygon', points: pts }, animations: [] };
          } else {
            if (!RECT_LIKE.has(prst)) notes.add('Some PowerPoint shapes were simplified to rectangles.');
            out = { kind: 'shape', ...box, shape: { ...s, kind: 'rect' }, animations: [] };
          }
        }
        if (out) sink(id, out);
      }
      if (el.tag !== 'p:sp') return;
      const t = readText(el, chain, ph, ctx, slideRels);
      const te = textElement(t.paras);
      if (!te) return;
      const [l, tp, r, b] = t.insets.map((v) => v * scale) as [number, number, number, number];
      const role: SlideElementProps['role'] = ph ? (phGroup(ph.type) === 'title' ? 'title' : ph.type === 'subTitle' ? 'subtitle' : ph.type === 'ftr' ? 'footer' : phGroup(ph.type) === 'body' ? 'body' : null) : null;
      const fallbackPt = role === 'title' ? 44 : 18;
      const textColor = te.color ?? resolveColor({ tag: 'a:schemeClr', attrs: { val: 'tx1' }, children: [] }, color);
      sink(id, {
        kind: 'text',
        x: box.x + l,
        y: box.y + tp,
        w: Math.max(1, box.w - l - r),
        h: Math.max(1, box.h - tp - b),
        rotation: box.rotation,
        role,
        text: te.text,
        fontSize: ptToPx(te.size ?? fallbackPt),
        fontFamily: te.font,
        color: textColor,
        align: te.align,
        valign: t.anchor,
        bold: te.bold,
        animations: [],
      });
    };

    // Background picture first, behind everything.
    walk(at(tree, 'p:cSld', 'p:spTree'), (b) => b);

    // Animations onto the elements their shape became.
    for (const [spid, anims] of readTiming(tree, notes)) {
      for (const el of bySpid.get(spid) ?? []) el.animations.push(...anims.map((a) => ({ ...a })));
    }

    // Speaker notes.
    let notesText = '';
    const notesRel = pkg.relOfType(slidePath, '/notesSlide');
    const notesTree = notesRel ? pkg.xml(notesRel.target) : null;
    if (notesTree) {
      const body = kids(at(notesTree, 'p:cSld', 'p:spTree'), 'p:sp').find((sp) => phOf(sp)?.type === 'body');
      if (body) {
        notesText = kids(kid(body, 'p:txBody'), 'a:p')
          .map((p) =>
            kids(p)
              .map((c) => (c.tag === 'a:r' || c.tag === 'a:fld' ? textOf(kid(c, 'a:t')) : c.tag === 'a:br' ? '\n' : ''))
              .join(''),
          )
          .join('\n')
          .trim();
      }
    }

    const layoutType = layout?.tree.attrs.type ?? '';
    slides.push({
      hidden: tree.attrs.show === '0',
      layout: LAYOUTS[layoutType] ?? (elements.some((e) => e.kind === 'text' && e.role === 'title') ? 'title-body' : 'blank'),
      background,
      backgroundMedia,
      notes: notesText,
      transition: readTransition(tree, notes),
      elements,
    });
  }

  return {
    slideWidth: cx,
    slideHeight: cy,
    slides,
    media: (p) => (usedMedia.has(p) ? pkg.bytes(p) : null),
    notes: notes.list,
    fonts,
  };
}
