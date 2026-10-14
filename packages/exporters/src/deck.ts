import PptxGenJS from 'pptxgenjs';
import PDFDocument from 'pdfkit';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { ChartSpec } from '@omnix/core';
import { inlineToPlain, parseInline } from '@omnix/core';
import { CATEGORICAL, CHART_CHROME } from '@omnix/render';
import { splitByFont } from './fonts.js';

/**
 * Slideshow export. The server resolves every element to something a file format can hold
 * (text runs, pictures, simple shapes, native charts and tables, video) and these writers
 * turn that into PowerPoint or PDF. Coordinates are deck pixels.
 */

export interface DeckBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees clockwise. */
  rotation: number;
  opacity: number;
  /** Build animations with their click step resolved (0 = when the slide appears). */
  animations?: DeckAnimation[];
}

export interface DeckAnimation {
  kind: 'fade-in' | 'fly-in' | 'zoom-in' | 'fade-out' | 'fly-out' | 'pulse' | 'spin';
  step: number;
  /** Seconds after the step starts. */
  delay: number;
  duration: number;
}

export type DeckExportElement =
  | (DeckBox & {
      kind: 'text';
      /** Inline markdown; "- " and "1. " paragraphs are bullets. */
      text: string;
      fontFamily: string;
      monoFamily: string;
      /** Deck pixels. */
      fontSize: number;
      color: string;
      linkColor: string;
      align: 'left' | 'center' | 'right';
      valign: 'top' | 'middle' | 'bottom';
      bold: boolean;
      lineHeight: number;
    })
  | (DeckBox & { kind: 'image'; data: Buffer; mime: 'image/png' | 'image/jpeg'; alt: string })
  | (DeckBox & { kind: 'shape'; shape: 'rect' | 'ellipse' | 'line'; radius: number; fill: string | null; stroke: string | null; strokeWidth: number; flipH?: boolean; flipV?: boolean })
  | (DeckBox & { kind: 'chart'; spec: ChartSpec; dark: boolean; fontFamily: string })
  | (DeckBox & { kind: 'table'; columns: string[]; rows: (string | number | null)[][]; color: string; fontFamily: string; fontSize: number; dark: boolean })
  | (DeckBox & { kind: 'video'; data: Buffer; extn: string; poster: Buffer | null; name: string });

export interface DeckExportSlide {
  name: string;
  hidden: boolean;
  notes: string;
  background: string;
  elements: DeckExportElement[];
  transition?: { kind: 'none' | 'fade' | 'push' | 'wipe' | 'zoom'; duration: number } | null;
  /** The fully built slide as an image (PDF pages). */
  render?: { data: Buffer; mime: 'image/png' | 'image/jpeg' };
}

export interface DeckExportModel {
  name: string;
  author?: string;
  width: number;
  height: number;
  slides: DeckExportSlide[];
}

/** PowerPoint's widescreen width; height follows the deck's aspect ratio. */
const SLIDE_W_IN = 13.333333;

/** Hex color and transparency (0–100) for PowerPoint from #rgb, #rrggbb or #rrggbbaa. */
export function pptxColor(c: string): { color: string; transparency: number } {
  let h = c.replace('#', '').trim();
  if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
  const color = (h.slice(0, 6) || '000000').toUpperCase();
  const alpha = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { color, transparency: Math.round((1 - alpha) * 100) };
}

const b64 = (data: Buffer, mime: string) => `${mime};base64,${data.toString('base64')}`;

type TextRun = PptxGenJS.TextProps;

/** Inline markdown paragraphs to PowerPoint text runs (bullets, numbering, bold, italic, code, links). */
export function pptxTextRuns(el: Extract<DeckExportElement, { kind: 'text' }>, ptPerPx: number): TextRun[] {
  const out: TextRun[] = [];
  const paras = el.text.split('\n');
  let numberedRun = 0;
  paras.forEach((para, pi) => {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(para);
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(para);
    let text = para;
    // Same hanging indent as the slide renderer.
    const indent = Math.max(6, Math.round(el.fontSize * 1.2 * ptPerPx));
    let bulletOpt: PptxGenJS.TextPropsOptions['bullet'] = false;
    if (bullet) {
      text = bullet[1]!;
      bulletOpt = { indent };
      numberedRun = 0;
    } else if (numbered) {
      text = numbered[2]!;
      numberedRun += 1;
      bulletOpt = { type: 'number', indent, ...(numberedRun === 1 && numbered[1] !== '1' ? { numberStartAt: Number(numbered[1]) } : {}) };
    } else {
      numberedRun = 0;
    }
    const spans = parseInline(text);
    if (!spans.length) spans.push({ text: '' });
    spans.forEach((s, si) => {
      const options: NonNullable<TextRun['options']> = {};
      if (el.bold || s.bold) options.bold = true;
      if (s.italic) options.italic = true;
      if (s.strike) options.strike = 'sngStrike';
      if (s.code) options.fontFace = el.monoFamily;
      if (s.link) {
        options.hyperlink = { url: s.link };
        options.color = pptxColor(el.linkColor).color;
      }
      if (si === 0) {
        options.bullet = bulletOpt;
        options.align = el.align;
      }
      if (si === spans.length - 1 && pi < paras.length - 1) options.breakLine = true;
      out.push({ text: s.text, options });
    });
  });
  return out;
}

function chartColors(spec: ChartSpec, dark: boolean): string[] {
  const palette = CATEGORICAL[dark ? 'dark' : 'light'];
  const n = spec.type === 'pie' ? spec.labels.length : spec.series.length;
  return Array.from({ length: n }, (_, i) => pptxColor((spec.type === 'pie' ? undefined : spec.series[i]?.color) ?? palette[i % palette.length]!).color);
}

export async function deckToPptx(m: DeckExportModel): Promise<Buffer> {
  const pres = new PptxGenJS();
  const H_IN = (SLIDE_W_IN * m.height) / m.width;
  pres.defineLayout({ name: 'OMNIX', width: SLIDE_W_IN, height: H_IN });
  pres.layout = 'OMNIX';
  pres.title = m.name;
  pres.company = 'Omnix';
  if (m.author) pres.author = m.author;
  const inch = SLIDE_W_IN / m.width;
  const pt = 72 * inch;
  const box = (e: DeckBox) => ({ x: e.x * inch, y: e.y * inch, w: Math.max(0.01, e.w * inch), h: Math.max(0.01, e.h * inch), ...(e.rotation ? { rotate: ((e.rotation % 360) + 360) % 360 } : {}) });

  for (const s of m.slides) {
    const slide = pres.addSlide();
    slide.background = { color: pptxColor(s.background).color };
    if (s.hidden) slide.hidden = true;
    for (const e of s.elements) {
      const fade = Math.round((1 - Math.max(0, Math.min(1, e.opacity))) * 100);
      switch (e.kind) {
        case 'text': {
          const c = pptxColor(e.color);
          slide.addText(pptxTextRuns(e, pt), {
            ...box(e),
            fontFace: e.fontFamily,
            fontSize: Math.max(1, Math.round(e.fontSize * pt * 10) / 10),
            color: c.color,
            ...(fade || c.transparency ? { transparency: Math.min(100, fade + c.transparency) } : {}),
            valign: e.valign,
            margin: 0,
            lineSpacingMultiple: e.lineHeight,
            paraSpaceAfter: 0,
            paraSpaceBefore: 0,
            wrap: true,
          });
          break;
        }
        case 'image':
          slide.addImage({ data: b64(e.data, e.mime), ...box(e), ...(fade ? { transparency: fade } : {}), altText: e.alt });
          break;
        case 'shape': {
          const fill = e.fill ? pptxColor(e.fill) : null;
          const line = e.stroke && e.strokeWidth > 0 ? pptxColor(e.stroke) : null;
          const type = e.shape === 'ellipse' ? pres.ShapeType.ellipse : e.shape === 'line' ? pres.ShapeType.line : e.radius > 0 ? pres.ShapeType.roundRect : pres.ShapeType.rect;
          slide.addShape(type, {
            ...box(e),
            ...(e.shape === 'line' ? {} : { fill: fill ? { color: fill.color, transparency: Math.min(100, fill.transparency + fade) } : { type: 'none' } }),
            line: line ? { color: line.color, width: Math.max(0.25, e.strokeWidth * pt), transparency: Math.min(100, line.transparency + fade) } : { type: 'none' },
            ...(e.shape === 'rect' && e.radius > 0 ? { rectRadius: e.radius * inch } : {}),
            ...(e.flipH ? { flipH: true } : {}),
            ...(e.flipV ? { flipV: true } : {}),
          });
          break;
        }
        case 'chart': {
          const sp = e.spec;
          const chrome = CHART_CHROME[e.dark ? 'dark' : 'light'];
          const ink = pptxColor(chrome.secondary).color;
          const fontSize = Math.max(8, Math.round(Math.min(e.w, e.h) * 0.03 * pt));
          const type = sp.type as PptxGenJS.CHART_NAME;
          let data: { name: string; labels?: string[]; values: number[] }[];
          if (sp.type === 'scatter') {
            const numeric = sp.labels.length > 0 && sp.labels.every((l) => l.trim() !== '' && Number.isFinite(Number(l)));
            const n = Math.max(sp.labels.length, ...sp.series.map((x) => x.values.length));
            data = [{ name: sp.xLabel ?? 'X', values: Array.from({ length: n }, (_, i) => (numeric ? Number(sp.labels[i]) : i + 1)) }, ...sp.series.map((x) => ({ name: x.name, values: x.values }))];
          } else if (sp.type === 'pie') {
            data = sp.series.slice(0, 1).map((x) => ({ name: x.name, labels: sp.labels, values: x.values }));
          } else {
            data = sp.series.map((x) => ({ name: x.name, labels: sp.labels, values: x.values }));
          }
          slide.addChart(type, data, {
            ...box(e),
            chartColors: chartColors(sp, e.dark),
            showLegend: sp.type === 'pie' || sp.series.length > 1,
            legendPos: 'b',
            legendFontFace: e.fontFamily,
            legendFontSize: fontSize,
            legendColor: ink,
            showTitle: !!sp.title,
            ...(sp.title ? { title: sp.title, titleColor: pptxColor(chrome.ink).color, titleFontFace: e.fontFamily, titleFontSize: Math.round(fontSize * 1.3) } : {}),
            ...(sp.type === 'pie'
              ? { showPercent: true, dataLabelColor: 'FFFFFF', dataLabelFontSize: fontSize }
              : {
                  catAxisLabelColor: ink,
                  valAxisLabelColor: ink,
                  catAxisLabelFontFace: e.fontFamily,
                  valAxisLabelFontFace: e.fontFamily,
                  catAxisLabelFontSize: fontSize,
                  valAxisLabelFontSize: fontSize,
                  valGridLine: { color: pptxColor(chrome.grid).color, size: 0.75 },
                  catGridLine: { style: 'none' },
                  catAxisLineColor: pptxColor(chrome.axis).color,
                  valAxisLineShow: false,
                  ...(sp.xLabel ? { showCatAxisTitle: true, catAxisTitle: sp.xLabel, catAxisTitleColor: ink, catAxisTitleFontSize: fontSize } : {}),
                  ...(sp.yLabel ? { showValAxisTitle: true, valAxisTitle: sp.yLabel, valAxisTitleColor: ink, valAxisTitleFontSize: fontSize } : {}),
                }),
            ...(sp.type === 'bar' ? { barDir: 'col', barGapWidthPct: 60 } : {}),
            ...(sp.type === 'line' ? { lineSize: 2, lineDataSymbol: 'none' } : {}),
            ...(sp.type === 'scatter' ? { lineSize: 0, lineDataSymbol: 'circle', lineDataSymbolSize: 7 } : {}),
          });
          break;
        }
        case 'table': {
          const c = pptxColor(e.color).color;
          const border = { type: 'solid' as const, pt: 0.75, color: e.dark ? '44464E' : 'D9D8D2' };
          const fs = Math.max(6, Math.round(e.fontSize * pt));
          const rows: PptxGenJS.TableRow[] = [
            e.columns.map((col) => ({ text: col, options: { bold: true, color: c, border } })),
            ...e.rows.map((r) => e.columns.map((_, i) => ({ text: r[i] === null || r[i] === undefined ? '' : String(r[i]), options: { color: c, border, ...(typeof r[i] === 'number' ? { align: 'right' as const } : {}) } }))),
          ];
          slide.addTable(rows, { x: e.x * inch, y: e.y * inch, w: e.w * inch, fontFace: e.fontFamily, fontSize: fs, colW: e.columns.map(() => (e.w * inch) / Math.max(1, e.columns.length)), margin: 0.04, autoPage: false });
          break;
        }
        case 'video':
          slide.addMedia({ type: 'video', data: b64(e.data, `video/${e.extn}`), extn: e.extn, ...(e.poster ? { cover: b64(e.poster, 'image/png') } : {}), ...box(e), objectName: e.name });
          break;
      }
    }
    if (s.notes.trim()) slide.addNotes(s.notes);
  }
  const out = (await pres.write({ outputType: 'nodebuffer', compression: true })) as Buffer;
  return finishPptx(Buffer.from(out), m.slides);
}

const TRANSITION_XML: Record<string, string> = {
  fade: '<p:fade/>',
  push: '<p:push dir="l"/>',
  wipe: '<p:wipe dir="r"/>',
  zoom: '<p:zoom/>',
};

/** Slide transition element (speed buckets: PowerPoint's classic form has no exact duration). */
export function transitionXml(t: DeckExportSlide['transition']): string {
  if (!t || t.kind === 'none' || !TRANSITION_XML[t.kind]) return '';
  const spd = t.duration <= 0.5 ? 'fast' : t.duration <= 0.9 ? 'med' : 'slow';
  return `<p:transition spd="${spd}">${TRANSITION_XML[t.kind]}</p:transition>`;
}

const PRESETS: Record<DeckAnimation['kind'], { id: number; cls: 'entr' | 'exit' | 'emph'; sub: number }> = {
  'fade-in': { id: 10, cls: 'entr', sub: 0 },
  'fly-in': { id: 2, cls: 'entr', sub: 4 },
  'zoom-in': { id: 53, cls: 'entr', sub: 16 },
  'fade-out': { id: 10, cls: 'exit', sub: 0 },
  'fly-out': { id: 2, cls: 'exit', sub: 1 },
  pulse: { id: 26, cls: 'emph', sub: 0 },
  spin: { id: 8, cls: 'emph', sub: 0 },
};

/**
 * PowerPoint timing tree for build animations: one click group per step (step 0 starts with
 * the slide), effects in a step start together with their own delays. `spid` maps element
 * index to shape id.
 */
export function timingXml(elements: readonly DeckExportElement[], spid: (index: number) => number): string {
  let id = 2;
  const next = () => ++id;
  const steps = new Map<number, { el: number; a: DeckAnimation }[]>();
  elements.forEach((e, i) => {
    for (const a of e.animations ?? []) {
      if (!PRESETS[a.kind]) continue;
      const list = steps.get(a.step) ?? [];
      list.push({ el: i, a });
      steps.set(a.step, list);
    }
  });
  if (!steps.size) return '';
  const tgt = (s: number) => `<p:tgtEl><p:spTgt spid="${s}"/></p:tgtEl>`;
  const visibility = (s: number, val: 'visible' | 'hidden', delayMs: number) =>
    `<p:set><p:cBhvr><p:cTn id="${next()}" dur="1" fill="hold"><p:stCondLst><p:cond delay="${delayMs}"/></p:stCondLst></p:cTn>${tgt(s)}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="${val}"/></p:to></p:set>`;
  const anim = (s: number, attr: string, dur: number, from: string, to: string) =>
    `<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="${next()}" dur="${dur}" fill="hold"/>${tgt(s)}<p:attrNameLst><p:attrName>${attr}</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="${from}"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="${to}"/></p:val></p:tav></p:tavLst></p:anim>`;
  const behaviours = (a: DeckAnimation, s: number, dur: number): string => {
    switch (a.kind) {
      case 'fade-in':
        return visibility(s, 'visible', 0) + `<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="${next()}" dur="${dur}"/>${tgt(s)}</p:cBhvr></p:animEffect>`;
      case 'fly-in':
        return visibility(s, 'visible', 0) + anim(s, 'ppt_x', dur, '#ppt_x', '#ppt_x') + anim(s, 'ppt_y', dur, '1+#ppt_h/2', '#ppt_y');
      case 'zoom-in':
        return visibility(s, 'visible', 0) + anim(s, 'ppt_w', dur, '0', '#ppt_w') + anim(s, 'ppt_h', dur, '0', '#ppt_h') + `<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="${next()}" dur="${dur}"/>${tgt(s)}</p:cBhvr></p:animEffect>`;
      case 'fade-out':
        return `<p:animEffect transition="out" filter="fade"><p:cBhvr><p:cTn id="${next()}" dur="${dur}"/>${tgt(s)}</p:cBhvr></p:animEffect>` + visibility(s, 'hidden', Math.max(0, dur - 1));
      case 'fly-out':
        return anim(s, 'ppt_x', dur, '#ppt_x', '#ppt_x') + anim(s, 'ppt_y', dur, '#ppt_y', '0-#ppt_h/2') + visibility(s, 'hidden', Math.max(0, dur - 1));
      case 'spin':
        return `<p:animRot by="21600000"><p:cBhvr><p:cTn id="${next()}" dur="${dur}" fill="hold"/>${tgt(s)}<p:attrNameLst><p:attrName>r</p:attrName></p:attrNameLst></p:cBhvr></p:animRot>`;
      case 'pulse':
        return `<p:animScale><p:cBhvr><p:cTn id="${next()}" dur="${Math.max(1, Math.round(dur / 2))}" autoRev="1" fill="hold"/>${tgt(s)}</p:cBhvr><p:by x="108000" y="108000"/></p:animScale>`;
    }
  };
  let groups = '';
  for (const step of [...steps.keys()].sort((a, b) => a - b)) {
    const list = steps.get(step)!;
    const effects = list
      .map(({ el, a }, k) => {
        const p = PRESETS[a.kind];
        const nodeType = k > 0 ? 'withEffect' : step === 0 ? 'afterEffect' : 'clickEffect';
        const dur = Math.max(1, Math.round(a.duration * 1000));
        return `<p:par><p:cTn id="${next()}" presetID="${p.id}" presetClass="${p.cls}" presetSubtype="${p.sub}" fill="hold" grpId="0" nodeType="${nodeType}"><p:stCondLst><p:cond delay="${Math.round(a.delay * 1000)}"/></p:stCondLst><p:childTnLst>${behaviours(a, spid(el), dur)}</p:childTnLst></p:cTn></p:par>`;
      })
      .join('');
    groups += `<p:par><p:cTn id="${next()}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/>${step === 0 ? '<p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>' : ''}</p:stCondLst><p:childTnLst><p:par><p:cTn id="${next()}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${effects}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`;
  }
  // Text shapes animate as one object (not paragraph by paragraph).
  const animated = [...new Set([...steps.values()].flat().map((x) => x.el))];
  const textBuilds = animated.filter((el) => elements[el]!.kind === 'text').map((el) => `<p:bldP spid="${spid(el)}" grpId="0" animBg="1"/>`);
  return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${groups}</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst>${textBuilds.length ? `<p:bldLst>${textBuilds.join('')}</p:bldLst>` : ''}</p:timing>`;
}

/**
 * Finishing pass over the written package:
 * - pptxgenjs writes an `a:pPr` before every run of a multi-run paragraph, which is invalid
 *   (PowerPoint and LibreOffice then apply the last one, dropping bullets); keep only the
 *   paragraph's leading `a:pPr`.
 * - shape ids are renumbered so they are unique per slide (tables reuse ids otherwise).
 * - slide transitions and build animations are added (pptxgenjs has no API for them).
 */
function finishPptx(pptx: Buffer, slides: readonly DeckExportSlide[]): Buffer {
  const files = unzipSync(new Uint8Array(pptx));
  for (const [name, data] of Object.entries(files)) {
    const slideMatch = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
    if (!slideMatch && !/^ppt\/notesSlides\/[^/]+\.xml$/.test(name)) continue;
    let xml = fixParagraphXml(strFromU8(data));
    if (slideMatch) {
      const slide = slides[Number(slideMatch[1]) - 1];
      let n = 0;
      xml = xml.replace(/<p:cNvPr id="\d+"/g, () => `<p:cNvPr id="${++n}"`);
      if (slide) {
        // Element i is the (i + 2)th shape: id 1 is the slide's root group.
        const timing = n - 1 === slide.elements.length ? timingXml(slide.elements, (i) => i + 2) : '';
        const extra = transitionXml(slide.transition ?? null) + timing;
        if (extra) xml = xml.replace(/<\/p:sld>\s*$/, `${extra}</p:sld>`);
      }
    }
    files[name] = strToU8(xml);
  }
  return Buffer.from(zipSync(files, { level: 6 }));
}

function fixParagraphXml(xml: string): string {
  return xml.replace(/<a:p>([\s\S]*?)<\/a:p>/g, (_m, inner: string) => {
    const lead = /^<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/.exec(inner)?.[0] ?? '';
    const rest = inner.slice(lead.length).replace(/<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/g, '');
    return `<a:p>${lead}${rest}</a:p>`;
  });
}


/**
 * PDF: one page per visible slide with the built slide as a picture, plus an invisible
 * text layer so the PDF is searchable and screen readers can read it.
 * With `notes`, each page is a handout: the slide on top and its speaker notes below.
 */
export async function deckToPdf(m: DeckExportModel, options: { notes?: boolean } = {}): Promise<Buffer> {
  const W = 960;
  const H = (W * m.height) / m.width;
  const handout = !!options.notes;
  const pageW = handout ? 612 : W;
  const pageH = handout ? 792 : H;
  const doc = new PDFDocument({ size: [pageW, pageH], margin: 0, autoFirstPage: false, info: { Title: m.name, Creator: 'Omnix', ...(m.author ? { Author: m.author } : {}) } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const registered = new Set<string>();
  const write = (text: string, face: 'regular' | 'bold', size: number, x: number, y: number, width: number, opts: { opacity?: number; color?: string; align?: 'left' | 'center' | 'right'; lineGap?: number; height?: number } = {}) => {
    const runs = splitByFont(text, face);
    doc.fillColor(opts.color ?? '#000000', opts.opacity ?? 1);
    doc.fontSize(size);
    runs.forEach((r, i) => {
      if (!registered.has(r.font.key)) {
        doc.registerFont(r.font.key, r.font.path);
        registered.add(r.font.key);
      }
      doc.font(r.font.key);
      const last = i === runs.length - 1;
      if (i === 0) doc.text(r.text, x, y, { width, align: opts.align ?? 'left', lineGap: opts.lineGap ?? 0, continued: !last, ...(opts.height ? { height: opts.height, ellipsis: true } : {}) });
      else doc.text(r.text, { continued: !last });
    });
  };

  let index = 0;
  for (const s of m.slides) {
    if (s.hidden) continue;
    index += 1;
    doc.addPage({ size: [pageW, pageH], margin: 0 });
    const sx = handout ? 54 : 0;
    const sy = handout ? 54 : 0;
    const sw = handout ? pageW - 108 : W;
    const sh = (sw * m.height) / m.width;
    const k = sw / m.width;
    if (s.render) doc.image(s.render.data, sx, sy, { width: sw, height: sh });
    else doc.rect(sx, sy, sw, sh).fill(s.background);
    if (handout) doc.rect(sx, sy, sw, sh).lineWidth(0.5).strokeColor('#c3c2b7').stroke();
    // Invisible, selectable text over the picture.
    for (const e of s.elements) {
      if (e.kind !== 'text' || !e.text.trim()) continue;
      const plain = e.text
        .split('\n')
        .map((l) => inlineToPlain(l.replace(/^\s*[-*•]\s+/, '• ')))
        .join('\n');
      doc.save();
      if (e.rotation) doc.rotate(e.rotation, { origin: [sx + (e.x + e.w / 2) * k, sy + (e.y + e.h / 2) * k] });
      write(plain, e.bold ? 'bold' : 'regular', Math.max(1, e.fontSize * k), sx + e.x * k, sy + e.y * k, Math.max(1, e.w * k), { opacity: 0, align: e.align, lineGap: Math.max(0, e.fontSize * k * (e.lineHeight - 1.15)) });
      doc.restore();
    }
    if (handout) {
      write(`${index}. ${s.name}`, 'bold', 13, sx, sy + sh + 24, sw, { color: '#1d1f24' });
      const notes = s.notes.trim() || 'No speaker notes.';
      write(notes, 'regular', 11, sx, sy + sh + 46, sw, { color: s.notes.trim() ? '#2c2d31' : '#898781', lineGap: 3, height: pageH - (sy + sh + 46) - 54 });
    }
  }
  if (index === 0) {
    doc.addPage({ size: [pageW, pageH], margin: 0 });
    write('This presentation has no visible slides.', 'regular', 14, 40, 40, pageW - 80, { color: '#52514e' });
  }
  doc.end();
  return done;
}
