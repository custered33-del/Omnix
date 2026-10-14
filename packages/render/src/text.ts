import { parseInline, pointAtLength, pathLength, type BezierPath } from '@omnix/core';
import type { Ctx2D } from './host.js';

export interface TextStyle {
  fontFamily: string;
  monoFamily?: string;
  fontSize: number;
  fontWeight: number;
  italic?: boolean;
  color: string;
  linkColor?: string;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  letterSpacing?: number;
}

interface Run {
  text: string;
  font: string;
  color: string;
  underline: boolean;
  strike: boolean;
  width: number;
  code: boolean;
}

export interface LaidOutLine {
  runs: (Run & { x: number })[];
  width: number;
  indent: number;
  bullet: string | null;
}

export function cssFont(style: { fontFamily: string; fontSize: number; fontWeight: number; italic?: boolean }): string {
  return `${style.italic ? 'italic ' : ''}${Math.round(style.fontWeight)} ${style.fontSize}px ${style.fontFamily}`;
}

function setLetterSpacing(ctx: Ctx2D, px: number): void {
  const c = ctx as unknown as { letterSpacing?: string };
  if (typeof c.letterSpacing === 'string') c.letterSpacing = `${px}px`;
}

/**
 * Lay out inline-markdown text into lines that fit `maxWidth`. Paragraphs are separated by
 * newlines; lines starting with "- " or "1. " become bullets with a hanging indent.
 */
export function layoutRichText(ctx: Ctx2D, source: string, style: TextStyle, maxWidth: number): LaidOutLine[] {
  const lines: LaidOutLine[] = [];
  const spacing = style.letterSpacing ?? 0;
  setLetterSpacing(ctx, spacing);
  for (const para of source.split('\n')) {
    let text = para;
    let bullet: string | null = null;
    const b = /^\s*[-*•]\s+(.*)$/.exec(para);
    const n = /^\s*(\d+)[.)]\s+(.*)$/.exec(para);
    if (b) {
      bullet = '•';
      text = b[1]!;
    } else if (n) {
      bullet = `${n[1]}.`;
      text = n[2]!;
    }
    const indent = bullet ? style.fontSize * 1.2 : 0;
    const avail = Math.max(10, maxWidth - indent);
    const spans = parseInline(text);
    // Split spans into words while keeping style.
    const words: Run[] = [];
    for (const s of spans) {
      const font = s.code
        ? cssFont({ fontFamily: style.monoFamily ?? 'monospace', fontSize: style.fontSize * 0.92, fontWeight: 400 })
        : cssFont({ fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: s.bold ? Math.max(700, style.fontWeight) : style.fontWeight, italic: style.italic || s.italic });
      const color = s.link !== undefined ? style.linkColor ?? style.color : style.color;
      for (const part of s.text.split(/(\s+)/)) {
        if (!part) continue;
        ctx.font = font;
        words.push({ text: part, font, color, underline: s.link !== undefined, strike: !!s.strike, width: ctx.measureText(part).width, code: !!s.code });
      }
    }
    let line: (Run & { x: number })[] = [];
    let x = 0;
    const flush = () => {
      // Trim trailing whitespace
      while (line.length && /^\s+$/.test(line[line.length - 1]!.text)) line.pop();
      const width = line.reduce((m, r) => Math.max(m, r.x + r.width), 0);
      lines.push({ runs: line, width, indent: lines.length && !line.length ? 0 : indent, bullet: null });
      line = [];
      x = 0;
    };
    const startIdx = lines.length;
    for (const w of words) {
      const isSpace = /^\s+$/.test(w.text);
      if (isSpace && line.length === 0) continue;
      if (!isSpace && x + w.width > avail && line.length) flush();
      if (!isSpace && w.width > avail) {
        // Break very long words by characters.
        let chunk = '';
        for (const ch of w.text) {
          ctx.font = w.font;
          const cw = ctx.measureText(chunk + ch).width;
          if (x + cw > avail && chunk) {
            line.push({ ...w, text: chunk, width: ctx.measureText(chunk).width, x });
            flush();
            chunk = ch;
          } else chunk += ch;
        }
        if (chunk) {
          ctx.font = w.font;
          const cw = ctx.measureText(chunk).width;
          line.push({ ...w, text: chunk, width: cw, x });
          x += cw;
        }
        continue;
      }
      line.push({ ...w, x });
      x += w.width;
    }
    flush();
    if (lines[startIdx]) {
      lines[startIdx]!.bullet = bullet;
      for (let i = startIdx; i < lines.length; i++) lines[i]!.indent = indent;
    }
  }
  setLetterSpacing(ctx, 0);
  return lines;
}

/** Draw laid-out rich text inside a box. Returns the height used. */
export function drawRichText(ctx: Ctx2D, source: string, style: TextStyle, x: number, y: number, width: number, options: { valign?: 'top' | 'middle' | 'bottom'; height?: number } = {}): number {
  const lines = layoutRichText(ctx, source, style, width);
  const lh = style.fontSize * style.lineHeight;
  const total = lines.length * lh;
  let top = y;
  if (options.height !== undefined) {
    if (options.valign === 'middle') top = y + (options.height - total) / 2;
    else if (options.valign === 'bottom') top = y + options.height - total;
  }
  ctx.save();
  setLetterSpacing(ctx, style.letterSpacing ?? 0);
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, i) => {
    const baseline = top + i * lh + (lh - style.fontSize) / 2 + style.fontSize * 0.82;
    const avail = width - line.indent;
    let left = x + line.indent;
    if (style.align === 'center') left = x + line.indent + (avail - line.width) / 2;
    else if (style.align === 'right') left = x + width - line.width;
    if (line.bullet) {
      ctx.font = cssFont(style);
      ctx.fillStyle = style.color;
      ctx.fillText(line.bullet, left - line.indent, baseline);
    }
    for (const r of line.runs) {
      ctx.font = r.font;
      ctx.fillStyle = r.color;
      ctx.fillText(r.text, left + r.x, baseline);
      if (r.underline || r.strike) {
        const yy = r.strike ? baseline - style.fontSize * 0.3 : baseline + Math.max(1, style.fontSize * 0.08);
        ctx.fillRect(left + r.x, yy, r.width, Math.max(1, style.fontSize * 0.06));
      }
    }
  });
  ctx.restore();
  return total;
}

/** Draw text along a bezier path, one glyph at a time, rotated to the path tangent. */
export function drawTextOnPath(ctx: Ctx2D, text: string, path: BezierPath, font: string, color: string, letterSpacing = 0, baselineShift = 0, align: 'left' | 'center' | 'right' = 'left'): void {
  const total = pathLength(path);
  if (total <= 0) return;
  ctx.save();
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  const widths = [...text].map((ch) => ctx.measureText(ch).width + letterSpacing);
  const textWidth = widths.reduce((a, b) => a + b, 0);
  let offset = align === 'center' ? (total - textWidth) / 2 : align === 'right' ? total - textWidth : 0;
  [...text].forEach((ch, i) => {
    const w = widths[i]!;
    const mid = offset + w / 2;
    if (mid >= 0 && mid <= total) {
      const p = pointAtLength(path, mid / total);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillText(ch, -w / 2 + letterSpacing / 2, -baselineShift);
      ctx.restore();
    }
    offset += w;
  });
  ctx.restore();
}

/** Measure the box a plain multi-line text needs (used for text layer bounds and hit testing). */
export function measureTextBlock(ctx: Ctx2D, text: string, style: TextStyle, boxWidth: number | null): { width: number; height: number } {
  const lines = layoutRichText(ctx, text.replace(/([*_`~[\]\\])/g, '\\$1'), style, boxWidth ?? 1e9);
  const lh = style.fontSize * style.lineHeight;
  return { width: Math.max(1, ...lines.map((l) => l.width + l.indent)), height: Math.max(lh, lines.length * lh) };
}
