import type { BlockProps, BlockType, EmbedRef } from './nodes.js';

/**
 * Markdown is the lingua franca between humans, Claude and the document editor.
 * Blocks store inline markdown; whole documents convert to and from Markdown.
 */

export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: string;
}

const EMBED_KINDS: EmbedRef['kind'][] = ['cell-output', 'asset', 'chart', 'canvas', 'sequence-frame', 'slide'];

/** Parse inline markdown into styled spans. */
export function parseInline(src: string): InlineSpan[] {
  const out: InlineSpan[] = [];
  const push = (span: InlineSpan) => {
    if (!span.text) return;
    const prev = out[out.length - 1];
    if (prev && sameStyle(prev, span)) prev.text += span.text;
    else out.push(span);
  };
  const walk = (s: string, style: Omit<InlineSpan, 'text'>) => {
    let i = 0;
    let buf = '';
    const flush = () => {
      if (buf) push({ ...style, text: buf });
      buf = '';
    };
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === '\\' && i + 1 < s.length) {
        buf += s[i + 1];
        i += 2;
        continue;
      }
      if (ch === '`') {
        const end = s.indexOf('`', i + 1);
        if (end > i) {
          flush();
          push({ ...style, code: true, text: s.slice(i + 1, end) });
          i = end + 1;
          continue;
        }
      }
      if (s.startsWith('**', i) || s.startsWith('__', i)) {
        const marker = s.slice(i, i + 2);
        let end = s.indexOf(marker, i + 2);
        // In "***" the inner single marker closes first: "**a *b***" -> bold(a, italic(b)).
        while (end > 0 && s[end + 2] === marker[0]) end++;
        if (end > i + 2) {
          flush();
          walk(s.slice(i + 2, end), { ...style, bold: true });
          i = end + 2;
          continue;
        }
      }
      if (s.startsWith('~~', i)) {
        const end = s.indexOf('~~', i + 2);
        if (end > i + 2) {
          flush();
          walk(s.slice(i + 2, end), { ...style, strike: true });
          i = end + 2;
          continue;
        }
      }
      if ((ch === '*' || ch === '_') && s[i + 1] !== ch && s[i + 1] !== ' ') {
        const end = findClosing(s, ch, i + 1);
        if (end > i + 1) {
          flush();
          walk(s.slice(i + 1, end), { ...style, italic: true });
          i = end + 1;
          continue;
        }
      }
      if (ch === '[') {
        const close = s.indexOf('](', i);
        const paren = close >= 0 ? s.indexOf(')', close + 2) : -1;
        if (close > i && paren > close) {
          flush();
          walk(s.slice(i + 1, close), { ...style, link: s.slice(close + 2, paren) });
          i = paren + 1;
          continue;
        }
      }
      buf += ch;
      i++;
    }
    flush();
  };
  walk(src, {});
  return out;
}

function findClosing(s: string, ch: string, from: number): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\') {
      j++;
      continue;
    }
    if (s[j] === ch && s[j - 1] !== ' ' && s[j + 1] !== ch) return j;
  }
  return -1;
}

function sameStyle(a: InlineSpan, b: InlineSpan): boolean {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.code === !!b.code && !!a.strike === !!b.strike && a.link === b.link;
}

/** Strip inline markdown, leaving plain text. */
export function inlineToPlain(src: string): string {
  return parseInline(src)
    .map((s) => s.text)
    .join('');
}

/** Escape characters that would otherwise start inline formatting. */
export function escapeInline(text: string): string {
  return text.replace(/([\\*_`~[\]])/g, '\\$1');
}

const SPAN_KEYS = ['link', 'bold', 'italic', 'strike', 'code'] as const;

/** Keep whitespace outside the markers so "**bold **" never appears. */
function wrapMarkers(inner: string, open: string, close: string): string {
  const lead = /^\s*/.exec(inner)![0];
  const trail = /\s*$/.exec(inner)![0];
  const core = inner.slice(lead.length, inner.length - trail.length);
  return core ? `${lead}${open}${core}${close}${trail}` : inner;
}

/** Styled spans back to inline markdown (the inverse of parseInline). Used by importers. */
export function spansToInline(spans: readonly InlineSpan[]): string {
  const render = (list: readonly InlineSpan[], depth: number): string => {
    const key = SPAN_KEYS[depth];
    if (!key) return list.map((s) => escapeInline(s.text)).join('');
    let out = '';
    let i = 0;
    while (i < list.length) {
      const v = list[i]![key];
      let j = i + 1;
      while (j < list.length && list[j]![key] === v) j++;
      const group = list.slice(i, j);
      if (!v) out += render(group, depth + 1);
      else if (key === 'code') out += wrapMarkers(group.map((s) => s.text.replace(/`/g, '')).join(''), '`', '`');
      else if (key === 'link') out += wrapMarkers(render(group, depth + 1), '[', `](${String(v).replace(/[()\s]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : '%20'))})`);
      else {
        const m = key === 'bold' ? '**' : key === 'italic' ? '*' : '~~';
        out += wrapMarkers(render(group, depth + 1), m, m);
      }
      i = j;
    }
    return out;
  };
  return render(spans, 0);
}

/** Escape HTML special characters. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Render inline markdown as safe HTML. Links are restricted to http(s), mailto and in-app anchors. */
export function inlineToHtml(src: string): string {
  return parseInline(src)
    .map((s) => {
      let h = escapeHtml(s.text);
      if (s.code) h = `<code>${h}</code>`;
      if (s.bold) h = `<strong>${h}</strong>`;
      if (s.italic) h = `<em>${h}</em>`;
      if (s.strike) h = `<s>${h}</s>`;
      if (s.link !== undefined) {
        const safe = /^(https?:|mailto:|#|\/)/i.test(s.link) ? s.link : '#';
        h = `<a href="${escapeHtml(safe)}">${h}</a>`;
      }
      return h;
    })
    .join('');
}

/* ------------------------------------------------------------------ */
/* Block-level                                                         */
/* ------------------------------------------------------------------ */

export type BlockInput = Partial<BlockProps> & { blockType: BlockType; text: string };

/** Parse a Markdown document into document blocks. */
export function markdownToBlocks(md: string): BlockInput[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: BlockInput[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ blockType: 'paragraph', text: para.join(' ').trim() });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      continue;
    }
    const fence = /^(```|~~~)\s*([\w+-]*)\s*$/.exec(trimmed);
    if (fence) {
      flushPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      blocks.push({ blockType: 'code', text: body.join('\n'), language: fence[2] || 'text' });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushPara();
      blocks.push({ blockType: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara();
      blocks.push({ blockType: 'divider', text: '' });
      continue;
    }
    const image = /^!\[([^\]]*)\]\(asset:([^)\s]+)\)$/.exec(trimmed);
    if (image) {
      flushPara();
      blocks.push({ blockType: 'image', text: '', assetId: image[2]!, caption: image[1]! });
      continue;
    }
    const embed = /^!embed\[([\w-]+)\]\(([^)\s]+?)(?:@([\d.]+))?\)$/.exec(trimmed);
    if (embed && (EMBED_KINDS as string[]).includes(embed[1]!)) {
      flushPara();
      const ref: EmbedRef = { kind: embed[1] as EmbedRef['kind'], ref: embed[2]! };
      if (embed[3]) ref.time = Number(embed[3]);
      blocks.push({ blockType: 'embed', text: '', embed: ref });
      continue;
    }
    if (trimmed.startsWith('>')) {
      flushPara();
      const quote: string[] = [trimmed.replace(/^>\s?/, '')];
      while (i + 1 < lines.length && lines[i + 1]!.trim().startsWith('>')) quote.push(lines[++i]!.trim().replace(/^>\s?/, ''));
      blocks.push({ blockType: 'quote', text: quote.join(' ') });
      continue;
    }
    const todo = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(trimmed);
    if (todo) {
      flushPara();
      blocks.push({ blockType: 'todo', text: todo[2]!, checked: todo[1]!.toLowerCase() === 'x' });
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushPara();
      blocks.push({ blockType: 'bullet', text: bullet[1]!, level: indentLevel(line) });
      continue;
    }
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (numbered) {
      flushPara();
      blocks.push({ blockType: 'numbered', text: numbered[1]!, level: indentLevel(line) });
      continue;
    }
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1]!.trim())) {
      flushPara();
      const rows: string[][] = [splitRow(trimmed)];
      i += 1; // skip separator
      while (i + 1 < lines.length && lines[i + 1]!.trim().startsWith('|')) rows.push(splitRow(lines[++i]!.trim()));
      blocks.push({ blockType: 'table', text: '', rows });
      continue;
    }
    para.push(trimmed);
  }
  flushPara();
  return blocks;
}

function indentLevel(line: string): number {
  const spaces = /^(\s*)/.exec(line)![1]!.replace(/\t/g, '  ').length;
  return Math.min(4, Math.floor(spaces / 2));
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** Serialize blocks back to Markdown. */
export function blocksToMarkdown(blocks: readonly Partial<BlockProps>[]): string {
  const out: string[] = [];
  let numberedIndex = 0;
  let prevType: BlockType | undefined;
  for (const b of blocks) {
    const type = b.blockType ?? 'paragraph';
    if (type !== 'numbered') numberedIndex = 0;
    const indent = '  '.repeat(b.level && (type === 'bullet' || type === 'numbered') ? b.level : 0);
    const listLike = type === 'bullet' || type === 'numbered' || type === 'todo';
    const prevListLike = prevType === 'bullet' || prevType === 'numbered' || prevType === 'todo';
    if (out.length && !(listLike && prevListLike)) out.push('');
    switch (type) {
      case 'heading':
        out.push(`${'#'.repeat(Math.min(6, Math.max(1, b.level ?? 1)))} ${b.text ?? ''}`);
        break;
      case 'paragraph':
        out.push(b.text ?? '');
        break;
      case 'bullet':
        out.push(`${indent}- ${b.text ?? ''}`);
        break;
      case 'numbered':
        numberedIndex += 1;
        out.push(`${indent}${numberedIndex}. ${b.text ?? ''}`);
        break;
      case 'todo':
        out.push(`- [${b.checked ? 'x' : ' '}] ${b.text ?? ''}`);
        break;
      case 'quote':
        out.push(`> ${b.text ?? ''}`);
        break;
      case 'code':
        out.push('```' + (b.language && b.language !== 'text' ? b.language : ''), b.text ?? '', '```');
        break;
      case 'divider':
        out.push('---');
        break;
      case 'image':
        out.push(`![${b.caption ?? ''}](asset:${b.assetId ?? ''})`);
        break;
      case 'embed':
        if (b.embed) out.push(`!embed[${b.embed.kind}](${b.embed.ref}${b.embed.time !== undefined ? '@' + b.embed.time : ''})`);
        break;
      case 'table': {
        const rows = b.rows ?? [];
        if (rows.length) {
          const cols = Math.max(...rows.map((r) => r.length));
          const pad = (r: string[]) => Array.from({ length: cols }, (_, i) => r[i] ?? '');
          out.push(`| ${pad(rows[0]!).join(' | ')} |`);
          out.push(`| ${Array.from({ length: cols }, () => '---').join(' | ')} |`);
          for (const r of rows.slice(1)) out.push(`| ${pad(r).join(' | ')} |`);
        }
        break;
      }
    }
    prevType = type;
  }
  return out.join('\n') + '\n';
}
