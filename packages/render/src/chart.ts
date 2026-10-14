import type { ChartSpec } from '@omnix/core';
import type { Ctx2D } from './host.js';
import { roundedRectPath } from './shapes.js';

/**
 * Chart rendering for Code Grounds outputs, documents and slides.
 * Follows the Omnix data-viz rules: fixed-order categorical palette (validated for
 * color-vision deficiency on adjacent pairs), thin marks, 4px rounded data-ends,
 * 2px lines, hairline recessive grid, legend for 2+ series, text in ink colors only.
 */
export const CATEGORICAL = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
} as const;

export const CHART_CHROME = {
  light: { surface: '#fcfcfb', ink: '#0b0b0b', secondary: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7' },
  dark: { surface: '#1a1a19', ink: '#f0efec', secondary: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', axis: '#383835' },
} as const;

export interface ChartOptions {
  scheme?: 'light' | 'dark';
  fontFamily?: string;
  /** Scale typography with the chart (slides draw large). */
  fontScale?: number;
  /** Paint the chart surface behind the plot. */
  background?: boolean;
}

/** Compact tick labels: 1,200 -> 1.2K, 3,400,000 -> 3.4M. */
export function compactNumber(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${trim(v / 1e9)}B`;
  if (a >= 1e6) return `${trim(v / 1e6)}M`;
  if (a >= 1e3) return `${trim(v / 1e3)}K`;
  return trim(v);
}

function trim(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 2 : 1).replace(/\.?0+$/, '');
}

/** "Nice" axis ticks covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    max = min + 1;
    min = Math.min(0, min);
  }
  const span = max - min;
  const step0 = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}

export function seriesColor(spec: ChartSpec, index: number, scheme: 'light' | 'dark'): string {
  const own = spec.series[index]?.color;
  if (own) return own;
  const pal = CATEGORICAL[scheme];
  // Fixed order, never cycled: series past the eighth fold into a neutral "other" color.
  return index < pal.length ? pal[index]! : CHART_CHROME[scheme].muted;
}

/** Where the plot landed, for hover hit-testing (null for pie charts). */
export interface ChartGeometry {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Width of one category band. */
  band: number;
  count: number;
  yMin: number;
  yMax: number;
}

export function drawChart(ctx: Ctx2D, spec: ChartSpec, x: number, y: number, w: number, h: number, options: ChartOptions = {}): ChartGeometry | null {
  const scheme = options.scheme ?? 'light';
  const chrome = CHART_CHROME[scheme];
  const fs = Math.max(9, 12 * (options.fontScale ?? 1));
  const family = options.fontFamily ?? 'Inter, system-ui, sans-serif';
  const font = (size: number, weight = 400) => `${weight} ${size}px ${family}`;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  if (options.background !== false) {
    ctx.fillStyle = chrome.surface;
    ctx.fillRect(x, y, w, h);
  }
  const pad = fs * 1.2;
  let top = y + pad;
  if (spec.title) {
    ctx.font = font(fs * 1.25, 600);
    ctx.fillStyle = chrome.ink;
    ctx.textBaseline = 'top';
    ctx.fillText(spec.title, x + pad, top);
    top += fs * 1.9;
  }
  // Legend (2+ series): swatch + ink-colored label, one row above the plot.
  if (spec.series.length >= 2 && spec.type !== 'pie') {
    ctx.font = font(fs);
    ctx.textBaseline = 'middle';
    let lx = x + pad;
    let ly = top + fs * 0.6;
    spec.series.forEach((s, i) => {
      const label = s.name || `Series ${i + 1}`;
      const tw = ctx.measureText(label).width;
      if (lx + tw + fs * 2.5 > x + w - pad) {
        lx = x + pad;
        ly += fs * 1.6;
      }
      ctx.fillStyle = seriesColor(spec, i, scheme);
      ctx.beginPath();
      roundedRectPath(ctx, lx, ly - fs * 0.4, fs * 0.8, fs * 0.8, 2);
      ctx.fill();
      ctx.fillStyle = chrome.secondary;
      ctx.fillText(label, lx + fs * 1.2, ly);
      lx += tw + fs * 2.6;
    });
    top = ly + fs * 1.4;
  }
  if (spec.type === 'pie') {
    drawPie(ctx, spec, x + pad, top, w - pad * 2, y + h - pad - top, scheme, fs, family);
    ctx.restore();
    return null;
  }

  const values = spec.series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  const dataMin = Math.min(0, ...values);
  const dataMax = Math.max(0, ...values, 1e-9);
  const ticks = niceTicks(dataMin, dataMax, 5);
  const yMin = ticks[0]!;
  const yMax = ticks[ticks.length - 1]!;
  ctx.font = font(fs);
  const tickW = Math.max(...ticks.map((t) => ctx.measureText(compactNumber(t)).width));
  const left = x + pad + tickW + fs * 0.6 + (spec.yLabel ? fs * 1.4 : 0);
  const right = x + w - pad;
  const bottom = y + h - pad - fs * 1.6 - (spec.xLabel ? fs * 1.4 : 0);
  const plotH = Math.max(10, bottom - top);
  const plotW = Math.max(10, right - left);
  const yPos = (v: number) => bottom - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  // Grid + y ticks (hairline, solid, recessive).
  ctx.lineWidth = 1;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (const t of ticks) {
    const yy = Math.round(yPos(t)) + 0.5;
    ctx.strokeStyle = t === 0 ? chrome.axis : chrome.grid;
    ctx.beginPath();
    ctx.moveTo(left, yy);
    ctx.lineTo(right, yy);
    ctx.stroke();
    ctx.fillStyle = chrome.muted;
    ctx.fillText(compactNumber(t), left - fs * 0.6, yy);
  }
  if (spec.yLabel) {
    ctx.save();
    ctx.translate(x + pad + fs * 0.5, top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = chrome.secondary;
    ctx.fillText(spec.yLabel, 0, 0);
    ctx.restore();
  }

  const n = Math.max(1, spec.labels.length, ...spec.series.map((s) => s.values.length));
  const band = plotW / n;
  // X labels (skip some when crowded).
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = chrome.muted;
  const maxLabelW = Math.max(1, ...spec.labels.map((l) => ctx.measureText(l).width));
  const every = Math.max(1, Math.ceil((maxLabelW + fs) / band));
  spec.labels.forEach((l, i) => {
    if (i % every === 0) ctx.fillText(l, left + band * (i + 0.5), bottom + fs * 0.5);
  });
  if (spec.xLabel) {
    ctx.fillStyle = chrome.secondary;
    ctx.fillText(spec.xLabel, left + plotW / 2, bottom + fs * 2);
  }

  const baseY = yPos(Math.max(yMin, Math.min(0, yMax)));
  if (spec.type === 'bar') {
    const k = spec.series.length;
    const gap = 2;
    // Thin marks, but scaled with the chart's typography so big slide charts are not spindly.
    const maxBar = 24 * Math.max(1, options.fontScale ?? 1);
    const groupW = Math.min(band * 0.72, maxBar * k + gap * (k - 1));
    const barW = Math.max(2, Math.min(maxBar, (groupW - gap * (k - 1)) / k));
    spec.series.forEach((s, si) => {
      ctx.fillStyle = seriesColor(spec, si, scheme);
      s.values.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        const cx = left + band * (i + 0.5) - groupW / 2 + si * (barW + gap);
        const yv = yPos(v);
        const top2 = Math.min(yv, baseY);
        const hh = Math.abs(baseY - yv);
        ctx.beginPath();
        roundedDataEnd(ctx, cx, top2, barW, hh, v >= 0, 4);
        ctx.fill();
      });
    });
  } else {
    spec.series.forEach((s, si) => {
      const color = seriesColor(spec, si, scheme);
      const pts = s.values.map((v, i) => ({ x: left + band * (i + 0.5), y: yPos(v), ok: Number.isFinite(v) })).filter((p) => p.ok);
      if (!pts.length) return;
      if (spec.type === 'area') {
        ctx.beginPath();
        ctx.moveTo(pts[0]!.x, baseY);
        for (const p of pts) ctx.lineTo(p.x, p.y);
        ctx.lineTo(pts[pts.length - 1]!.x, baseY);
        ctx.closePath();
        ctx.globalAlpha = 0.1;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (spec.type !== 'scatter') {
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
      }
      const markerPts = spec.type === 'scatter' ? pts : [pts[pts.length - 1]!];
      for (const p of markerPts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4 + 2, 0, Math.PI * 2);
        ctx.fillStyle = chrome.surface; // 2px surface ring
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    });
    // Direct end labels for up to four line series (legend still present).
    if (spec.type !== 'scatter' && spec.series.length <= 4) {
      ctx.font = font(fs, 500);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = chrome.secondary;
      spec.series.forEach((s) => {
        const i = s.values.length - 1;
        const v = s.values[i];
        if (v === undefined || !Number.isFinite(v)) return;
        ctx.fillText(compactNumber(v), left + band * (i + 0.5), yPos(v) - 8);
      });
    }
  }
  ctx.restore();
  return { left, right, top, bottom, band, count: n, yMin, yMax };
}

/** A bar with a 4px rounded data-end and a square baseline end. */
function roundedDataEnd(ctx: Ctx2D, x: number, y: number, w: number, h: number, up: boolean, r: number): void {
  const rr = Math.min(r, w / 2, h);
  if (h <= 0) return;
  if (up) {
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h);
  } else {
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
  }
  ctx.closePath();
}

function drawPie(ctx: Ctx2D, spec: ChartSpec, x: number, y: number, w: number, h: number, scheme: 'light' | 'dark', fs: number, family: string): void {
  const chrome = CHART_CHROME[scheme];
  const values = (spec.series[0]?.values ?? []).map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = values.reduce((a, b) => a + b, 0);
  const legendW = Math.min(w * 0.4, 220 * (fs / 12));
  const r = Math.max(4, Math.min((w - legendW) / 2, h / 2) - 4);
  const cx = x + r + 2;
  const cy = y + h / 2;
  let a0 = -Math.PI / 2;
  const pal = CATEGORICAL[scheme];
  values.forEach((v, i) => {
    if (!total) return;
    const a1 = a0 + (v / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a1);
    ctx.closePath();
    ctx.fillStyle = i < pal.length ? pal[i]! : chrome.muted;
    ctx.fill();
    ctx.strokeStyle = chrome.surface; // 2px surface gap between slices
    ctx.lineWidth = 2;
    ctx.stroke();
    a0 = a1;
  });
  ctx.font = `400 ${fs}px ${family}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const lx = cx + r + fs * 1.5;
  spec.labels.forEach((label, i) => {
    const ly = y + fs + i * fs * 1.7;
    if (ly > y + h) return;
    ctx.fillStyle = i < pal.length ? pal[i]! : chrome.muted;
    ctx.beginPath();
    roundedRectPath(ctx, lx, ly - fs * 0.4, fs * 0.8, fs * 0.8, 2);
    ctx.fill();
    ctx.fillStyle = chrome.secondary;
    const pct = total ? Math.round(((values[i] ?? 0) / total) * 100) : 0;
    ctx.fillText(`${label} · ${pct}%`, lx + fs * 1.2, ly);
  });
}
