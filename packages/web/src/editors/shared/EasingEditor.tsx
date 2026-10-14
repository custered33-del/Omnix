import { useRef, useState } from 'react';
import type { Easing } from '@omnix/core';
import { sampleEasing } from '@omnix/core';

const PRESETS: { value: string; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'ease', label: 'Ease' },
  { value: 'ease-in', label: 'Ease in' },
  { value: 'ease-out', label: 'Ease out' },
  { value: 'ease-in-out', label: 'Ease in and out' },
  { value: 'back-out', label: 'Overshoot' },
  { value: 'bounce-out', label: 'Bounce' },
  { value: 'hold', label: 'Hold (step)' },
  { value: 'custom', label: 'Custom curve' },
];

const PRESET_BEZIER: Record<string, [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
};

/** Easing picker with a draggable cubic-bezier curve for custom timing. */
export function EasingEditor({ value, onChange, label = 'Easing' }: { value: Easing; onChange: (e: Easing) => void; label?: string }) {
  const isCustom = typeof value === 'object';
  const preset = isCustom ? 'custom' : value;
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="label">{label}</span>
        <select
          className="select sm"
          style={{ width: 150 }}
          aria-label={label}
          value={preset}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'custom') onChange({ bezier: PRESET_BEZIER[preset] ?? [0.33, 0, 0.2, 1] });
            else onChange(v as Easing);
          }}
        >
          {PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <CurvePreview easing={value} editable={isCustom} onChange={(b) => onChange({ bezier: b })} />
    </div>
  );
}

function CurvePreview({ easing, editable, onChange }: { easing: Easing; editable: boolean; onChange: (b: [number, number, number, number]) => void }) {
  const S = 120;
  const PAD = 18;
  const ref = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<0 | 1 | null>(null);
  const [draft, setDraft] = useState<[number, number, number, number] | null>(null);
  const b = draft ?? (typeof easing === 'object' ? easing.bezier : null);
  const shown: Easing = b ? { bezier: b } : easing;
  const pts = sampleEasing(shown, 40);
  // Y can overshoot (back-out), so map -0.25..1.25 onto the box.
  const X = (x: number) => PAD + x * S;
  const Y = (y: number) => PAD + (1 - (y + 0.25) / 1.5) * S;
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x)},${Y(y)}`).join('');
  const toVal = (e: React.PointerEvent): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * (S + PAD * 2);
    const sy = ((e.clientY - r.top) / r.height) * (S + PAD * 2);
    return [Math.min(1, Math.max(0, (sx - PAD) / S)), Math.round((1.25 - ((sy - PAD) / S) * 1.5) * 100) / 100];
  };
  return (
    <div className="curve-box">
      <svg
        ref={ref}
        viewBox={`0 0 ${S + PAD * 2} ${S + PAD * 2}`}
        width="100%"
        style={{ maxWidth: 200 }}
        role="img"
        aria-label={b ? `Custom curve ${b.map((v) => v.toFixed(2)).join(', ')}` : 'Easing curve'}
        onPointerMove={(e) => {
          if (dragging === null || !b) return;
          const [x, y] = toVal(e);
          const next = [...b] as [number, number, number, number];
          next[dragging * 2] = Math.round(x * 100) / 100;
          next[dragging * 2 + 1] = y;
          setDraft(next);
        }}
        onPointerUp={() => {
          if (draft) onChange(draft);
          setDraft(null);
          setDragging(null);
        }}
      >
        <rect x={PAD} y={Y(1)} width={S} height={Y(0) - Y(1)} className="curves-bg" />
        <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" />
        {editable && b && (
          <>
            <line x1={X(0)} y1={Y(0)} x2={X(b[0])} y2={Y(b[1])} stroke="var(--muted)" />
            <line x1={X(1)} y1={Y(1)} x2={X(b[2])} y2={Y(b[3])} stroke="var(--muted)" />
            {[0, 1].map((i) => (
              <circle
                key={i}
                cx={X(b[i * 2]!)}
                cy={Y(b[i * 2 + 1]!)}
                r={6}
                className="curves-pt"
                tabIndex={0}
                aria-label={`Handle ${i + 1}`}
                onPointerDown={(e) => {
                  setDragging(i as 0 | 1);
                  (ref.current as Element).setPointerCapture(e.pointerId);
                }}
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 0.1 : 0.02;
                  const next = [...b] as [number, number, number, number];
                  if (e.key === 'ArrowLeft') next[i * 2] = Math.max(0, next[i * 2]! - step);
                  else if (e.key === 'ArrowRight') next[i * 2] = Math.min(1, next[i * 2]! + step);
                  else if (e.key === 'ArrowUp') next[i * 2 + 1] = next[i * 2 + 1]! + step;
                  else if (e.key === 'ArrowDown') next[i * 2 + 1] = next[i * 2 + 1]! - step;
                  else return;
                  e.preventDefault();
                  onChange(next.map((v) => Math.round(v * 100) / 100) as [number, number, number, number]);
                }}
              />
            ))}
          </>
        )}
      </svg>
    </div>
  );
}
