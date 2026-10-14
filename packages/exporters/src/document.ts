import PDFDocument from 'pdfkit';
import {
  AlignmentType,
  BorderStyle,
  CheckBox,
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  DeletedTextRun,
  Document as DocxDocument,
  ExternalHyperlink,
  Footer,
  ImageRun,
  InsertedTextRun,
  LevelFormat,
  LineRuleType,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type ParagraphChild,
} from 'docx';
import type { BlockProps, StyleSheet, TextStyle } from '@omnix/core';
import { blocksToMarkdown, defaultStyleFor, escapeHtml, inlineToHtml, inlineToPlain, listNumber, parseInline, type InlineSpan } from '@omnix/core';
import { splitByFont, type FontFace } from './fonts.js';

/**
 * Document exports: Markdown, standalone HTML, PDF (real, selectable text with embedded fonts
 * and bookmarks) and Word (styles, lists, tables, images, comments and tracked changes).
 * The caller resolves images and live links into the media below, so exporters stay pure.
 */

export interface ResolvedMedia {
  png: Buffer;
  width: number;
  height: number;
  alt: string;
}

export type ResolvedEmbed =
  | { kind: 'image'; media: ResolvedMedia }
  | { kind: 'table'; columns: string[]; rows: (string | number | null)[][] }
  | { kind: 'text'; text: string }
  | { kind: 'missing'; label: string };

export interface ExportBlock extends BlockProps {
  id: string;
  /** Image blocks: the picture. */
  media?: ResolvedMedia | null;
  /** Embed blocks: the live content as it is right now. */
  embedded?: ResolvedEmbed | null;
}

export interface ExportComment {
  id: string;
  blockId: string;
  quote: string;
  author: string;
  date: string;
  text: string;
  replies: { author: string; date: string; text: string }[];
}

export interface ExportSuggestion {
  id: string;
  blockId: string;
  kind: 'replace' | 'insert-after' | 'delete';
  text: string;
  author: string;
  date: string;
}

export interface DocumentModel {
  name: string;
  pageSize: 'a4' | 'letter';
  styles: StyleSheet;
  blocks: ExportBlock[];
  comments: ExportComment[];
  suggestions: ExportSuggestion[];
}

const styleFor = (m: DocumentModel, b: Pick<BlockProps, 'blockType' | 'level' | 'style'>): TextStyle => m.styles[defaultStyleFor(b)] ?? m.styles.body ?? { fontFamily: 'Inter', fontSize: 15, fontWeight: 400, color: '#1d1f24', lineHeight: 1.5, spaceBefore: 0, spaceAfter: 10 };

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

/** Markdown plus the image files it references (images/…png). */
export function documentToMarkdown(m: DocumentModel): { markdown: string; images: { name: string; data: Buffer }[]; notes: string[] } {
  const images: { name: string; data: Buffer }[] = [];
  const notes: string[] = [];
  const addImage = (media: ResolvedMedia) => {
    const name = `images/image-${images.length + 1}.png`;
    images.push({ name, data: media.png });
    return name;
  };
  const md: Partial<BlockProps>[] = [];
  for (const b of m.blocks) {
    if (b.blockType === 'image') {
      if (b.media) md.push({ blockType: 'paragraph', text: `![${(b.caption ?? b.media.alt).replace(/[[\]]/g, '')}](${addImage(b.media)})` });
    } else if (b.blockType === 'embed') {
      const e = b.embedded;
      if (!e || e.kind === 'missing') md.push({ blockType: 'paragraph', text: `*${e?.label ?? 'Linked content unavailable'}*` });
      else if (e.kind === 'image') md.push({ blockType: 'paragraph', text: `![${e.media.alt.replace(/[[\]]/g, '')}](${addImage(e.media)})` });
      else if (e.kind === 'table') md.push({ blockType: 'table', text: '', rows: [e.columns, ...e.rows.map((r) => r.map((v) => (v === null ? '' : String(v))))] });
      else md.push({ blockType: 'code', text: e.text, language: 'text' });
    } else md.push(b);
  }
  if (m.blocks.some((b) => b.blockType === 'embed')) notes.push('Live links were exported as they look right now.');
  if (m.suggestions.length) notes.push(`${m.suggestions.length} open suggestions were not included. Accept them first to export them.`);
  return { markdown: `${blocksToMarkdown(md).trim()}\n`, images, notes };
}

/* ------------------------------------------------------------------ */
/* HTML                                                                */
/* ------------------------------------------------------------------ */

function cssStyle(s: TextStyle): string {
  return `font-family:"${s.fontFamily}",Inter,system-ui,sans-serif;font-size:${s.fontSize}px;font-weight:${s.fontWeight};color:${s.color};line-height:${s.lineHeight};margin:${s.spaceBefore}px 0 ${s.spaceAfter}px;${s.italic ? 'font-style:italic;' : ''}`;
}

const dataUri = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;

/** A self-contained HTML file (images inlined) that looks like the document. */
export function documentToHtml(m: DocumentModel): string {
  const out: string[] = [];
  let listStack: { tag: 'ul' | 'ol'; level: number }[] = [];
  const closeLists = (toLevel = -1) => {
    while (listStack.length && listStack[listStack.length - 1]!.level > toLevel) out.push(`</${listStack.pop()!.tag}>`);
  };
  for (const b of m.blocks) {
    const isList = b.blockType === 'bullet' || b.blockType === 'numbered' || b.blockType === 'todo';
    if (isList) {
      const tag = b.blockType === 'numbered' ? 'ol' : 'ul';
      const level = b.level ?? 0;
      const top = listStack[listStack.length - 1];
      if (top && top.level > level) closeLists(level);
      const cur = listStack[listStack.length - 1];
      if (cur && cur.level === level && cur.tag !== tag) closeLists(level - 1);
      if (!listStack.length || listStack[listStack.length - 1]!.level < level) {
        out.push(`<${tag}${b.blockType === 'todo' ? ' class="todo"' : ''}>`);
        listStack.push({ tag, level });
      }
      const box = b.blockType === 'todo' ? `<input type="checkbox" disabled${b.checked ? ' checked' : ''} aria-label="${b.checked ? 'Done' : 'Not done'}"> ` : '';
      const ls = styleFor(m, b);
      out.push(`<li style="${cssStyle({ ...ls, spaceBefore: 0, spaceAfter: 4 })}">${box}${inlineToHtml(b.text)}</li>`);
      continue;
    }
    closeLists();
    const st = cssStyle(styleFor(m, b));
    switch (b.blockType) {
      case 'heading': {
        const l = Math.min(6, Math.max(1, b.level ?? 1));
        out.push(`<h${l} style="${st}">${inlineToHtml(b.text)}</h${l}>`);
        break;
      }
      case 'quote':
        out.push(`<blockquote style="${st}">${inlineToHtml(b.text)}</blockquote>`);
        break;
      case 'code':
        out.push(`<pre style="${st}"><code${b.language ? ` class="language-${escapeHtml(b.language)}"` : ''}>${escapeHtml(b.text)}</code></pre>`);
        break;
      case 'divider':
        out.push('<hr>');
        break;
      case 'table':
        out.push(htmlTable((b.rows ?? [])[0] ?? [], (b.rows ?? []).slice(1), true));
        break;
      case 'image':
        if (b.media) out.push(`<figure><img src="${dataUri(b.media.png)}" alt="${escapeHtml(b.caption || b.media.alt)}" width="${b.media.width}" height="${b.media.height}">${b.caption ? `<figcaption>${escapeHtml(b.caption)}</figcaption>` : ''}</figure>`);
        break;
      case 'embed': {
        const e = b.embedded;
        if (!e || e.kind === 'missing') out.push(`<p class="missing">${escapeHtml(e?.label ?? 'Linked content unavailable')}</p>`);
        else if (e.kind === 'image') out.push(`<figure><img src="${dataUri(e.media.png)}" alt="${escapeHtml(e.media.alt)}" width="${e.media.width}" height="${e.media.height}"></figure>`);
        else if (e.kind === 'table') out.push(htmlTable(e.columns, e.rows.map((r) => r.map((v) => (v === null ? '' : String(v)))), false));
        else out.push(`<pre><code>${escapeHtml(e.text)}</code></pre>`);
        break;
      }
      default:
        out.push(b.text.trim() ? `<p style="${st}">${inlineToHtml(b.text)}</p>` : '<p>&nbsp;</p>');
    }
  }
  closeLists();
  const body = m.styles.body;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(m.name)}</title>
<style>
  body { margin: 0; background: #f4f3ef; color: ${body?.color ?? '#1d1f24'}; font-family: Inter, system-ui, sans-serif; }
  main { max-width: ${m.pageSize === 'letter' ? 816 : 794}px; margin: 32px auto; background: #fff; padding: 72px 84px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  @media (max-width: 860px) { main { margin: 0; padding: 32px 20px; } }
  img { max-width: 100%; height: auto; }
  figure { margin: 16px 0; text-align: center; }
  figcaption { font-size: 13px; color: #6b7280; margin-top: 6px; }
  blockquote { border-left: 3px solid #d6d3cc; padding-left: 14px; }
  pre { background: #f6f5f1; padding: 12px 14px; border-radius: 8px; overflow-x: auto; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 13px; }
  code { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: .9em; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-variant-numeric: tabular-nums; }
  th, td { border: 1px solid #e3e1db; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f6f5f1; }
  ul.todo { list-style: none; padding-left: 4px; }
  hr { border: none; border-top: 1px solid #d6d3cc; margin: 20px 0; }
  a { color: #2a5bd7; }
  .missing { color: #8a8f99; font-style: italic; }
</style>
</head>
<body>
<main>
${out.join('\n')}
</main>
</body>
</html>
`;
}

function htmlTable(head: string[], rows: string[][], inline: boolean): string {
  const cell = (v: string) => (inline ? inlineToHtml(v) : escapeHtml(v));
  return `<table><thead><tr>${head.map((h) => `<th scope="col">${cell(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${cell(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */

const PX = 0.75; // CSS px to PDF points
const PAGE = { a4: [595.28, 841.89] as [number, number], letter: [612, 792] as [number, number] };

type PdfDoc = InstanceType<typeof PDFDocument>;

interface PdfCtx {
  doc: PdfDoc;
  registered: Set<string>;
  left: number;
  width: number;
}

function faceOf(span: InlineSpan, base: TextStyle): FontFace {
  if (span.code) return 'mono';
  const bold = span.bold || base.fontWeight >= 600;
  const italic = span.italic || !!base.italic;
  return bold && italic ? 'boldItalic' : bold ? 'bold' : italic ? 'italic' : 'regular';
}

/** Write rich text (inline markdown) at the current position, wrapping inside [x, x + width]. */
function pdfRich(c: PdfCtx, text: string, style: TextStyle, x: number, width: number, opts: { color?: string; align?: 'left' | 'center' } = {}): void {
  const { doc } = c;
  const size = style.fontSize * PX;
  const spans = parseInline(text);
  const pieces: { font: string; path: string; text: string; link?: string; strike?: boolean; code?: boolean }[] = [];
  for (const s of spans) {
    for (const run of splitByFont(s.text, faceOf(s, style))) pieces.push({ font: run.font.key, path: run.font.path, text: run.text, ...(s.link ? { link: s.link } : {}), ...(s.strike ? { strike: true } : {}), ...(s.code ? { code: true } : {}) });
  }
  if (!pieces.length) {
    doc.moveDown(0.0001);
    doc.y += size * style.lineHeight;
    return;
  }
  const lineGap = Math.max(0, size * (style.lineHeight - 1.15));
  pieces.forEach((p, i) => {
    if (!c.registered.has(p.font)) {
      doc.registerFont(p.font, p.path);
      c.registered.add(p.font);
    }
    doc.font(p.font).fontSize(p.code ? size * 0.9 : size);
    doc.fillColor(p.link ? '#2a5bd7' : (opts.color ?? style.color));
    const last = i === pieces.length - 1;
    const o = { continued: !last, width, lineGap, align: opts.align ?? 'left', ...(p.link && /^(https?:|mailto:)/i.test(p.link) ? { link: p.link, underline: true } : { link: null, underline: false }), strike: !!p.strike };
    if (i === 0) doc.text(p.text, x, doc.y, o);
    else doc.text(p.text, o);
  });
}

function ensureSpace(c: PdfCtx, h: number): void {
  const { doc } = c;
  if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function pdfTable(c: PdfCtx, head: string[], rows: string[][], body: TextStyle): void {
  const { doc } = c;
  const cols = Math.max(head.length, ...rows.map((r) => r.length), 1);
  const colW = c.width / cols;
  const pad = 5;
  const small: TextStyle = { ...body, fontSize: Math.min(body.fontSize, 14), lineHeight: 1.3, spaceBefore: 0, spaceAfter: 0 };
  const rowHeight = (r: string[], bold: boolean) => {
    let h = 0;
    for (let i = 0; i < cols; i++) {
      const runs = splitByFont(inlineToPlain(r[i] ?? ''), bold ? 'bold' : 'regular');
      const f = runs[0]?.font;
      if (f && !c.registered.has(f.key)) {
        doc.registerFont(f.key, f.path);
        c.registered.add(f.key);
      }
      if (f) doc.font(f.key);
      doc.fontSize(small.fontSize * PX);
      h = Math.max(h, doc.heightOfString(inlineToPlain(r[i] ?? '') || ' ', { width: colW - pad * 2 }));
    }
    return h + pad * 2;
  };
  const drawRow = (r: string[], header: boolean) => {
    const h = rowHeight(r, header);
    ensureSpace(c, h);
    const y = doc.y;
    if (header) doc.save().rect(c.left, y, c.width, h).fill('#f3f2ee').restore();
    for (let i = 0; i < cols; i++) {
      doc.save().lineWidth(0.5).strokeColor('#d6d3cc').rect(c.left + i * colW, y, colW, h).stroke().restore();
      doc.y = y + pad;
      pdfRich(c, header ? `**${r[i] ?? ''}**`.replace(/^\*\*\*\*$/, '') : (r[i] ?? ''), small, c.left + i * colW + pad, colW - pad * 2);
    }
    doc.y = y + h;
  };
  drawRow(head, true);
  for (const r of rows) drawRow(r, false);
  doc.y += 8;
  doc.x = c.left;
}

function pdfImage(c: PdfCtx, media: ResolvedMedia, caption: string | undefined, captionStyle: TextStyle): void {
  const { doc } = c;
  const maxH = (doc.page.height - doc.page.margins.top - doc.page.margins.bottom) * 0.7;
  const scale = Math.min(1, c.width / (media.width * PX), maxH / (media.height * PX));
  const w = media.width * PX * scale;
  const h = media.height * PX * scale;
  ensureSpace(c, h + 24);
  doc.image(media.png, c.left + (c.width - w) / 2, doc.y, { width: w, height: h });
  doc.y += h + 6;
  if (caption) {
    pdfRich(c, caption, { ...captionStyle, italic: false }, c.left, c.width, { align: 'center' });
  }
  doc.y += 6;
}

/** PDF with embedded fonts, real text, clickable links, heading bookmarks and page numbers. */
export async function documentToPdf(m: DocumentModel): Promise<Buffer> {
  const [W, H] = PAGE[m.pageSize] ?? PAGE.a4;
  const margin = 64;
  const doc = new PDFDocument({ size: [W, H], margins: { top: margin, bottom: margin, left: margin, right: margin }, bufferPages: true, info: { Title: m.name, Creator: 'Omnix' }, displayTitle: true, lang: 'en', pdfVersion: '1.7' });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const c: PdfCtx = { doc, registered: new Set(), left: margin, width: W - margin * 2 };
  const outlineStack: { level: number; item: { addItem(t: string): unknown } }[] = [];
  const blocks = m.blocks;
  blocks.forEach((b, i) => {
    const st = styleFor(m, b);
    const listy = (x?: BlockProps) => !!x && (x.blockType === 'bullet' || x.blockType === 'numbered' || x.blockType === 'todo');
    const before = listy(b) && listy(blocks[i - 1]) ? 0 : st.spaceBefore * PX;
    const after = (listy(b) && listy(blocks[i + 1]) ? Math.min(st.spaceAfter, 4) : st.spaceAfter) * PX;
    if (i > 0) doc.y += before;
    switch (b.blockType) {
      case 'heading': {
        ensureSpace(c, st.fontSize * PX * 3);
        const level = b.level ?? 1;
        while (outlineStack.length && outlineStack[outlineStack.length - 1]!.level >= level) outlineStack.pop();
        const parent = outlineStack[outlineStack.length - 1]?.item ?? (doc.outline as unknown as { addItem(t: string): unknown });
        const item = parent.addItem(inlineToPlain(b.text) || 'Heading') as { addItem(t: string): unknown };
        outlineStack.push({ level, item });
        pdfRich(c, b.text, st, c.left, c.width);
        break;
      }
      case 'bullet':
      case 'numbered':
      case 'todo': {
        const indent = 18 + (b.level ?? 0) * 18;
        const y0 = doc.y;
        const size = st.fontSize * PX;
        if (b.blockType === 'todo') {
          doc.save().lineWidth(0.8).strokeColor('#6b7280').rect(c.left + indent - 14, y0 + size * 0.15, size * 0.75, size * 0.75).stroke();
          if (b.checked) doc.moveTo(c.left + indent - 12, y0 + size * 0.5).lineTo(c.left + indent - 9, y0 + size * 0.8).lineTo(c.left + indent - 4, y0 + size * 0.25).stroke();
          doc.restore();
        } else {
          const marker = b.blockType === 'bullet' ? '•' : `${listNumber(blocks, i)}.`;
          pdfRich(c, marker, { ...st, italic: false }, c.left + indent - 18, 16);
          doc.y = y0;
        }
        pdfRich(c, b.text, st, c.left + indent, c.width - indent);
        break;
      }
      case 'quote': {
        const y0 = doc.y;
        pdfRich(c, b.text, st, c.left + 14, c.width - 14);
        doc.save().lineWidth(2).strokeColor('#d6d3cc').moveTo(c.left + 2, y0).lineTo(c.left + 2, doc.y).stroke().restore();
        break;
      }
      case 'code': {
        const runs = splitByFont('M', 'mono');
        const f = runs[0]!.font;
        if (!c.registered.has(f.key)) {
          doc.registerFont(f.key, f.path);
          c.registered.add(f.key);
        }
        doc.font(f.key).fontSize(st.fontSize * PX);
        const h = doc.heightOfString(b.text || ' ', { width: c.width - 20 }) + 16;
        ensureSpace(c, Math.min(h, 200));
        doc.save().roundedRect(c.left, doc.y, c.width, h, 4).fill('#f6f5f1').restore();
        const y0 = doc.y;
        doc.y += 8;
        for (const line of (b.text || ' ').split('\n')) pdfRich(c, `\`${line.replace(/`/g, "'") || ' '}\``, { ...st, fontSize: st.fontSize / 0.9 }, c.left + 10, c.width - 20);
        doc.y = Math.max(doc.y, y0 + h) + 2;
        break;
      }
      case 'divider':
        ensureSpace(c, 20);
        doc.y += 8;
        doc.save().lineWidth(0.6).strokeColor('#d6d3cc').moveTo(c.left, doc.y).lineTo(c.left + c.width, doc.y).stroke().restore();
        doc.y += 10;
        break;
      case 'table':
        pdfTable(c, (b.rows ?? [])[0] ?? [], (b.rows ?? []).slice(1), styleFor(m, { blockType: 'paragraph' }));
        break;
      case 'image':
        if (b.media) pdfImage(c, b.media, b.caption, m.styles.caption ?? st);
        break;
      case 'embed': {
        const e = b.embedded;
        if (!e || e.kind === 'missing') pdfRich(c, `*${e?.label ?? 'Linked content unavailable'}*`, st, c.left, c.width, { color: '#8a8f99' });
        else if (e.kind === 'image') pdfImage(c, e.media, undefined, st);
        else if (e.kind === 'table') pdfTable(c, e.columns, e.rows.map((r) => r.map((v) => (v === null ? '' : String(v)))), styleFor(m, { blockType: 'paragraph' }));
        else pdfRich(c, `\`${e.text.slice(0, 4000).replace(/`/g, "'")}\``, st, c.left, c.width);
        break;
      }
      default:
        pdfRich(c, b.text, st, c.left, c.width);
    }
    doc.x = c.left;
    doc.y += after;
  });
  // Page numbers.
  const range = doc.bufferedPageRange();
  const footer = splitByFont('0123456789 /', 'regular')[0]!.font;
  if (!c.registered.has(footer.key)) doc.registerFont(footer.key, footer.path);
  for (let p = range.start; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font(footer.key).fontSize(9).fillColor('#8a8f99').text(`${p + 1} / ${range.count}`, 0, H - 36, { width: W, align: 'center', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}

/* ------------------------------------------------------------------ */
/* Word (DOCX)                                                         */
/* ------------------------------------------------------------------ */

const halfPt = (px: number) => Math.round(px * PX * 2);
const twips = (px: number) => Math.round(px * PX * 20);
const docxColor = (c: string) => c.replace('#', '').slice(0, 6).toUpperCase();
const CONTENT_PX = { a4: 590, letter: 610 };

function docxRuns(text: string, base: TextStyle, revision?: { kind: 'ins' | 'del'; id: number; author: string; date: string }): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const s of parseInline(text)) {
    const opts = {
      text: s.text,
      bold: s.bold || base.fontWeight >= 600 || undefined,
      italics: s.italic || base.italic || undefined,
      strike: s.strike || undefined,
      ...(s.code ? { font: 'JetBrains Mono', shading: { type: ShadingType.CLEAR, fill: 'F1F0EC', color: 'auto' } } : {}),
    };
    if (revision) {
      out.push(revision.kind === 'ins' ? new InsertedTextRun({ ...opts, id: revision.id, author: revision.author, date: revision.date }) : new DeletedTextRun({ ...opts, id: revision.id, author: revision.author, date: revision.date }));
      continue;
    }
    if (s.link && /^(https?:|mailto:)/i.test(s.link)) out.push(new ExternalHyperlink({ link: s.link, children: [new TextRun({ ...opts, style: 'Hyperlink' })] }));
    else out.push(new TextRun(opts));
  }
  return out;
}

const STYLE_IDS: Record<string, string> = { title: 'Title', h1: 'Heading1', h2: 'Heading2', h3: 'Heading3', body: 'Normal', quote: 'Quote', code: 'Code', caption: 'Caption' };

/** Word document with styles, lists, tables, images, comments and tracked changes for open suggestions. */
export async function documentToDocx(m: DocumentModel): Promise<Buffer> {
  const paragraphStyles = Object.entries(m.styles).map(([key, s]) => ({
    id: STYLE_IDS[key] ?? key,
    name: key === 'body' ? 'Normal' : (STYLE_IDS[key] ?? key),
    basedOn: key === 'body' ? undefined : 'Normal',
    next: 'Normal',
    quickFormat: true,
    run: { font: s.fontFamily, size: halfPt(s.fontSize), bold: s.fontWeight >= 600, italics: !!s.italic, color: docxColor(s.color) },
    paragraph: { spacing: { before: twips(s.spaceBefore), after: twips(s.spaceAfter), line: Math.round(240 * s.lineHeight), lineRule: LineRuleType.AUTO } },
  }));
  let revisionId = 1;
  const commentIds = new Map<string, number>();
  m.comments.forEach((c, i) => commentIds.set(c.id, i));
  const children: (Paragraph | Table)[] = [];
  let numberedInstance = 0;
  let prevNumbered = false;

  const styleId = (b: BlockProps) => STYLE_IDS[defaultStyleFor(b)] ?? defaultStyleFor(b);
  const withComments = (b: ExportBlock, runs: ParagraphChild[]): ParagraphChild[] => {
    const cs = m.comments.filter((c) => c.blockId === b.id);
    if (!cs.length) return runs;
    const ids = cs.map((c) => commentIds.get(c.id)!);
    return [...ids.map((id) => new CommentRangeStart(id)), ...runs, ...ids.map((id) => new CommentRangeEnd(id)), ...ids.map((id) => new TextRun({ children: [new CommentReference(id)] }))];
  };
  const blockRuns = (b: ExportBlock): ParagraphChild[] => {
    const st = styleFor(m, b);
    const sug = m.suggestions.find((s) => s.blockId === b.id && s.kind !== 'insert-after');
    if (sug?.kind === 'replace') return [...docxRuns(b.text, st, { kind: 'del', id: revisionId++, author: sug.author, date: sug.date }), ...docxRuns(sug.text, st, { kind: 'ins', id: revisionId++, author: sug.author, date: sug.date })];
    if (sug?.kind === 'delete') return docxRuns(b.text, st, { kind: 'del', id: revisionId++, author: sug.author, date: sug.date });
    return docxRuns(b.text, st);
  };
  const image = (media: ResolvedMedia, caption?: string) => {
    const scale = Math.min(1, CONTENT_PX[m.pageSize] / media.width);
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60, line: 240, lineRule: LineRuleType.AUTO }, children: [new ImageRun({ type: 'png', data: media.png, transformation: { width: Math.round(media.width * scale), height: Math.round(media.height * scale) }, altText: { name: media.alt, description: caption ?? media.alt, title: media.alt } })] }));
    if (caption) children.push(new Paragraph({ style: 'Caption', alignment: AlignmentType.CENTER, children: [new TextRun(caption)] }));
  };
  const table = (head: string[], rows: string[][]) => {
    const cols = Math.max(head.length, ...rows.map((r) => r.length), 1);
    const border = { style: BorderStyle.SINGLE, size: 4, color: 'D6D3CC' };
    const mk = (r: string[], header: boolean) =>
      new TableRow({
        tableHeader: header,
        children: Array.from({ length: cols }, (_, i) => new TableCell({ width: { size: Math.floor(100 / cols), type: WidthType.PERCENTAGE }, borders: { top: border, bottom: border, left: border, right: border }, ...(header ? { shading: { type: ShadingType.CLEAR, fill: 'F3F2EE', color: 'auto' } } : {}), children: [new Paragraph({ children: docxRuns(header ? `**${r[i] ?? ''}**`.replace(/^\*\*\*\*$/, '') : (r[i] ?? ''), styleFor(m, { blockType: 'paragraph' })) })] })),
      });
    children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [mk(head, true), ...rows.map((r) => mk(r, false))] }));
    children.push(new Paragraph({ children: [] }));
  };

  const listy = (x?: BlockProps) => !!x && (x.blockType === 'bullet' || x.blockType === 'numbered' || x.blockType === 'todo');
  for (const [bi, b] of m.blocks.entries()) {
    const isNumbered = b.blockType === 'numbered';
    const listSpacing = listy(b) ? { spacing: { before: listy(m.blocks[bi - 1]) ? 0 : twips(styleFor(m, b).spaceBefore), after: listy(m.blocks[bi + 1]) ? 60 : twips(styleFor(m, b).spaceAfter), line: Math.round(240 * styleFor(m, b).lineHeight), lineRule: LineRuleType.AUTO } } : {};
    if (isNumbered && !prevNumbered) numberedInstance++;
    prevNumbered = isNumbered || ((b.blockType === 'bullet' || b.blockType === 'todo') && prevNumbered && (b.level ?? 0) > 0);
    const base: Partial<IParagraphOptions> = { style: styleId(b) };
    switch (b.blockType) {
      case 'heading':
      case 'paragraph':
      case 'quote':
        children.push(new Paragraph({ ...base, ...(b.blockType === 'quote' ? { indent: { left: 360 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'D6D3CC', space: 8 } } } : {}), children: withComments(b, blockRuns(b)) }));
        break;
      case 'bullet':
        children.push(new Paragraph({ ...base, ...listSpacing, numbering: { reference: 'bullets', level: Math.min(4, b.level ?? 0) }, children: withComments(b, blockRuns(b)) }));
        break;
      case 'numbered':
        children.push(new Paragraph({ ...base, ...listSpacing, numbering: { reference: 'numbers', level: Math.min(4, b.level ?? 0), instance: numberedInstance }, children: withComments(b, blockRuns(b)) }));
        break;
      case 'todo':
        children.push(new Paragraph({ ...base, ...listSpacing, indent: { left: 360 }, children: withComments(b, [new CheckBox({ checked: !!b.checked }), new TextRun(' '), ...blockRuns(b)]) }));
        break;
      case 'code': {
        const lines = b.text.split('\n');
        children.push(new Paragraph({ style: 'Code', shading: { type: ShadingType.CLEAR, fill: 'F6F5F1', color: 'auto' }, children: lines.map((l, i) => new TextRun({ text: l, font: 'JetBrains Mono', ...(i ? { break: 1 } : {}) })) }));
        break;
      }
      case 'divider':
        children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D6D3CC', space: 4 } }, children: [] }));
        break;
      case 'table':
        table((b.rows ?? [])[0] ?? [], (b.rows ?? []).slice(1));
        break;
      case 'image':
        if (b.media) image(b.media, b.caption);
        break;
      case 'embed': {
        const e = b.embedded;
        if (!e || e.kind === 'missing') children.push(new Paragraph({ children: [new TextRun({ text: e?.label ?? 'Linked content unavailable', italics: true, color: '8A8F99' })] }));
        else if (e.kind === 'image') image(e.media);
        else if (e.kind === 'table') table(e.columns, e.rows.map((r) => r.map((v) => (v === null ? '' : String(v)))));
        else children.push(new Paragraph({ style: 'Code', children: e.text.split('\n').map((l, i) => new TextRun({ text: l, font: 'JetBrains Mono', ...(i ? { break: 1 } : {}) })) }));
        break;
      }
    }
    // Suggested new paragraphs become tracked insertions after their block.
    for (const s of m.suggestions.filter((x) => x.blockId === b.id && x.kind === 'insert-after')) {
      children.push(new Paragraph({ style: 'Normal', children: docxRuns(s.text || ' ', styleFor(m, { blockType: 'paragraph' }), { kind: 'ins', id: revisionId++, author: s.author, date: s.date }) }));
    }
  }

  const levels = (format: (typeof LevelFormat)[keyof typeof LevelFormat], texts: string[]) =>
    texts.map((text, level) => ({ level, format, text, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } } }));
  const docx = new DocxDocument({
    title: m.name,
    creator: 'Omnix',
    styles: { paragraphStyles: paragraphStyles as never },
    numbering: {
      config: [
        { reference: 'bullets', levels: levels(LevelFormat.BULLET, ['•', '◦', '▪', '•', '◦']) },
        { reference: 'numbers', levels: levels(LevelFormat.DECIMAL, ['%1.', '%2.', '%3.', '%4.', '%5.']) },
      ],
    },
    comments: {
      children: m.comments.map((c) => ({
        id: commentIds.get(c.id)!,
        author: c.author,
        date: new Date(c.date),
        children: [new Paragraph({ children: [new TextRun(c.text)] }), ...c.replies.map((r) => new Paragraph({ children: [new TextRun({ text: `${r.author}: `, bold: true }), new TextRun(r.text)] }))],
      })),
    },
    sections: [
      {
        properties: { page: { size: m.pageSize === 'letter' ? { width: 12240, height: 15840 } : { width: 11906, height: 16838 }, margin: { top: 1280, bottom: 1280, left: 1280, right: 1280 } } },
        footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], size: 18, color: '8A8F99' })] })] }) },
        children,
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(docx));
}
