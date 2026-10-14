import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Trash2, Plus, Eye, EyeOff, Link2, Unlink2, AlignLeft, AlignCenter, AlignRight, Italic, Bold, Eraser } from 'lucide-react';
import type { Adjustment, FilterKind, LayerProps, SceneNode, SmartFilter, VectorShape } from '@omnix/core';
import { curveLut, FILTER_DEFAULTS } from '@omnix/imaging';
import { useProject } from '../../state/project.js';
import { ColorField, Dialog, IconButton, MenuButton, NumberField, Select, Switch } from '../../ui/primitives.js';
import { AssetPicker } from '../../components/AssetPicker.js';
import { t } from '../../i18n/index.js';
import * as A from './actions.js';
import { FontSelect } from '../shared/FontSelect.js';

const FILTERS: FilterKind[] = ['gaussianBlur', 'sharpen', 'noise', 'pixelate', 'grayscale', 'sepia', 'vignette', 'emboss', 'edgeDetect'];

/** Parameter ranges for smart filter controls. */
const FILTER_PARAMS: Record<string, { min: number; max: number; step?: number; label: string }> = {
  radius: { min: 0.5, max: 60, step: 0.5, label: 'Radius' },
  amount: { min: 0, max: 2, step: 0.05, label: t('adjust.amount') },
  size: { min: 2, max: 64, label: t('image.size') },
  seed: { min: 1, max: 999, label: 'Seed' },
};

/** Live-edit helper: sliders preview with transient props and commit once on release. */
function useLayerEdit(ctx: A.ImageCtx, id: string) {
  const s = ctx.store.getState();
  return {
    input: (set: Partial<LayerProps>) => s.setTransient(id, set as Record<string, unknown>),
    commit: (set: Partial<LayerProps>, label: string) => {
      s.setTransient(id, set as Record<string, unknown>);
      s.commitTransient(label);
    },
  };
}

export function PropertiesPanel({ ctx }: { ctx: A.ImageCtx }) {
  const selectedId = useStore(ctx.ed, (s) => s.selectedLayerId);
  const layer = useProject((s) => (selectedId ? s.state?.nodes[selectedId] : undefined)) as SceneNode<'layer'> | undefined;
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  if (!layer) return <CanvasSettings ctx={ctx} canEdit={canEdit} />;
  const p = layer.props;
  return (
    <fieldset disabled={!canEdit || p.locked} className="props-fieldset">
      <legend className="sr-only">{t('image.properties')}</legend>
      {p.locked && <p className="muted inspector-note">This layer is locked. Unlock it in the layers list to edit.</p>}
      {!['adjustment', 'fill', 'group'].includes(p.layerType) && <TransformSection ctx={ctx} layer={layer} />}
      {p.layerType === 'text' && <TextSection ctx={ctx} layer={layer} />}
      {p.layerType === 'vector' && <ShapeSection ctx={ctx} layer={layer} />}
      {p.layerType === 'fill' && (
        <section className="inspector-section">
          <h3>{t('image.fill')}</h3>
          <ColorField label={t('image.color')} value={p.fillColor ?? '#ffffff'} onInput={(v) => ctx.store.getState().setTransient(layer.id, { fillColor: v })} onChange={(v) => A.updateLayer(ctx, layer.id, { fillColor: v }, 'Change fill color')} />
        </section>
      )}
      {p.layerType === 'raster' && <RasterSection ctx={ctx} layer={layer} />}
      {p.layerType === 'adjustment' && p.adjustment && <AdjustmentSection ctx={ctx} layer={layer} adj={p.adjustment} />}
      <MaskSection ctx={ctx} layer={layer} />
      {!['adjustment', 'group'].includes(p.layerType) && <FiltersSection ctx={ctx} layer={layer} />}
    </fieldset>
  );
}

/* ---------------- canvas ---------------- */

function CanvasSettings({ ctx, canEdit }: { ctx: A.ImageCtx; canEdit: boolean }) {
  const canvas = useProject((s) => s.state?.nodes[ctx.canvasId]) as SceneNode<'canvas'>;
  const [resizeOpen, setResizeOpen] = useState(false);
  const cp = canvas.props;
  return (
    <fieldset disabled={!canEdit} className="props-fieldset">
      <section className="inspector-section">
        <h3>Canvas</h3>
        <div className="row" style={{ justifyContent: 'space-between', fontSize: 'var(--fs-sm)' }}>
          <span className="muted">{t('image.canvasSize')}</span>
          <span className="tabular">
            {cp.width} × {cp.height} px
          </span>
        </div>
        <button className="btn btn-sm" onClick={() => setResizeOpen(true)}>
          {t('image.canvasSize')}…
        </button>
        <Switch
          checked={cp.background === null}
          onChange={(v) => ctx.store.getState().commit({ kind: 'update', id: ctx.canvasId, set: { background: v ? null : '#ffffff' } }, 'Change background')}
          label={t('export.transparent')}
        />
        {cp.background !== null && (
          <ColorField label="Background" value={cp.background} onChange={(v) => ctx.store.getState().commit({ kind: 'update', id: ctx.canvasId, set: { background: v } }, 'Change background')} />
        )}
        <Select
          label={t('export.colorProfile')}
          value={cp.colorProfile}
          options={[
            { value: 'srgb', label: 'sRGB' },
            { value: 'display-p3', label: 'Display P3' },
          ]}
          onChange={(v) => ctx.store.getState().commit({ kind: 'update', id: ctx.canvasId, set: { colorProfile: v } }, 'Change color profile')}
        />
        <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
          {t('image.noLayer')}
        </p>
      </section>
      {resizeOpen && <CanvasSizeDialog ctx={ctx} width={cp.width} height={cp.height} onClose={() => setResizeOpen(false)} />}
    </fieldset>
  );
}

function CanvasSizeDialog({ ctx, width, height, onClose }: { ctx: A.ImageCtx; width: number; height: number; onClose: () => void }) {
  const [w, setW] = useState(width);
  const [h, setH] = useState(height);
  const [anchor, setAnchor] = useState({ x: 0.5, y: 0.5 });
  return (
    <Dialog
      title={t('image.canvasSize')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('app.cancel')}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              void A.resizeCanvas(ctx, Math.round(w), Math.round(h), anchor);
              onClose();
            }}
          >
            {t('app.apply')}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 16 }}>
        <div className="row" style={{ gap: 12 }}>
          <NumberField label="Width" value={w} min={1} max={16384} slider={false} unit="px" onCommit={setW} />
          <NumberField label="Height" value={h} min={1} max={16384} slider={false} unit="px" onCommit={setH} />
        </div>
        <div className="col" style={{ gap: 6 }}>
          <span className="label">Anchor</span>
          <div className="anchor-grid" role="radiogroup" aria-label="Anchor">
            {[0, 0.5, 1].flatMap((y) =>
              [0, 0.5, 1].map((x) => (
                <button key={`${x}-${y}`} role="radio" aria-checked={anchor.x === x && anchor.y === y} aria-label={`${['Top', 'Middle', 'Bottom'][y * 2]} ${['left', 'centre', 'right'][x * 2]}`} onClick={() => setAnchor({ x, y })} />
              )),
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/* ---------------- transform ---------------- */

function TransformSection({ ctx, layer }: { ctx: A.ImageCtx; layer: SceneNode<'layer'> }) {
  const p = layer.props;
  const e = useLayerEdit(ctx, layer.id);
  const [linked, setLinked] = useState(true);
  return (
    <section className="inspector-section">
      <h3>{t('image.transform')}</h3>
      <div className="grid-2">
        <NumberField compact slider={false} label="X" value={Math.round(p.x)} min={-100000} max={100000} unit="px" onCommit={(v) => e.commit({ x: v }, 'Move layer')} />
        <NumberField compact slider={false} label="Y" value={Math.round(p.y)} min={-100000} max={100000} unit="px" onCommit={(v) => e.commit({ y: v }, 'Move layer')} />
        <NumberField compact slider={false} label="W" value={Math.round(p.scaleX * 1000) / 10} min={1} max={2000} step={0.1} unit="%" onCommit={(v) => e.commit(linked ? { scaleX: v / 100, scaleY: (p.scaleY * v) / 100 / p.scaleX } : { scaleX: v / 100 }, 'Scale layer')} />
        <NumberField compact slider={false} label="H" value={Math.round(p.scaleY * 1000) / 10} min={1} max={2000} step={0.1} unit="%" onCommit={(v) => e.commit(linked ? { scaleY: v / 100, scaleX: (p.scaleX * v) / 100 / p.scaleY } : { scaleY: v / 100 }, 'Scale layer')} />
      </div>
      <div className="row" style={{ gap: 8 }}>
        <IconButton small label={linked ? 'Unlink width and height' : 'Link width and height'} pressed={linked} onClick={() => setLinked(!linked)}>
          {linked ? <Link2 /> : <Unlink2 />}
        </IconButton>
        <div className="grow">
          <NumberField compact label={t('video.rotation')} value={p.rotation} min={-180} max={180} step={0.5} unit="°" onInput={(v) => e.input({ rotation: v })} onCommit={(v) => e.commit({ rotation: v }, 'Rotate layer')} />
        </div>
      </div>
      <div className="row" style={{ gap: 4 }}>
        <button className="btn btn-sm" onClick={() => e.commit({ scaleX: -p.scaleX }, 'Flip horizontal')}>
          Flip H
        </button>
        <button className="btn btn-sm" onClick={() => e.commit({ scaleY: -p.scaleY }, 'Flip vertical')}>
          Flip V
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => e.commit({ scaleX: Math.sign(p.scaleX) || 1, scaleY: Math.sign(p.scaleY) || 1, rotation: 0 }, 'Reset transform')}>
          {t('app.reset')}
        </button>
      </div>
    </section>
  );
}

/* ---------------- text ---------------- */

function arcPath(width: number, bend: number) {
  const k = (4 / 3) * bend;
  return { closed: false, anchors: [{ x: 0, y: 0, out: { x: width / 3, y: -k } }, { x: width, y: 0, in: { x: (2 * width) / 3, y: -k } }] };
}

function TextSection({ ctx, layer }: { ctx: A.ImageCtx; layer: SceneNode<'layer'> }) {
  const p = layer.props;
  const e = useLayerEdit(ctx, layer.id);
  const bend = p.textPath?.anchors[0]?.out ? -(p.textPath.anchors[0].out.y * 3) / 4 : 0;
  const arcWidth = p.textPath?.anchors[1]?.x ?? Math.max(200, (p.text?.length ?? 4) * (p.fontSize ?? 48) * 0.55);
  return (
    <section className="inspector-section">
      <h3>{t('image.layerTypes.text')}</h3>
      <textarea
        className="input"
        rows={3}
        aria-label={t('video.text')}
        value={p.text ?? ''}
        onChange={(ev) => e.input({ text: ev.target.value })}
        onBlur={() => ctx.store.getState().commitTransient('Edit text')}
      />
      <div className="row" style={{ gap: 6 }}>
        <FontSelect value={p.fontFamily ?? 'Inter'} onChange={(v) => e.commit({ fontFamily: v }, 'Change font')} />
        <IconButton small label="Bold" pressed={(p.fontWeight ?? 400) >= 600} onClick={() => e.commit({ fontWeight: (p.fontWeight ?? 400) >= 600 ? 400 : 700 }, 'Toggle bold')}>
          <Bold />
        </IconButton>
        <IconButton small label="Italic" pressed={p.fontStyle === 'italic'} onClick={() => e.commit({ fontStyle: p.fontStyle === 'italic' ? 'normal' : 'italic' }, 'Toggle italic')}>
          <Italic />
        </IconButton>
      </div>
      <div className="grid-2">
        <NumberField compact slider={false} label={t('image.fontSize')} value={p.fontSize ?? 48} min={2} max={2000} unit="px" onCommit={(v) => e.commit({ fontSize: v }, 'Change font size')} />
        <NumberField compact slider={false} label={t('image.weight')} value={p.fontVariations?.wght ?? p.fontWeight ?? 400} min={100} max={900} step={10} onCommit={(v) => e.commit({ fontWeight: v, fontVariations: { ...(p.fontVariations ?? {}), wght: v } }, 'Change weight')} />
      </div>
      <ColorField label={t('image.color')} value={p.color ?? '#000000'} onInput={(v) => e.input({ color: v })} onChange={(v) => e.commit({ color: v }, 'Change text color')} />
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="label">{t('image.align')}</span>
        <div className="segmented" role="group" aria-label={t('image.align')}>
          {(['left', 'center', 'right'] as const).map((a) => (
            <button key={a} aria-pressed={(p.align ?? 'left') === a} aria-label={`Align ${a}`} onClick={() => e.commit({ align: a }, 'Align text')}>
              {a === 'left' ? <AlignLeft size={15} /> : a === 'center' ? <AlignCenter size={15} /> : <AlignRight size={15} />}
            </button>
          ))}
        </div>
      </div>
      <NumberField compact label={t('image.lineHeight')} value={p.lineHeight ?? 1.2} min={0.6} max={3} step={0.05} onInput={(v) => e.input({ lineHeight: v })} onCommit={(v) => e.commit({ lineHeight: v }, 'Change line height')} />
      <NumberField compact label={t('image.letterSpacing')} value={p.letterSpacing ?? 0} min={-20} max={100} step={0.5} unit="px" onInput={(v) => e.input({ letterSpacing: v })} onCommit={(v) => e.commit({ letterSpacing: v }, 'Change letter spacing')} />
      <NumberField compact label={t('image.baseline')} value={p.baselineShift ?? 0} min={-200} max={200} unit="px" onInput={(v) => e.input({ baselineShift: v })} onCommit={(v) => e.commit({ baselineShift: v }, 'Change baseline shift')} />
      <NumberField compact slider={false} label="Box width (0 = auto)" value={p.boxWidth ?? 0} min={0} max={20000} unit="px" onCommit={(v) => e.commit({ boxWidth: v > 0 ? v : null }, 'Change text box')} />
      <Switch checked={!!p.textPath} onChange={(v) => e.commit({ textPath: v ? arcPath(arcWidth, arcWidth / 5) : null }, v ? 'Put text on a path' : 'Remove text path')} label="Text on a curve" />
      {p.textPath && (
        <>
          <NumberField compact label="Curve" value={Math.round(bend)} min={-1000} max={1000} unit="px" onInput={(v) => e.input({ textPath: arcPath(arcWidth, v) })} onCommit={(v) => e.commit({ textPath: arcPath(arcWidth, v) }, 'Bend text path')} />
          <NumberField compact slider={false} label="Curve length" value={Math.round(arcWidth)} min={20} max={20000} unit="px" onCommit={(v) => e.commit({ textPath: arcPath(v, bend) }, 'Resize text path')} />
        </>
      )}
    </section>
  );
}

/* ---------------- vector ---------------- */

function ShapeSection({ ctx, layer }: { ctx: A.ImageCtx; layer: SceneNode<'layer'> }) {
  const shapes = layer.props.shapes ?? [];
  const upd = (s: VectorShape, set: Partial<VectorShape>, label: string) => ctx.store.getState().commit({ kind: 'listUpdate', id: layer.id, prop: 'shapes', itemId: s.id, set }, label);
  return (
    <section className="inspector-section">
      <h3>{t('image.layerTypes.vector')}</h3>
      {shapes.map((s, i) => (
        <div key={s.id} className="col" style={{ gap: 8 }}>
          {shapes.length > 1 && <span className="label">{`${t(`image.shapeKinds.${s.kind === 'path' ? 'polygon' : s.kind}` as 'image.shapeKinds.rect')} ${i + 1}`}</span>}
          <div className="grid-2">
            <NumberField compact slider={false} label="W" value={Math.round(s.width)} min={1} max={100000} onCommit={(v) => upd(s, { width: v }, 'Resize shape')} />
            <NumberField compact slider={false} label="H" value={Math.round(s.height)} min={1} max={100000} onCommit={(v) => upd(s, { height: v }, 'Resize shape')} />
          </div>
          {s.kind !== 'line' && <ColorField label={t('image.fill')} value={s.fill} allowNone onClear={() => upd(s, { fill: null }, 'Remove fill')} onChange={(v) => upd(s, { fill: v }, 'Change fill')} />}
          <ColorField label={t('image.stroke')} value={s.stroke} allowNone onClear={() => upd(s, { stroke: null }, 'Remove stroke')} onChange={(v) => upd(s, { stroke: v }, 'Change stroke')} />
          <NumberField compact label={t('image.strokeWidth')} value={s.strokeWidth} min={0} max={100} step={0.5} onCommit={(v) => upd(s, { strokeWidth: v }, 'Change stroke width')} />
          {s.kind === 'rect' && <NumberField compact label="Corner radius" value={s.radius ?? 0} min={0} max={Math.min(s.width, s.height) / 2} onCommit={(v) => upd(s, { radius: v }, 'Change corner radius')} />}
        </div>
      ))}
    </section>
  );
}

/* ---------------- raster ---------------- */

function RasterSection({ ctx, layer }: { ctx: A.ImageCtx; layer: SceneNode<'layer'> }) {
  const p = layer.props;
  const strokes = p.strokes?.length ?? 0;
  return (
    <section className="inspector-section">
      <h3>{t('image.layerTypes.raster')}</h3>
      <div className="row muted" style={{ justifyContent: 'space-between', fontSize: 'var(--fs-sm)' }}>
        <span>{p.width && p.height ? `${Math.round(p.width)} × ${Math.round(p.height)} px` : ''}</span>
        <span>{strokes ? `${strokes} brush ${strokes === 1 ? 'stroke' : 'strokes'}` : ''}</span>
      </div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button className="btn btn-sm" onClick={() => void A.removeLayerBackground(ctx)}>
          {t('video.removeBackground')}
        </button>
        {strokes > 0 && (
          <button className="btn btn-sm btn-ghost" onClick={() => ctx.store.getState().commit({ kind: 'listRemove', id: layer.id, prop: 'strokes', index: strokes - 1, count: 1 }, 'Remove last stroke')}>
            <Eraser /> Remove last stroke
          </button>
        )}
      </div>
    </section>
  );
}

/* ---------------- adjustments ---------------- */

function AdjustmentSection({ ctx, layer, adj }: { ctx: A.ImageCtx; layer: SceneNode<'layer'>; adj: Adjustment }) {
  const e = useLayerEdit(ctx, layer.id);
  const [lutPicker, setLutPicker] = useState(false);
  const set = (patch: Partial<Adjustment>, live = false) => {
    const next = { ...adj, ...patch } as Adjustment;
    if (live) e.input({ adjustment: next });
    else e.commit({ adjustment: next }, `Adjust ${t(`adjust.${adj.kind}`)}`);
  };
  const slider = (key: string, label: string, min: number, max: number, step = 1) => (
    <NumberField key={key} compact label={label} value={(adj as unknown as Record<string, number>)[key] ?? 0} min={min} max={max} step={step} onInput={(v) => set({ [key]: v } as never, true)} onCommit={(v) => set({ [key]: v } as never)} />
  );
  return (
    <section className="inspector-section">
      <h3>{t(`adjust.${adj.kind}`)}</h3>
      {adj.kind === 'brightnessContrast' && [slider('brightness', t('adjust.brightness'), -100, 100), slider('contrast', t('adjust.contrast'), -100, 100)]}
      {adj.kind === 'hueSaturation' && [slider('hue', t('adjust.hue'), -180, 180), slider('saturation', t('adjust.saturation'), -100, 100), slider('lightness', t('adjust.lightness'), -100, 100)]}
      {adj.kind === 'temperature' && slider('amount', t('adjust.temperature'), -100, 100)}
      {adj.kind === 'levels' && [slider('inBlack', t('adjust.inBlack'), 0, 254), slider('inWhite', t('adjust.inWhite'), 1, 255), slider('gamma', t('adjust.gamma'), 0.1, 5, 0.01), slider('outBlack', t('adjust.outBlack'), 0, 255), slider('outWhite', t('adjust.outWhite'), 0, 255)]}
      {adj.kind === 'colorBalance' && <ColorBalanceEditor adj={adj} onInput={(p) => set(p, true)} onCommit={(p) => set(p)} />}
      {adj.kind === 'curves' && (
        <>
          <Select
            label={t('adjust.channel')}
            value={adj.channel}
            options={[
              { value: 'rgb', label: 'RGB' },
              { value: 'r', label: 'Red' },
              { value: 'g', label: 'Green' },
              { value: 'b', label: 'Blue' },
            ]}
            onChange={(v) => set({ channel: v })}
          />
          <CurvesEditor points={adj.points} channel={adj.channel} onInput={(pts) => set({ points: pts }, true)} onCommit={(pts) => set({ points: pts })} />
        </>
      )}
      {adj.kind === 'lut' && (
        <>
          <button className="btn btn-sm" onClick={() => setLutPicker(true)}>
            {adj.assetId ? 'Change LUT…' : t('image.lutImport')}
          </button>
          {slider('intensity', t('adjust.intensity'), 0, 1, 0.01)}
          {lutPicker && <AssetPicker kinds={['lut']} projectId={ctx.store.getState().projectId} onPick={([a]) => a && set({ assetId: a.id })} onClose={() => setLutPicker(false)} />}
        </>
      )}
      {adj.kind === 'invert' && <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Inverts every layer below. Use opacity or a mask to limit it.</p>}
      <NumberField compact label={t('image.opacity')} value={Math.round(layer.props.opacity * 100)} min={0} max={100} unit="%" onInput={(v) => e.input({ opacity: v / 100 })} onCommit={(v) => e.commit({ opacity: v / 100 }, 'Change opacity')} />
    </section>
  );
}

function ColorBalanceEditor({ adj, onInput, onCommit }: { adj: Extract<Adjustment, { kind: 'colorBalance' }>; onInput: (p: Partial<Adjustment>) => void; onCommit: (p: Partial<Adjustment>) => void }) {
  const [tone, setTone] = useState<'shadows' | 'midtones' | 'highlights'>('midtones');
  const v = adj[tone];
  const labels = ['Cyan – Red', 'Magenta – Green', 'Yellow – Blue'];
  return (
    <>
      <div className="segmented" role="group" aria-label="Tone range">
        {(['shadows', 'midtones', 'highlights'] as const).map((k) => (
          <button key={k} aria-pressed={tone === k} onClick={() => setTone(k)}>
            {t(`adjust.${k}`)}
          </button>
        ))}
      </div>
      {[0, 1, 2].map((i) => {
        const next = (x: number) => {
          const arr = [...v] as [number, number, number];
          arr[i] = x;
          return { [tone]: arr } as Partial<Adjustment>;
        };
        return <NumberField key={i} compact label={labels[i]!} value={v[i]!} min={-100} max={100} onInput={(x) => onInput(next(x))} onCommit={(x) => onCommit(next(x))} />;
      })}
    </>
  );
}

const CHANNEL_COLOR: Record<string, string> = { rgb: 'var(--text)', r: '#e34948', g: '#1baf7a', b: '#2a78d6' };

/** Interactive tone curve: drag points, click to add, double-click a point to remove it. */
export function CurvesEditor({ points, channel, onInput, onCommit }: { points: [number, number][]; channel: string; onInput: (p: [number, number][]) => void; onCommit: (p: [number, number][]) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const [local, setLocal] = useState(points);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  useEffect(() => {
    if (dragIdx === null) setLocal(points);
  }, [points, dragIdx]);
  const S = 220;
  const lut = curveLut(local);
  const d = Array.from({ length: 64 }, (_, i) => {
    const x = (i / 63) * 255;
    return `${i ? 'L' : 'M'}${(x / 255) * S},${S - (lut[Math.round(x)]! / 255) * S}`;
  }).join('');
  const toVal = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [Math.round(Math.min(255, Math.max(0, ((e.clientX - r.left) / r.width) * 255))), Math.round(Math.min(255, Math.max(0, (1 - (e.clientY - r.top) / r.height) * 255)))];
  };
  const sorted = (pts: [number, number][]) => [...pts].sort((a, b) => a[0] - b[0]);
  const move = (i: number, v: [number, number]) => {
    const next = local.map((p, j) => (j === i ? v : p)) as [number, number][];
    setLocal(next);
    onInput(sorted(next));
    return next;
  };
  return (
    <div className="curves">
      <svg
        ref={ref}
        viewBox={`0 0 ${S} ${S}`}
        width="100%"
        role="application"
        aria-label={`Curve with ${local.length} points. Use arrow keys to move the focused point, Tab between points.`}
        onPointerDown={(e) => {
          if ((e.target as Element).tagName === 'circle') return;
          const v = toVal(e);
          const next = sorted([...local, v]);
          setLocal(next);
          const i = next.findIndex((p) => p === v);
          setDragIdx(i);
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => dragIdx !== null && move(dragIdx, toVal(e))}
        onPointerUp={() => {
          if (dragIdx === null) return;
          setDragIdx(null);
          onCommit(sorted(local));
        }}
      >
        <rect x="0" y="0" width={S} height={S} className="curves-bg" />
        {[1, 2, 3].map((i) => (
          <g key={i} className="curves-grid">
            <line x1={(S * i) / 4} y1="0" x2={(S * i) / 4} y2={S} />
            <line x1="0" y1={(S * i) / 4} x2={S} y2={(S * i) / 4} />
          </g>
        ))}
        <line x1="0" y1={S} x2={S} y2="0" className="curves-diag" />
        <path d={d} fill="none" stroke={CHANNEL_COLOR[channel]} strokeWidth="2" />
        {local.map(([x, y], i) => (
          <circle
            key={i}
            cx={(x / 255) * S}
            cy={S - (y / 255) * S}
            r={6}
            tabIndex={0}
            className={`curves-pt${focusIdx === i ? ' focus' : ''}`}
            aria-label={`Point ${i + 1}: input ${x}, output ${y}`}
            onFocus={() => setFocusIdx(i)}
            onPointerDown={(e) => {
              e.stopPropagation();
              setDragIdx(i);
              (ref.current as Element).setPointerCapture(e.pointerId);
            }}
            onDoubleClick={() => {
              if (local.length <= 2) return;
              const next = local.filter((_, j) => j !== i);
              setLocal(next);
              onCommit(sorted(next));
            }}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 10 : 1;
              const [px, py] = local[i]!;
              let v: [number, number] | null = null;
              if (e.key === 'ArrowUp') v = [px, Math.min(255, py + step)];
              if (e.key === 'ArrowDown') v = [px, Math.max(0, py - step)];
              if (e.key === 'ArrowLeft') v = [Math.max(0, px - step), py];
              if (e.key === 'ArrowRight') v = [Math.min(255, px + step), py];
              if (e.key === 'Delete' && local.length > 2) {
                const next = local.filter((_, j) => j !== i);
                setLocal(next);
                onCommit(sorted(next));
              }
              if (v) {
                e.preventDefault();
                onCommit(sorted(move(i, v)));
              }
            }}
          />
        ))}
      </svg>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>Click to add · double-click to remove</span>
        <button className="btn btn-sm btn-ghost" onClick={() => onCommit([[0, 0], [255, 255]])}>
          {t('app.reset')}
        </button>
      </div>
    </div>
  );
}

/* ---------------- masks ---------------- */

function MaskSection({ ctx, layer }: { ctx: A.ImageCtx; layer: SceneNode<'layer'> }) {
  const m = layer.props.mask;
  const hasSelection = useProject((s) => !!(s.state?.nodes[ctx.canvasId] as SceneNode<'canvas'> | undefined)?.props.selection);
  if (!m && !hasSelection) return null;
  return (
    <section className="inspector-section">
      <h3>{t('image.mask')}</h3>
      {!m && (
        <button className="btn btn-sm" onClick={() => A.maskFromSelection(ctx)}>
          {t('image.addMask')}
        </button>
      )}
      {m && (
        <>
          <Switch checked={m.enabled} onChange={(v) => A.updateLayer(ctx, layer.id, { mask: { ...m, enabled: v } }, v ? 'Enable mask' : 'Disable mask')} label={t('image.disableMask').replace('Disable', 'Use')} />
          <Switch checked={m.inverted} onChange={(v) => A.updateLayer(ctx, layer.id, { mask: { ...m, inverted: v } }, 'Invert mask')} label={t('image.invertMask')} />
          <div className="row" style={{ gap: 6 }}>
            {hasSelection && (
              <button className="btn btn-sm" onClick={() => A.maskFromSelection(ctx)}>
                Replace with selection
              </button>
            )}
            <button className="btn btn-sm btn-ghost" onClick={() => A.updateLayer(ctx, layer.id, { mask: null }, 'Remove mask')}>
              {t('image.removeMask')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/* ---------------- smart filters ---------------- */

function FiltersSection({ ctx, layer }: { ctx: A.ImageCtx; layer: SceneNode<'layer'> }) {
  const filters = layer.props.filters ?? [];
  const s = ctx.store.getState();
  const add = (f: FilterKind) => s.commit({ kind: 'listInsert', id: layer.id, prop: 'filters', items: [{ id: `flt_${Math.random().toString(36).slice(2, 10)}`, filter: f, params: { ...FILTER_DEFAULTS[f] }, enabled: true, opacity: 1 } satisfies SmartFilter] }, `Add ${t(`filters.${f}`)}`);
  const live = (f: SmartFilter, patch: Partial<SmartFilter>) => s.setTransient(layer.id, { filters: filters.map((x) => (x.id === f.id ? { ...x, ...patch } : x)) });
  const commit = (f: SmartFilter, patch: Partial<SmartFilter>, label: string) => {
    s.clearTransient(layer.id);
    s.commit({ kind: 'listUpdate', id: layer.id, prop: 'filters', itemId: f.id, set: patch }, label);
  };
  return (
    <section className="inspector-section">
      <h3>
        <span className="grow">{t('image.filters')}</span>
        <MenuButton className="icon-btn sm" label={t('image.addFilter')} items={FILTERS.map((f) => ({ label: t(`filters.${f}`), onSelect: () => add(f) }))}>
          <Plus />
        </MenuButton>
      </h3>
      {filters.length === 0 && <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Filters stay editable and can be switched off at any time.</p>}
      {filters.map((f, i) => (
        <div key={f.id} className="filter-card">
          <div className="row" style={{ gap: 4 }}>
            <strong className="grow" style={{ fontSize: 'var(--fs-sm)' }}>
              {t(`filters.${f.filter}`)}
            </strong>
            <IconButton small label={f.enabled ? 'Turn off' : 'Turn on'} pressed={!f.enabled} onClick={() => commit(f, { enabled: !f.enabled }, f.enabled ? 'Disable filter' : 'Enable filter')}>
              {f.enabled ? <Eye /> : <EyeOff />}
            </IconButton>
            <IconButton small label={t('app.remove')} onClick={() => s.commit({ kind: 'listRemove', id: layer.id, prop: 'filters', index: i, count: 1 }, `Remove ${t(`filters.${f.filter}`)}`)}>
              <Trash2 />
            </IconButton>
          </div>
          {Object.entries({ ...FILTER_DEFAULTS[f.filter], ...f.params })
            .filter(([k]) => k !== 'seed')
            .map(([k, v]) => {
              const spec = FILTER_PARAMS[k] ?? { min: 0, max: 100, label: k };
              return (
                <NumberField
                  key={k}
                  compact
                  label={spec.label}
                  value={v}
                  min={spec.min}
                  max={spec.max}
                  {...(spec.step ? { step: spec.step } : {})}
                  onInput={(x) => live(f, { params: { ...f.params, [k]: x } })}
                  onCommit={(x) => commit(f, { params: { ...f.params, [k]: x } }, `Adjust ${t(`filters.${f.filter}`)}`)}
                />
              );
            })}
          <NumberField compact label={t('image.opacity')} value={Math.round(f.opacity * 100)} min={0} max={100} unit="%" onInput={(x) => live(f, { opacity: x / 100 })} onCommit={(x) => commit(f, { opacity: x / 100 }, 'Filter opacity')} />
        </div>
      ))}
    </section>
  );
}
