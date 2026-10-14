import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import {
  MousePointer2,
  SquareDashed,
  CircleDashed,
  Lasso,
  WandSparkles,
  SquareDashedMousePointer,
  Brush,
  Eraser,
  Stamp,
  Bandage,
  Type,
  Shapes,
  Pipette,
  Hand,
  ZoomIn,
  ZoomOut,
  Maximize,
  Sparkles,
  PaintBucket,
  Scissors,
  Crop,
  ScanSearch,
  ArrowLeftRight,
} from 'lucide-react';
import type { SceneNode, ShapeKind } from '@omnix/core';
import { useProject, useProjectStore } from '../../state/project.js';
import { useRenderHost } from '../../render/context.js';
import { useShortcuts, formatShortcut } from '../../ui/shortcuts.js';
import { useCommands } from '../../state/commands.js';
import { ColorField, IconButton, MenuButton, NumberField, Spinner, Switch } from '../../ui/primitives.js';
import { t } from '../../i18n/index.js';
import { createImageEditorStore, TOOL_KEYS, type ImageEditorStore, type ImageTool } from './editorState.js';
import { Viewport } from './Viewport.js';
import { LayersPanel } from './LayersPanel.js';
import { PropertiesPanel } from './PropertiesPanel.js';
import * as A from './actions.js';
import '../../styles/editors.css';
import { FontSelect } from '../shared/FontSelect.js';

const TOOL_ICONS: Record<ImageTool, ReactNode> = {
  move: <MousePointer2 />,
  marquee: <SquareDashed />,
  ellipse: <CircleDashed />,
  lasso: <Lasso />,
  wand: <WandSparkles />,
  quick: <Brush />,
  object: <SquareDashedMousePointer />,
  brush: <Brush />,
  eraser: <Eraser />,
  clone: <Stamp />,
  heal: <Bandage />,
  text: <Type />,
  shape: <Shapes />,
  eyedropper: <Pipette />,
  hand: <Hand />,
  zoom: <ZoomIn />,
};

const RAIL: (ImageTool | '|')[] = ['move', '|', 'marquee', 'ellipse', 'lasso', 'wand', 'quick', 'object', '|', 'brush', 'eraser', 'clone', 'heal', '|', 'text', 'shape', '|', 'eyedropper', 'hand', 'zoom'];

const KEY_OF: Partial<Record<ImageTool, string>> = Object.fromEntries(Object.entries(TOOL_KEYS).map(([k, v]) => [v, k]));

export function ImageEditor({ canvasId }: { canvasId: string }) {
  const ed = useMemo(createImageEditorStore, []);
  const store = useProjectStore();
  const host = useRenderHost();
  const ctx: A.ImageCtx = useMemo(() => ({ store, host, ed, canvasId }), [store, host, ed, canvasId]);
  const tool = useStore(ed, (s) => s.tool);
  const zoom = useStore(ed, (s) => s.zoom);
  const busy = useStore(ed, (s) => s.busy);
  const canvas = useProject((s) => s.state?.nodes[canvasId]) as SceneNode<'canvas'> | undefined;
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  const hasSelection = !!canvas?.props.selection;

  // Keep the editor's selected layer in sync with the project selection (e.g. picked in history or by Claude).
  const projectSelection = useProject((s) => s.selection);
  useEffect(() => {
    const id = projectSelection[0];
    if (id && store.getState().state?.nodes[id]?.type === 'layer' && ed.getState().selectedLayerId !== id) ed.getState().set({ selectedLayerId: id });
  }, [projectSelection, ed, store]);

  const fit = () => {
    const el = document.querySelector('.viewport') as HTMLElement | null;
    if (!el || !canvas) return;
    const z = Math.min((el.clientWidth - 80) / canvas.props.width, (el.clientHeight - 80) / canvas.props.height);
    ed.getState().set({ zoom: z, pan: { x: (el.clientWidth - canvas.props.width * z) / 2, y: (el.clientHeight - canvas.props.height * z) / 2 } });
  };
  const zoomBy = (f: number) => {
    const el = document.querySelector('.viewport') as HTMLElement | null;
    const st = ed.getState();
    const z = Math.min(32, Math.max(0.02, st.zoom * f));
    const cx = (el?.clientWidth ?? 0) / 2;
    const cy = (el?.clientHeight ?? 0) / 2;
    st.set({ zoom: z, pan: { x: cx - ((cx - st.pan.x) / st.zoom) * z, y: cy - ((cy - st.pan.y) / st.zoom) * z } });
  };

  const toolShortcuts = Object.fromEntries(Object.entries(TOOL_KEYS).map(([key, tl]) => [key, () => ed.getState().set({ tool: tl === 'marquee' && ed.getState().tool === 'marquee' ? 'ellipse' : tl })]));
  useShortcuts(
    {
      ...toolShortcuts,
      'mod+0': fit,
      'mod+=': () => zoomBy(1.25),
      'mod+shift+=': () => zoomBy(1.25),
      'mod+-': () => zoomBy(0.8),
      'mod+1': () => {
        ed.getState().set({ zoom: 1 });
      },
      'mod+d': () => A.deselect(ctx),
      'mod+a': () => A.selectAll(ctx),
      'mod+shift+i': () => void A.invertSelection(ctx),
      'mod+j': () => A.duplicateLayer(ctx),
      'mod+g': () => A.groupSelected(ctx),
      del: () => (hasSelection ? void A.clearSelectionPixels(ctx) : A.deleteLayer(ctx)),
      'shift+f5': () => A.fillSelection(ctx),
      arrowleft: () => A.nudge(ctx, -1, 0),
      arrowright: () => A.nudge(ctx, 1, 0),
      arrowup: () => A.nudge(ctx, 0, -1),
      arrowdown: () => A.nudge(ctx, 0, 1),
      'shift+arrowleft': () => A.nudge(ctx, -10, 0),
      'shift+arrowright': () => A.nudge(ctx, 10, 0),
      'shift+arrowup': () => A.nudge(ctx, 0, -10),
      'shift+arrowdown': () => A.nudge(ctx, 0, 10),
      '[': () => resizeBrush(ed, 0.85),
      ']': () => resizeBrush(ed, 1.18),
      x: () => {
        const s = ed.getState();
        s.set({ color: s.secondaryColor, secondaryColor: s.color });
      },
      esc: () => {
        if (ed.getState().editingTextLayer) return false;
        A.deselect(ctx);
      },
    },
    [ctx, hasSelection],
  );

  // Space held = temporary hand tool.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || (e.target as HTMLElement).closest('input, textarea, [contenteditable]')) return;
      e.preventDefault();
      ed.getState().set({ springTool: 'hand' });
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') ed.getState().set({ springTool: null });
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [ed]);

  useCommands(
    'image',
    [
      { id: 'img.selectAll', label: t('image.selectAll'), section: t('tools.imageLong'), shortcut: 'mod+a', run: () => A.selectAll(ctx) },
      { id: 'img.deselect', label: t('image.deselect'), section: t('tools.imageLong'), shortcut: 'mod+d', run: () => A.deselect(ctx) },
      { id: 'img.invert', label: t('image.invertSelection'), section: t('tools.imageLong'), shortcut: 'mod+shift+i', run: () => void A.invertSelection(ctx) },
      { id: 'img.caf', label: t('image.contentAwareFill'), section: t('tools.imageLong'), run: () => void A.contentAwareFill(ctx) },
      { id: 'img.fill', label: t('image.fillSelection'), section: t('tools.imageLong'), run: () => A.fillSelection(ctx) },
      { id: 'img.crop', label: 'Crop to selection', section: t('tools.imageLong'), run: () => void A.cropToSelection(ctx) },
      { id: 'img.removebg', label: t('video.removeBackground'), section: t('tools.imageLong'), run: () => void A.removeLayerBackground(ctx) },
      { id: 'img.fit', label: t('shortcuts.zoomFit'), section: t('tools.imageLong'), shortcut: 'mod+0', run: fit },
      ...RAIL.filter((x): x is ImageTool => x !== '|').map((tl) => ({ id: `img.tool.${tl}`, label: t(`image.tools.${tl}`), section: t('tools.imageLong'), keywords: 'tool', ...(KEY_OF[tl] ? { shortcut: KEY_OF[tl] } : {}), run: () => ed.getState().set({ tool: tl }) })),
    ],
    [ctx],
  );

  if (!canvas) return null;
  return (
    <div className="editor image-editor">
      <div className="editor-toolbar" role="toolbar" aria-label={`${t(`image.tools.${tool}`)} options`}>
        <ToolOptions ed={ed} ctx={ctx} />
        <span className="spacer" />
        {busy && (
          <span className="row muted" style={{ fontSize: 'var(--fs-sm)' }} role="status">
            <Spinner /> {busy}
          </span>
        )}
        {hasSelection && canEdit && (
          <div className="row" style={{ gap: 2 }}>
            <IconButton label={t('image.contentAwareFill')} onClick={() => void A.contentAwareFill(ctx)}>
              <Sparkles />
            </IconButton>
            <IconButton label={t('image.fillSelection')} shortcut={formatShortcut('shift+F5')} onClick={() => A.fillSelection(ctx)}>
              <PaintBucket />
            </IconButton>
            <IconButton label={t('image.deleteSelection')} shortcut="Del" onClick={() => void A.clearSelectionPixels(ctx)}>
              <Scissors />
            </IconButton>
            <IconButton label="Crop to selection" onClick={() => void A.cropToSelection(ctx)}>
              <Crop />
            </IconButton>
            <IconButton label={t('image.addMask')} onClick={() => A.maskFromSelection(ctx)}>
              <ScanSearch />
            </IconButton>
            <IconButton label={t('image.invertSelection')} shortcut={formatShortcut('mod+shift+i')} onClick={() => void A.invertSelection(ctx)}>
              <ArrowLeftRight />
            </IconButton>
            <button className="btn btn-sm btn-ghost" onClick={() => A.deselect(ctx)}>
              {t('image.deselect')}
            </button>
          </div>
        )}
      </div>
      <div className="tool-rail" role="toolbar" aria-orientation="vertical" aria-label="Tools">
        {RAIL.map((tl, i) =>
          tl === '|' ? (
            <div key={i} className="rail-sep" role="separator" />
          ) : (
            <IconButton key={tl} label={t(`image.tools.${tl}`)} {...(KEY_OF[tl] ? { shortcut: KEY_OF[tl]!.toUpperCase() } : {})} pressed={tool === tl} onClick={() => ed.getState().set({ tool: tl })}>
              {TOOL_ICONS[tl]}
            </IconButton>
          ),
        )}
        <div className="rail-sep" role="separator" />
        <ColorSwatches ed={ed} />
      </div>
      <div style={{ position: 'relative', minWidth: 0, minHeight: 0, display: 'flex' }}>
        <Viewport canvasId={canvasId} ed={ed} />
        <div className="zoom-indicator" role="group" aria-label="Zoom">
          <IconButton small label={t('shortcuts.zoomOut')} shortcut={formatShortcut('mod+-')} onClick={() => zoomBy(0.8)}>
            <ZoomOut />
          </IconButton>
          <button className="btn btn-sm btn-ghost tabular" onClick={fit} title={t('shortcuts.zoomFit')} style={{ minWidth: 56 }}>
            {Math.round(zoom * 100)}%
          </button>
          <IconButton small label={t('shortcuts.zoomIn')} shortcut={formatShortcut('mod+=')} onClick={() => zoomBy(1.25)}>
            <ZoomIn />
          </IconButton>
          <IconButton small label={t('shortcuts.zoomFit')} shortcut={formatShortcut('mod+0')} onClick={fit}>
            <Maximize />
          </IconButton>
        </div>
      </div>
      <aside className="inspector" aria-label={t('image.properties')}>
        <PropertiesPanel ctx={ctx} />
        <LayersPanel ctx={ctx} />
      </aside>
    </div>
  );
}

function resizeBrush(ed: ImageEditorStore, f: number) {
  const s = ed.getState();
  const key = s.tool === 'eraser' ? 'eraser' : s.tool === 'clone' || s.tool === 'heal' ? 'clone' : 'brush';
  const cur = s[key];
  s.set({ [key]: { ...cur, size: Math.max(1, Math.min(1000, Math.round(cur.size * f))) } } as never);
}

function ColorSwatches({ ed }: { ed: ImageEditorStore }) {
  const color = useStore(ed, (s) => s.color);
  const secondary = useStore(ed, (s) => s.secondaryColor);
  return (
    <div className="swatches" aria-label="Colors">
      <label className="swatch primary" style={{ background: color }} title={`${t('image.color')} ${color}`}>
        <input type="color" value={color.slice(0, 7)} onChange={(e) => ed.getState().set({ color: e.target.value })} aria-label={t('image.color')} />
      </label>
      <label className="swatch secondary" style={{ background: secondary }} title={`Secondary ${secondary} (X swaps)`}>
        <input type="color" value={secondary.slice(0, 7)} onChange={(e) => ed.getState().set({ secondaryColor: e.target.value })} aria-label="Secondary color" />
      </label>
    </div>
  );
}

/** Context-sensitive options for the active tool. */
function ToolOptions({ ed, ctx }: { ed: ImageEditorStore; ctx: A.ImageCtx }) {
  const s = useStore(ed);
  const tool = s.tool;
  const [, force] = useState(0);
  void force;
  if (['brush', 'eraser', 'clone', 'heal'].includes(tool)) {
    const key = tool === 'eraser' ? 'eraser' : tool === 'brush' ? 'brush' : 'clone';
    const b = s[key];
    const set = (patch: Partial<typeof b>) => s.set({ [key]: { ...b, ...patch } } as never);
    return (
      <div className="tool-options">
        <span className="tool-name">{t(`image.tools.${tool}`)}</span>
        <NumberField compact label={t('image.size')} value={b.size} min={1} max={500} unit="px" onCommit={(v) => set({ size: v })} />
        <NumberField compact label={t('image.hardness')} value={Math.round(b.hardness * 100)} min={0} max={100} unit="%" onCommit={(v) => set({ hardness: v / 100 })} />
        <NumberField compact label={t('image.opacity')} value={Math.round(b.opacity * 100)} min={1} max={100} unit="%" onCommit={(v) => set({ opacity: v / 100 })} />
        {tool === 'brush' && <NumberField compact label={t('image.stabilizer')} value={Math.round(b.stabilizer * 100)} min={0} max={100} unit="%" onCommit={(v) => set({ stabilizer: v / 100 })} />}
        <div className="segmented" role="group" aria-label="Tip">
          {(['round', 'square'] as const).map((tip) => (
            <button key={tip} aria-pressed={b.tip === tip} onClick={() => set({ tip })}>
              {tip === 'round' ? 'Round' : 'Square'}
            </button>
          ))}
        </div>
        {(tool === 'clone' || tool === 'heal') && <span className="muted hint-inline">{s.clone.source ? `Source ${Math.round(s.clone.source.x)}, ${Math.round(s.clone.source.y)}` : t('image.sourceHint')}</span>}
      </div>
    );
  }
  if (['marquee', 'ellipse', 'lasso', 'wand', 'quick', 'object'].includes(tool)) {
    return (
      <div className="tool-options">
        <span className="tool-name">{t(`image.tools.${tool}`)}</span>
        <div className="segmented" role="group" aria-label="Selection mode">
          {(['replace', 'add', 'subtract'] as const).map((m) => (
            <button key={m} aria-pressed={s.select.mode === m} onClick={() => s.set({ select: { ...s.select, mode: m } })}>
              {m === 'replace' ? 'New' : m === 'add' ? 'Add' : 'Subtract'}
            </button>
          ))}
        </div>
        {['marquee', 'ellipse', 'lasso'].includes(tool) && <NumberField compact label={t('image.feather')} value={s.select.feather} min={0} max={200} unit="px" onCommit={(v) => s.set({ select: { ...s.select, feather: v } })} />}
        {['wand', 'quick'].includes(tool) && <NumberField compact label={t('image.tolerance')} value={s.wand.tolerance} min={0} max={255} onCommit={(v) => s.set({ wand: { ...s.wand, tolerance: v } })} />}
        {tool === 'wand' && <Switch checked={s.wand.contiguous} onChange={(v) => s.set({ wand: { ...s.wand, contiguous: v } })} label={t('image.contiguous')} />}
        {['wand', 'quick', 'object'].includes(tool) && <Switch checked={s.wand.sampleAll} onChange={(v) => s.set({ wand: { ...s.wand, sampleAll: v } })} label="Sample all layers" />}
        {tool === 'object' && <span className="muted hint-inline">Drag a box around the object</span>}
      </div>
    );
  }
  if (tool === 'shape') {
    return (
      <div className="tool-options">
        <span className="tool-name">{t('image.tools.shape')}</span>
        <div className="segmented" role="group" aria-label="Shape">
          {(['rect', 'ellipse', 'line'] as ShapeKind[]).map((k) => (
            <button key={k} aria-pressed={s.shape.kind === k} onClick={() => s.set({ shape: { ...s.shape, kind: k } })}>
              {t(`image.shapeKinds.${k as 'rect'}`)}
            </button>
          ))}
        </div>
        <ColorField label={t('image.fill')} value={s.shape.fill} allowNone onClear={() => s.set({ shape: { ...s.shape, fill: null } })} onChange={(v) => s.set({ shape: { ...s.shape, fill: v } })} />
        <ColorField label={t('image.stroke')} value={s.shape.stroke} allowNone onClear={() => s.set({ shape: { ...s.shape, stroke: null } })} onChange={(v) => s.set({ shape: { ...s.shape, stroke: v } })} />
        <NumberField compact label={t('image.strokeWidth')} value={s.shape.strokeWidth} min={0} max={100} slider={false} onCommit={(v) => s.set({ shape: { ...s.shape, strokeWidth: v } })} />
        {s.shape.kind === 'rect' && <NumberField compact label="Corner radius" value={s.shape.radius} min={0} max={500} slider={false} onCommit={(v) => s.set({ shape: { ...s.shape, radius: v } })} />}
      </div>
    );
  }
  if (tool === 'text') {
    return (
      <div className="tool-options">
        <span className="tool-name">{t('image.tools.text')}</span>
        <FontSelect value={s.text.fontFamily} onChange={(v) => s.set({ text: { ...s.text, fontFamily: v } })} />
        <NumberField compact label={t('image.fontSize')} value={s.text.fontSize} min={4} max={800} slider={false} unit="px" onCommit={(v) => s.set({ text: { ...s.text, fontSize: v } })} />
        <NumberField compact label={t('image.weight')} value={s.text.fontWeight} min={100} max={900} step={50} slider={false} onCommit={(v) => s.set({ text: { ...s.text, fontWeight: v } })} />
        <span className="muted hint-inline">Click to add text, click existing text to edit</span>
      </div>
    );
  }
  if (tool === 'move') {
    return (
      <div className="tool-options">
        <span className="tool-name">{t('image.tools.move')}</span>
        <MenuButton
          className="btn btn-sm"
          label={t('image.align')}
          items={[
            { label: 'Align left', onSelect: () => A.alignLayer(ctx, 'left') },
            { label: 'Align centre', onSelect: () => A.alignLayer(ctx, 'hcenter') },
            { label: 'Align right', onSelect: () => A.alignLayer(ctx, 'right') },
            { separator: true, label: '' },
            { label: 'Align top', onSelect: () => A.alignLayer(ctx, 'top') },
            { label: 'Align middle', onSelect: () => A.alignLayer(ctx, 'vcenter') },
            { label: 'Align bottom', onSelect: () => A.alignLayer(ctx, 'bottom') },
          ]}
        >
          {t('image.align')}
        </MenuButton>
        <span className="muted hint-inline">Drag to move · corner handles resize (Shift keeps proportions) · arrows nudge</span>
      </div>
    );
  }
  return (
    <div className="tool-options">
      <span className="tool-name">{t(`image.tools.${tool}`)}</span>
      {tool === 'zoom' && <span className="muted hint-inline">Click to zoom in, Alt-click to zoom out</span>}
      {tool === 'eyedropper' && <span className="muted hint-inline">Click to pick a color from the image</span>}
      {tool === 'hand' && <span className="muted hint-inline">Drag to pan. Hold Space with any tool.</span>}
    </div>
  );
}
