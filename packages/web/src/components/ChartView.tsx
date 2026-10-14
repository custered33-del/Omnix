import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BarChart3, Table2 } from 'lucide-react';
import type { ChartSpec } from '@omnix/core';
import { CATEGORICAL, compactNumber, drawChart, type ChartGeometry } from '@omnix/render';
import { t } from '../i18n/index.js';

function scheme(): 'light' | 'dark' {
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme === 'dark') return 'dark';
  if (theme === 'light' || theme === 'high-contrast') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Plain-language summary for screen readers. */
export function describeChart(spec: ChartSpec): string {
  const kind = { bar: 'Bar chart', line: 'Line chart', area: 'Area chart', scatter: 'Scatter plot', pie: 'Pie chart' }[spec.type];
  const series = spec.series.map((s) => s.name).filter(Boolean);
  const all = spec.series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  const range = all.length ? ` Values range from ${compactNumber(Math.min(...all))} to ${compactNumber(Math.max(...all))}.` : '';
  return `${kind}${spec.title ? `: ${spec.title}` : ''}. ${spec.labels.length} categories${series.length ? `, series ${series.join(', ')}` : ''}.${range} Switch to the table view for exact values.`;
}

/**
 * Interactive chart: hover shows a tooltip (with a crosshair on line and area charts), and a
 * table view gives exact values. Rendering is shared with exports, documents and slides.
 */
export function ChartView({ spec, height = 280, initialView = 'chart' }: { spec: ChartSpec; height?: number; initialView?: 'chart' | 'table' }) {
  const [view, setView] = useState(initialView);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const geo = useRef<ChartGeometry | null>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !width || view !== 'chart') return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    c.style.height = `${height}px`;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    geo.current = drawChart(g as never, spec, 0, 0, width, height, { scheme: scheme(), fontFamily: '"Inter Variable", Inter, system-ui, sans-serif' });
    const G = geo.current;
    if (hover && G && (spec.type === 'line' || spec.type === 'area')) {
      const x = Math.round(G.left + G.band * (hover.i + 0.5)) + 0.5;
      g.strokeStyle = scheme() === 'dark' ? '#5a5955' : '#c3c2b7';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, G.top);
      g.lineTo(x, G.bottom);
      g.stroke();
    }
  }, [spec, width, height, view, hover?.i]);

  const onMove = (e: React.PointerEvent) => {
    const G = geo.current;
    if (!G) return;
    const r = canvas.current!.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    // Hit area is the whole band, wider than the mark.
    if (mx < G.left || mx > G.right || my < G.top - 10 || my > G.bottom + 10) return setHover(null);
    const i = Math.min(G.count - 1, Math.max(0, Math.floor((mx - G.left) / G.band)));
    if (hover?.i !== i) setHover({ i, x: mx, y: my });
    else setHover({ i, x: mx, y: my });
  };

  const colors = CATEGORICAL[scheme()];
  return (
    <figure className="chart-box" style={{ margin: 0 }}>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 2, marginBottom: 4 }}>
        <div className="segmented" role="group" aria-label="Chart view">
          <button aria-pressed={view === 'chart'} onClick={() => setView('chart')} aria-label={t('code.showChart')}>
            <BarChart3 size={14} />
          </button>
          <button aria-pressed={view === 'table'} onClick={() => setView('table')} aria-label={t('code.showTable')}>
            <Table2 size={14} />
          </button>
        </div>
      </div>
      {view === 'chart' ? (
        <div ref={wrap} style={{ position: 'relative' }}>
          <canvas ref={canvas} role="img" aria-label={describeChart(spec)} onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
          {hover && geo.current && spec.type !== 'pie' && (
            <div className="chart-tip" style={{ left: Math.min(hover.x + 12, Math.max(0, width - 180)), top: Math.max(0, hover.y - 12) }} role="status">
              <div style={{ fontWeight: 600, marginBottom: 2 }}>{spec.labels[hover.i] ?? `#${hover.i + 1}`}</div>
              {spec.series.map((s, si) => (
                <div key={si} className="row" style={{ gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color ?? colors[si % colors.length], display: 'inline-block' }} />
                  <span>{s.name || `Series ${si + 1}`}</span>
                  <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{Number.isFinite(s.values[hover.i]) ? s.values[hover.i]!.toLocaleString() : '—'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table" style={{ width: '100%' }}>
            {spec.title && <caption className="sr-only">{spec.title}</caption>}
            <thead>
              <tr>
                <th scope="col">{spec.xLabel ?? ''}</th>
                {spec.series.map((s, i) => (
                  <th key={i} scope="col" className="num">
                    {s.name || `Series ${i + 1}`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {spec.labels.map((l, i) => (
                <tr key={i}>
                  <th scope="row" style={{ fontWeight: 500 }}>
                    {l}
                  </th>
                  {spec.series.map((s, si) => (
                    <td key={si} className="num">
                      {Number.isFinite(s.values[i]) ? s.values[i]!.toLocaleString() : '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {spec.title && view === 'table' && <figcaption className="muted" style={{ fontSize: 'var(--fs-xs)', marginTop: 4 }}>{spec.title}</figcaption>}
    </figure>
  );
}
