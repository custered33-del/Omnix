import { useState } from 'react';
import { useStore } from 'zustand';
import { Plus, Trash2, ArrowUpToLine, ArrowDownToLine, ChevronUp, ChevronDown, Link2, Copy, Globe } from 'lucide-react';
import type { ChartSpec, ElementAnimation, ElementAnimationKind, SceneNode, SlideElementProps, SlideTransitionKind, ThemeTokens } from '@omnix/core';
import { applyLayoutOps, applyThemeOp, LAYOUT_LABELS, newId, rehearsalTotal, THEME_PRESETS, type SlideLayout } from '@omnix/core';
import { useProject } from '../../state/project.js';
import { ColorField, IconButton, NumberField, Select, Switch } from '../../ui/primitives.js';
import { AssetPicker } from '../../components/AssetPicker.js';
import { EmbedPicker } from '../../components/EmbedView.js';
import { EasingEditor } from '../shared/EasingEditor.js';
import { FontSelect } from '../shared/FontSelect.js';
import { post, del } from '../../lib/api.js';
import { toast } from '../../ui/toast.js';
import { animationGroups, slideStepCount } from '@omnix/render';
import type { SlidesCtx } from './SlideStage.js';

const ANIMATIONS: { kind: ElementAnimationKind; label: string }[] = [
  { kind: 'fade-in', label: 'Fade in' },
  { kind: 'fly-in', label: 'Fly in' },
  { kind: 'zoom-in', label: 'Zoom in' },
  { kind: 'pulse', label: 'Pulse' },
  { kind: 'spin', label: 'Spin' },
  { kind: 'fade-out', label: 'Fade out' },
  { kind: 'fly-out', label: 'Fly out' },
];

const TRANSITIONS: SlideTransitionKind[] = ['none', 'fade', 'push', 'wipe', 'zoom'];

export function SlideInspector({ ctx }: { ctx: SlidesCtx }) {
  const tab = useStore(ctx.ed, (s) => s.inspectorTab);
  const selected = useStore(ctx.ed, (s) => s.selected);
  const slideId = useStore(ctx.ed, (s) => s.slideId);
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  const el = useProject((s) => (selected.length === 1 ? s.state?.nodes[selected[0]!] : undefined)) as SceneNode<'slideElement'> | undefined;
  const slide = useProject((s) => (slideId ? s.state?.nodes[slideId] : undefined)) as SceneNode<'slide'> | undefined;
  return (
    <aside className="inspector slide-inspector" aria-label="Inspector">
      <div className="segmented" role="tablist" style={{ margin: 12 }} aria-label="Inspector">
        {(['element', 'slide', 'deck'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => ctx.ed.getState().set({ inspectorTab: k })}>
            {k === 'element' ? 'Element' : k === 'slide' ? 'Slide' : 'Theme'}
          </button>
        ))}
      </div>
      <fieldset className="props-fieldset" disabled={!canEdit}>
        {tab === 'element' && (el ? <ElementInspector ctx={ctx} el={el} /> : <p className="muted inspector-note">{selected.length > 1 ? `${selected.length} elements selected. Drag to move them together.` : 'Select an element on the slide, or add one from the toolbar.'}</p>)}
        {tab === 'slide' && slide && <SlideTab ctx={ctx} slide={slide} />}
        {tab === 'deck' && <DeckTab ctx={ctx} />}
      </fieldset>
    </aside>
  );
}

/* ---------------- element ---------------- */

function ElementInspector({ ctx, el }: { ctx: SlidesCtx; el: SceneNode<'slideElement'> }) {
  const p = el.props;
  const s = ctx.store.getState();
  const [picker, setPicker] = useState<null | 'image' | 'video' | 'embed'>(null);
  const upd = (set: Partial<SlideElementProps>, label: string) => s.commit({ kind: 'update', id: el.id, set: set as Record<string, unknown> }, label);
  const live = (set: Partial<SlideElementProps>) => s.setTransient(el.id, set as Record<string, unknown>);
  const done = (label: string) => s.commitTransient(label);
  const siblings = s.state!.nodes[el.parentId!]!.children;
  const idx = siblings.indexOf(el.id);
  const arrange = (to: number, label: string) => s.commit({ kind: 'move', id: el.id, parentId: el.parentId!, index: Math.max(0, Math.min(siblings.length - 1, to)) }, label);
  return (
    <>
      <section className="inspector-section">
        <h3>
          <span className="grow">{p.elementType === 'embed' ? 'Live link' : p.elementType[0]!.toUpperCase() + p.elementType.slice(1)}</span>
          <IconButton small label="Bring to front" onClick={() => arrange(siblings.length - 1, 'Bring to front')} disabled={idx === siblings.length - 1}>
            <ArrowUpToLine />
          </IconButton>
          <IconButton small label="Bring forward" onClick={() => arrange(idx + 1, 'Bring forward')} disabled={idx === siblings.length - 1}>
            <ChevronUp />
          </IconButton>
          <IconButton small label="Send backward" onClick={() => arrange(idx - 1, 'Send backward')} disabled={idx === 0}>
            <ChevronDown />
          </IconButton>
          <IconButton small label="Send to back" onClick={() => arrange(0, 'Send to back')} disabled={idx === 0}>
            <ArrowDownToLine />
          </IconButton>
        </h3>
        <div className="grid-2">
          <NumberField compact slider={false} label="X" value={p.x} min={-10000} max={10000} onCommit={(v) => upd({ x: v }, 'Move element')} />
          <NumberField compact slider={false} label="Y" value={p.y} min={-10000} max={10000} onCommit={(v) => upd({ y: v }, 'Move element')} />
          <NumberField compact slider={false} label="W" value={p.w} min={4} max={10000} onCommit={(v) => upd({ w: v }, 'Resize element')} />
          <NumberField compact slider={false} label="H" value={p.h} min={4} max={10000} onCommit={(v) => upd({ h: v }, 'Resize element')} />
        </div>
        <NumberField compact label="Rotation" value={p.rotation} min={-180} max={180} unit="°" onInput={(v) => live({ rotation: v })} onCommit={(v) => (live({ rotation: v }), done('Rotate element'))} />
        <NumberField compact label="Opacity" value={Math.round(p.opacity * 100)} min={0} max={100} unit="%" onInput={(v) => live({ opacity: v / 100 })} onCommit={(v) => (live({ opacity: v / 100 }), done('Change opacity'))} />
        <Select
          label="Placeholder role"
          value={(p.role ?? 'none') as string}
          options={[
            { value: 'none', label: 'None' },
            { value: 'title', label: 'Title' },
            { value: 'subtitle', label: 'Subtitle' },
            { value: 'body', label: 'Body' },
            { value: 'image', label: 'Image' },
            { value: 'footer', label: 'Footer' },
          ]}
          onChange={(v) => upd({ role: v === 'none' ? null : (v as SlideElementProps['role']) }, 'Change role')}
        />
      </section>
      {p.elementType === 'text' && (
        <section className="inspector-section">
          <h3>Text</h3>
          <textarea className="input" rows={4} value={p.text ?? ''} aria-label="Text (markdown)" onChange={(e) => live({ text: e.target.value })} onBlur={() => done('Edit text')} />
          <FontSelect value={p.fontFamily ?? 'Inter'} onChange={(v) => upd({ fontFamily: v }, 'Change font')} />
          <NumberField compact slider={false} label="Size (0 = theme)" value={p.fontSize ?? 0} min={0} max={400} unit="px" onCommit={(v) => upd({ fontSize: v || null }, 'Change size')} />
          <ColorField label="Color" value={p.color ?? null} allowNone onClear={() => upd({ color: null }, 'Use theme color')} onChange={(v) => upd({ color: v }, 'Change color')} />
          <Select
            label="Align"
            value={p.align ?? 'left'}
            options={[
              { value: 'left', label: 'Left' },
              { value: 'center', label: 'Centre' },
              { value: 'right', label: 'Right' },
            ]}
            onChange={(v) => upd({ align: v }, 'Align text')}
          />
          <Select
            label="Vertical"
            value={p.valign ?? 'auto'}
            options={[
              { value: 'auto', label: p.role === 'title' ? 'Auto (bottom)' : 'Auto (top)' },
              { value: 'top', label: 'Top' },
              { value: 'middle', label: 'Middle' },
              { value: 'bottom', label: 'Bottom' },
            ]}
            onChange={(v) => upd({ valign: v === 'auto' ? null : v }, 'Align text vertically')}
          />
          <Switch checked={!!p.bold} onChange={(v) => upd({ bold: v }, 'Toggle bold')} label="Bold" />
        </section>
      )}
      {(p.elementType === 'image' || p.elementType === 'video') && (
        <section className="inspector-section">
          <h3>{p.elementType === 'image' ? 'Image' : 'Video'}</h3>
          <button className="btn btn-sm" onClick={() => setPicker(p.elementType === 'image' ? 'image' : 'video')}>
            {p.assetId ? 'Replace…' : 'Choose…'}
          </button>
          {p.elementType === 'video' && <p className="muted hint-inline">Videos play when the slide is presented.</p>}
        </section>
      )}
      {p.elementType === 'shape' && p.shape && (
        <section className="inspector-section">
          <h3>Shape</h3>
          <Select
            label="Kind"
            value={p.shape.kind === 'ellipse' || p.shape.kind === 'line' ? p.shape.kind : 'rect'}
            options={[
              { value: 'rect', label: 'Rectangle' },
              { value: 'ellipse', label: 'Ellipse' },
              { value: 'line', label: 'Line' },
            ]}
            onChange={(v) => upd({ shape: { ...p.shape!, kind: v, ...(v === 'line' ? { points: [{ x: 0, y: 0 }, { x: p.shape!.width, y: p.shape!.height }] } : {}) } }, 'Change shape')}
          />
          <ColorField label="Fill" value={p.shape.fill} allowNone onClear={() => upd({ shape: { ...p.shape!, fill: null } }, 'Remove fill')} onChange={(v) => upd({ shape: { ...p.shape!, fill: v } }, 'Change fill')} />
          <ColorField label="Stroke" value={p.shape.stroke} allowNone onClear={() => upd({ shape: { ...p.shape!, stroke: null } }, 'Remove stroke')} onChange={(v) => upd({ shape: { ...p.shape!, stroke: v } }, 'Change stroke')} />
          <NumberField compact label="Stroke width" value={p.shape.strokeWidth} min={0} max={40} onCommit={(v) => upd({ shape: { ...p.shape!, strokeWidth: v } }, 'Change stroke width')} />
          {p.shape.kind === 'rect' && <NumberField compact label="Corner radius" value={p.shape.radius ?? 0} min={0} max={400} onCommit={(v) => upd({ shape: { ...p.shape!, radius: v } }, 'Change radius')} />}
        </section>
      )}
      {p.elementType === 'chart' && p.chart && <ChartEditor spec={p.chart} onChange={(c) => upd({ chart: c }, 'Edit chart')} onLink={() => setPicker('embed')} />}
      {p.elementType === 'embed' && p.embed && (
        <section className="inspector-section">
          <h3>Live link</h3>
          <p className="muted hint-inline">This element shows {p.embed.kind === 'cell-output' ? 'a Code Grounds output' : p.embed.kind === 'sequence-frame' ? 'a video or animation (it plays while presenting)' : p.embed.kind} and updates when the source changes.</p>
          {p.embed.kind === 'sequence-frame' && <NumberField compact slider={false} label="Start at" value={p.embed.time ?? 0} min={0} max={36000} step={0.1} unit="s" onCommit={(v) => upd({ embed: { ...p.embed!, time: v } }, 'Change start time')} />}
          <button className="btn btn-sm" onClick={() => setPicker('embed')}>
            <Link2 /> Change source…
          </button>
        </section>
      )}
      <AnimationsSection ctx={ctx} el={el} />
      {(picker === 'image' || picker === 'video') && <AssetPicker kinds={[picker]} projectId={s.projectId} onPick={([a]) => a && upd({ assetId: a.id }, picker === 'image' ? 'Replace image' : 'Replace video')} onClose={() => setPicker(null)} />}
      {picker === 'embed' && <EmbedPicker excludeDeck={ctx.deckId} onPick={(e) => upd({ elementType: 'embed', embed: e, chart: null }, 'Link live content')} onClose={() => setPicker(null)} />}
    </>
  );
}

/** Edit chart data as a small spreadsheet, or paste CSV. */
function ChartEditor({ spec, onChange, onLink }: { spec: ChartSpec; onChange: (c: ChartSpec) => void; onLink: () => void }) {
  const [csv, setCsv] = useState<string | null>(null);
  const setLabel = (row: number, v: string) => onChange({ ...spec, labels: spec.labels.map((l, i) => (i === row ? v : l)) });
  const toCsv = () => [['Label', ...spec.series.map((s) => s.name)], ...spec.labels.map((l, i) => [l, ...spec.series.map((s) => String(s.values[i] ?? ''))])].map((r) => r.join(',')).join('\n');
  const fromCsv = (text: string) => {
    const rows = text.trim().split(/\r?\n/).map((r) => r.split(/[,\t;]/).map((c) => c.trim()));
    if (rows.length < 2) return;
    const head = rows[0]!;
    onChange({ ...spec, labels: rows.slice(1).map((r) => r[0] ?? ''), series: head.slice(1).map((name, i) => ({ name, values: rows.slice(1).map((r) => Number(r[i + 1]) || 0) })) });
  };
  return (
    <section className="inspector-section">
      <h3>Chart</h3>
      <Select
        label="Type"
        value={spec.type}
        options={[
          { value: 'bar', label: 'Bar' },
          { value: 'line', label: 'Line' },
          { value: 'area', label: 'Area' },
          { value: 'scatter', label: 'Scatter' },
          { value: 'pie', label: 'Pie' },
        ]}
        onChange={(v) => onChange({ ...spec, type: v })}
      />
      <input className="input sm" value={spec.title ?? ''} placeholder="Title" aria-label="Chart title" onChange={(e) => onChange({ ...spec, title: e.target.value })} />
      {csv === null ? (
        <div className="table-wrap">
          <table className="data-table chart-data">
            <thead>
              <tr>
                <th scope="col">Label</th>
                {spec.series.map((s, si) => (
                  <th key={si} scope="col">
                    <input className="cell-input" value={s.name} aria-label={`Series ${si + 1} name`} onChange={(e) => onChange({ ...spec, series: spec.series.map((x, i) => (i === si ? { ...x, name: e.target.value } : x)) })} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {spec.labels.map((l, ri) => (
                <tr key={ri}>
                  <td>
                    <input className="cell-input" value={l} aria-label={`Row ${ri + 1} label`} onChange={(e) => setLabel(ri, e.target.value)} />
                  </td>
                  {spec.series.map((s, si) => (
                    <td key={si}>
                      <input className="cell-input num" inputMode="decimal" value={String(s.values[ri] ?? '')} aria-label={`${s.name}, ${l}`} onChange={(e) => onChange({ ...spec, series: spec.series.map((x, i) => (i === si ? { ...x, values: x.values.map((v, j) => (j === ri ? Number(e.target.value) || 0 : v)) } : x)) })} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <textarea className="input mono" rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} aria-label="Chart data as CSV" />
      )}
      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
        <button className="btn btn-sm btn-ghost" onClick={() => onChange({ ...spec, labels: [...spec.labels, `Item ${spec.labels.length + 1}`], series: spec.series.map((s) => ({ ...s, values: [...s.values, 0] })) })}>
          <Plus /> Row
        </button>
        <button className="btn btn-sm btn-ghost" disabled={spec.series.length >= 8} onClick={() => onChange({ ...spec, series: [...spec.series, { name: `Series ${spec.series.length + 1}`, values: spec.labels.map(() => 0) }] })}>
          <Plus /> Series
        </button>
        {csv === null ? (
          <button className="btn btn-sm btn-ghost" onClick={() => setCsv(toCsv())}>
            Edit as CSV
          </button>
        ) : (
          <button className="btn btn-sm btn-primary" onClick={() => (fromCsv(csv), setCsv(null))}>
            Apply CSV
          </button>
        )}
      </div>
      <button className="btn btn-sm" onClick={onLink}>
        <Link2 /> Use a live chart from Code Grounds
      </button>
    </section>
  );
}

function AnimationsSection({ ctx, el }: { ctx: SlidesCtx; el: SceneNode<'slideElement'> }) {
  const anims = el.props.animations;
  const s = ctx.store.getState();
  const set = (a: ElementAnimation, patch: Partial<ElementAnimation>, label: string) => s.commit({ kind: 'listUpdate', id: el.id, prop: 'animations', itemId: a.id, set: patch }, label);
  const steps = slideStepCount(s.state!, el.parentId!);
  const groups = animationGroups(anims);
  return (
    <section className="inspector-section">
      <h3>
        <span className="grow">Animations</span>
        <select
          className="select sm"
          style={{ width: 120 }}
          aria-label="Add animation"
          value=""
          onChange={(e) => {
            const kind = e.target.value as ElementAnimationKind;
            if (!kind) return;
            s.commit({ kind: 'listInsert', id: el.id, prop: 'animations', items: [{ id: newId('anim'), kind, delay: 0, duration: 0.6, easing: 'ease-out', ...(anims.length || steps > 0 ? { trigger: 'on-click', click: steps + 1 } : { trigger: 'on-enter' }) } satisfies ElementAnimation] }, 'Add animation');
          }}
        >
          <option value="">Add…</option>
          {ANIMATIONS.map((a) => (
            <option key={a.kind} value={a.kind}>
              {a.label}
            </option>
          ))}
        </select>
      </h3>
      {anims.length === 0 && <p className="muted hint-inline">Entrances, emphasis and exits play on entering the slide or on a click.</p>}
      {anims.map((a, i) => (
        <div key={a.id} className="filter-card">
          <div className="row" style={{ gap: 4 }}>
            <strong className="grow" style={{ fontSize: 'var(--fs-sm)' }}>
              {ANIMATIONS.find((x) => x.kind === a.kind)?.label ?? a.kind}
            </strong>
            <IconButton small label="Remove animation" onClick={() => s.commit({ kind: 'listRemove', id: el.id, prop: 'animations', index: i, count: 1 }, 'Remove animation')}>
              <Trash2 />
            </IconButton>
          </div>
          <Select
            label="Starts"
            value={a.trigger}
            options={[
              { value: 'on-enter', label: 'When the slide appears' },
              { value: 'on-click', label: 'On click' },
              { value: 'with-previous', label: 'With previous' },
            ]}
            onChange={(v) => set(a, v === 'on-click' ? { trigger: v, click: (groups[i - 1] ?? 0) + 1 } : { trigger: v, click: null }, 'Change trigger')}
          />
          {a.trigger === 'on-click' && <NumberField compact slider={false} label="Click" value={groups[i]!} min={1} max={steps + 1} step={1} onCommit={(v) => set(a, { click: Math.max(1, Math.round(v)) }, 'Change click')} />}
          <div className="grid-2">
            <NumberField compact slider={false} label="Delay" value={a.delay} min={0} max={30} step={0.1} unit="s" onCommit={(v) => set(a, { delay: v }, 'Change delay')} />
            <NumberField compact slider={false} label="Duration" value={a.duration} min={0.05} max={30} step={0.05} unit="s" onCommit={(v) => set(a, { duration: v }, 'Change duration')} />
          </div>
          <EasingEditor value={a.easing} onChange={(e) => set(a, { easing: e }, 'Change easing')} />
        </div>
      ))}
    </section>
  );
}

/* ---------------- slide ---------------- */

function SlideTab({ ctx, slide }: { ctx: SlidesCtx; slide: SceneNode<'slide'> }) {
  const p = slide.props;
  const s = ctx.store.getState();
  const upd = (set: Record<string, unknown>, label: string) => s.commit({ kind: 'update', id: slide.id, set }, label);
  return (
    <section className="inspector-section">
      <h3>Slide</h3>
      <input className="input sm" value={p.name} aria-label="Slide name" onChange={(e) => s.setTransient(slide.id, { name: e.target.value })} onBlur={() => s.commitTransient('Rename slide')} />
      <Select label="Layout" value={p.layout} options={(Object.keys(LAYOUT_LABELS) as SlideLayout[]).map((l) => ({ value: l, label: LAYOUT_LABELS[l] }))} onChange={(v) => s.commit(applyLayoutOps(s.state!, slide.id, v), 'Change layout')} />
      <ColorField label="Background" value={p.background} allowNone onClear={() => upd({ background: null }, 'Use theme background')} onChange={(v) => upd({ background: v }, 'Change background')} />
      <Select label="Transition" value={p.transition.kind} options={TRANSITIONS.map((k) => ({ value: k, label: k === 'none' ? 'None' : k[0]!.toUpperCase() + k.slice(1) }))} onChange={(v) => upd({ transition: { ...p.transition, kind: v } }, 'Change transition')} />
      {p.transition.kind !== 'none' && (
        <>
          <NumberField compact label="Transition length" value={p.transition.duration} min={0.1} max={3} step={0.05} unit="s" onCommit={(v) => upd({ transition: { ...p.transition, duration: v } }, 'Transition length')} />
          <EasingEditor value={p.transition.easing} onChange={(e) => upd({ transition: { ...p.transition, easing: e } }, 'Transition easing')} />
        </>
      )}
      <Switch checked={p.hidden} onChange={(v) => upd({ hidden: v }, v ? 'Hide slide' : 'Show slide')} label="Skip when presenting" />
      {p.rehearsalSeconds !== null && <p className="muted hint-inline">Last rehearsal: {Math.round(p.rehearsalSeconds)} s on this slide.</p>}
    </section>
  );
}

/* ---------------- deck / theme ---------------- */

function DeckTab({ ctx }: { ctx: SlidesCtx }) {
  const deck = useProject((s) => s.state?.nodes[ctx.deckId]) as SceneNode<'deck'>;
  const total = useProject((s) => rehearsalTotal(s.state!, ctx.deckId));
  const s = ctx.store.getState();
  const theme = deck.props.theme;
  const setTheme = (t: ThemeTokens, label = 'Change theme') => s.commit(applyThemeOp(s.state!, ctx.deckId, t), label);
  const shareUrl = deck.props.shareId ? `${location.origin}/present/${deck.props.shareId}` : null;
  return (
    <>
      <section className="inspector-section">
        <h3>Theme</h3>
        <div className="theme-grid" role="radiogroup" aria-label="Theme presets">
          {THEME_PRESETS.map((t) => (
            <button key={t.name} role="radio" aria-checked={theme.name === t.name} className="theme-swatch" style={{ background: t.colors.background, color: t.colors.text, fontFamily: t.fonts.heading }} onClick={() => setTheme(t, `Theme ${t.name}`)}>
              <span style={{ fontWeight: 700 }}>Aa</span>
              <span className="row" style={{ gap: 3 }}>
                <i style={{ background: t.colors.accent }} />
                <i style={{ background: t.colors.accent2 }} />
              </span>
              <small>{t.name}</small>
            </button>
          ))}
        </div>
        <ColorField label="Background" value={theme.colors.background} onChange={(v) => setTheme({ ...theme, name: 'Custom', colors: { ...theme.colors, background: v } })} />
        <ColorField label="Text" value={theme.colors.text} onChange={(v) => setTheme({ ...theme, name: 'Custom', colors: { ...theme.colors, text: v } })} />
        <ColorField label="Muted text" value={theme.colors.muted} onChange={(v) => setTheme({ ...theme, name: 'Custom', colors: { ...theme.colors, muted: v } })} />
        <ColorField label="Accent" value={theme.colors.accent} onChange={(v) => setTheme({ ...theme, name: 'Custom', colors: { ...theme.colors, accent: v } })} />
        <ColorField label="Second accent" value={theme.colors.accent2} onChange={(v) => setTheme({ ...theme, name: 'Custom', colors: { ...theme.colors, accent2: v } })} />
        <div className="field">
          <span className="label">Heading font</span>
          <FontSelect value={theme.fonts.heading} onChange={(v) => setTheme({ ...theme, fonts: { ...theme.fonts, heading: v } })} />
        </div>
        <div className="field">
          <span className="label">Body font</span>
          <FontSelect value={theme.fonts.body} onChange={(v) => setTheme({ ...theme, fonts: { ...theme.fonts, body: v } })} />
        </div>
        <div className="grid-2">
          <NumberField compact slider={false} label="Title size" value={theme.sizes.title} min={20} max={200} onCommit={(v) => setTheme({ ...theme, sizes: { ...theme.sizes, title: v } })} />
          <NumberField compact slider={false} label="Body size" value={theme.sizes.body} min={10} max={120} onCommit={(v) => setTheme({ ...theme, sizes: { ...theme.sizes, body: v } })} />
        </div>
      </section>
      <section className="inspector-section">
        <h3>Master slides</h3>
        {deck.props.masters.map((m, i) => (
          <div key={m.id} className="row" style={{ gap: 8 }}>
            <span className="grow" style={{ fontSize: 'var(--fs-sm)' }}>
              {m.name}
            </span>
            <ColorField label={`${m.name} background`} value={m.background} allowNone onClear={() => s.commit({ kind: 'update', id: ctx.deckId, set: { masters: deck.props.masters.map((x, j) => (j === i ? { ...x, background: null } : x)) } }, 'Master background')} onChange={(v) => s.commit({ kind: 'update', id: ctx.deckId, set: { masters: deck.props.masters.map((x, j) => (j === i ? { ...x, background: v } : x)) } }, 'Master background')} />
          </div>
        ))}
        <p className="muted hint-inline">Slides using a master take its background and placeholder positions.</p>
      </section>
      <section className="inspector-section">
        <h3>Slide size</h3>
        <Select
          label="Aspect"
          value={`${deck.props.width}x${deck.props.height}`}
          options={[
            { value: '1920x1080', label: 'Widescreen 16:9' },
            { value: '1440x1080', label: 'Standard 4:3' },
            { value: '1080x1080', label: 'Square 1:1' },
            { value: '1080x1350', label: 'Portrait 4:5' },
            ...(['1920x1080', '1440x1080', '1080x1080', '1080x1350'].includes(`${deck.props.width}x${deck.props.height}`) ? [] : [{ value: `${deck.props.width}x${deck.props.height}`, label: `Custom ${deck.props.width}×${deck.props.height}` }]),
          ]}
          onChange={(v) => {
            const [w, h] = v.split('x').map(Number) as [number, number];
            s.commit({ kind: 'update', id: ctx.deckId, set: { width: w, height: h } }, 'Change slide size');
          }}
        />
        {total !== null && <p className="muted hint-inline">Rehearsed length: {Math.floor(total / 60)} min {Math.round(total % 60)} s</p>}
      </section>
      <section className="inspector-section">
        <h3>
          <Globe size={14} /> Web link
        </h3>
        <Switch
          checked={!!deck.props.shareId}
          onChange={async (v) => {
            try {
              if (v) await post(`/api/projects/${s.projectId}/decks/${ctx.deckId}/share`);
              else await del(`/api/projects/${s.projectId}/decks/${ctx.deckId}/share`);
            } catch (e) {
              toast.error((e as Error).message);
            }
          }}
          label="Anyone with the link can watch"
          hint="The link shows this deck only, always the latest version. Turn it off to revoke it."
        />
        {shareUrl && (
          <div className="row" style={{ gap: 6 }}>
            <input className="input sm mono" readOnly value={shareUrl} aria-label="Presentation link" onFocus={(e) => e.target.select()} />
            <IconButton small label="Copy link" onClick={() => void navigator.clipboard?.writeText(shareUrl).then(() => toast.success('Link copied'))}>
              <Copy />
            </IconButton>
          </div>
        )}
      </section>
    </>
  );
}
