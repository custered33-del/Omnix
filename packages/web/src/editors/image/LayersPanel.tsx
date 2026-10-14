import { memo, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Eye, EyeOff, Lock, LockOpen, Plus, Trash2, Copy, FolderPlus, ImagePlus, SlidersHorizontal, ChevronRight, ChevronDown, Type, Square, PaintBucket, Image as ImageIcon, Folder, Scan, Layers } from 'lucide-react';
import { BLEND_MODES, childrenOf, type Adjustment, type BlendMode, type LayerType, type SceneNode } from '@omnix/core';
import { renderSingleLayer } from '@omnix/render';
import { useProject } from '../../state/project.js';
import { useHostVersion } from '../../render/context.js';
import { IconButton, MenuButton, NumberField, type MenuItemDef } from '../../ui/primitives.js';
import { AssetPicker } from '../../components/AssetPicker.js';
import { t } from '../../i18n/index.js';
import * as A from './actions.js';

const ADJUSTMENTS: Adjustment['kind'][] = ['brightnessContrast', 'levels', 'curves', 'hueSaturation', 'colorBalance', 'temperature', 'invert', 'lut'];

const BLEND_LABEL = (b: BlendMode) => b.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function LayersPanel({ ctx }: { ctx: A.ImageCtx }) {
  const state = useProject((s) => s.state)!;
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  const selectedId = useStore(ctx.ed, (s) => s.selectedLayerId);
  const [picker, setPicker] = useState<null | 'image' | 'lut' | 'psd'>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<{ id: string; over: string | null; where: 'before' | 'after' | 'into' } | null>(null);
  const selected = selectedId ? (state.nodes[selectedId] as SceneNode<'layer'> | undefined) : undefined;

  const rows: { node: SceneNode<'layer'>; depth: number }[] = [];
  const collect = (parentId: string, depth: number) => {
    const kids = childrenOf(state, parentId).filter((n): n is SceneNode<'layer'> => n.type === 'layer');
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i]!;
      rows.push({ node: k, depth });
      if (k.props.layerType === 'group' && !collapsed.has(k.id)) collect(k.id, depth + 1);
    }
  };
  collect(ctx.canvasId, 0);

  const select = (id: string) => {
    ctx.ed.getState().set({ selectedLayerId: id });
    ctx.store.getState().select([id]);
  };

  const addItems = (): MenuItemDef[] => [
    { label: t('image.addLayer'), heading: true },
    { label: t('image.layerTypes.raster'), icon: <ImageIcon />, onSelect: () => A.addLayer(ctx, 'raster') },
    { label: t('image.layerTypes.text'), icon: <Type />, onSelect: () => A.addLayer(ctx, 'text') },
    { label: t('image.layerTypes.vector'), icon: <Square />, onSelect: () => A.addLayer(ctx, 'vector') },
    { label: t('image.layerTypes.fill'), icon: <PaintBucket />, onSelect: () => A.addLayer(ctx, 'fill') },
    { label: t('image.layerTypes.group'), icon: <Folder />, onSelect: () => A.addLayer(ctx, 'group') },
    { label: t('image.importImage'), icon: <ImagePlus />, onSelect: () => setPicker('image') },
    { label: t('image.importPsd'), icon: <Layers />, onSelect: () => setPicker('psd') },
    { separator: true, label: '' },
    { label: t('image.layerTypes.adjustment'), heading: true },
    ...ADJUSTMENTS.map((k) => ({ label: t(`adjust.${k}`), icon: <SlidersHorizontal />, onSelect: () => (k === 'lut' ? setPicker('lut') : void A.addAdjustment(ctx, k)) })),
  ];

  const onDrop = () => {
    if (!drag || !drag.over || drag.over === drag.id) return setDrag(null);
    const target = state.nodes[drag.over] as SceneNode<'layer'>;
    let parentId: string;
    let index: number;
    if (drag.where === 'into' && target.props.layerType === 'group') {
      parentId = target.id;
      index = target.children.filter((c) => c !== drag.id).length; // top of the group
    } else {
      parentId = target.parentId!;
      const siblings = state.nodes[parentId]!.children.filter((c) => c !== drag.id);
      const ti = siblings.indexOf(target.id);
      // The list shows the top layer first, so "before" (above) means a higher child index.
      index = drag.where === 'before' ? ti + 1 : ti;
    }
    ctx.store.getState().commit({ kind: 'move', id: drag.id, parentId, index }, 'Reorder layers');
    setDrag(null);
  };

  const moveBy = (id: string, delta: number) => {
    const n = state.nodes[id]!;
    const siblings = state.nodes[n.parentId!]!.children;
    const i = siblings.indexOf(id);
    const j = Math.min(siblings.length - 1, Math.max(0, i + delta));
    if (i !== j) ctx.store.getState().commit({ kind: 'move', id, parentId: n.parentId!, index: j }, 'Reorder layers');
  };

  return (
    <section className="inspector-section layers" aria-labelledby="layers-h">
      <h3 id="layers-h">
        <span className="grow">{t('image.layers')}</span>
        {canEdit && (
          <>
            <IconButton small label={t('image.importImage')} onClick={() => setPicker('image')}>
              <ImagePlus />
            </IconButton>
            <MenuButton className="icon-btn sm" label={t('image.addLayer')} items={addItems}>
              <Plus />
            </MenuButton>
          </>
        )}
      </h3>
      {selected && canEdit && (
        <div className="row" style={{ gap: 8 }}>
          <select
            className="select sm"
            style={{ flex: 1 }}
            aria-label={t('image.blend')}
            value={selected.props.blendMode}
            onChange={(e) => A.updateLayer(ctx, selected.id, { blendMode: e.target.value as BlendMode }, 'Change blend mode')}
            disabled={selected.props.layerType === 'adjustment'}
          >
            {BLEND_MODES.map((b) => (
              <option key={b} value={b}>
                {BLEND_LABEL(b)}
              </option>
            ))}
          </select>
          <div style={{ width: 120 }}>
            <NumberField
              compact
              slider={false}
              label={t('image.opacity')}
              value={Math.round(selected.props.opacity * 100)}
              min={0}
              max={100}
              unit="%"
              onCommit={(v) => A.updateLayer(ctx, selected.id, { opacity: v / 100 }, 'Change opacity')}
            />
          </div>
        </div>
      )}
      <ul
        className="layer-list"
        role="tree"
        aria-label={t('image.layers')}
        onKeyDown={(e) => {
          if (!selectedId) return;
          const i = rows.findIndex((r) => r.node.id === selectedId);
          if (e.key === 'ArrowDown' && rows[i + 1]) {
            e.preventDefault();
            select(rows[i + 1]!.node.id);
          } else if (e.key === 'ArrowUp' && rows[i - 1]) {
            e.preventDefault();
            select(rows[i - 1]!.node.id);
          } else if (e.altKey && (e.key === '[' || e.key === ']')) {
            moveBy(selectedId, e.key === ']' ? 1 : -1);
          }
        }}
      >
        {rows.map(({ node, depth }) => {
          const p = node.props;
          const isSel = node.id === selectedId;
          const dropClass = drag?.over === node.id ? (drag.where === 'before' ? ' drop-before' : drag.where === 'after' ? ' drop-after' : ' drop-into') : '';
          return (
            <li
              key={node.id}
              role="treeitem"
              aria-selected={isSel}
              aria-level={depth + 1}
              aria-expanded={p.layerType === 'group' ? !collapsed.has(node.id) : undefined}
              tabIndex={isSel || (!selectedId && rows[0]?.node.id === node.id) ? 0 : -1}
              className={`layer-row${dropClass}${p.visible ? '' : ' is-hidden'}`}
              style={{ paddingLeft: 6 + depth * 16 }}
              draggable={canEdit}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', node.id);
                setDrag({ id: node.id, over: null, where: 'before' });
              }}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                const f = (e.clientY - r.top) / r.height;
                const where = p.layerType === 'group' && f > 0.3 && f < 0.7 ? 'into' : f < 0.5 ? 'before' : 'after';
                if (drag.over !== node.id || drag.where !== where) setDrag({ ...drag, over: node.id, where });
              }}
              onDragEnd={() => setDrag(null)}
              onDrop={(e) => {
                e.preventDefault();
                onDrop();
              }}
              onClick={() => select(node.id)}
              onDoubleClick={() => p.layerType === 'text' && ctx.ed.getState().set({ editingTextLayer: node.id, tool: 'move' })}
            >
              {p.layerType === 'group' ? (
                <button
                  className="icon-btn xs"
                  aria-label={collapsed.has(node.id) ? 'Expand group' : 'Collapse group'}
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = new Set(collapsed);
                    if (next.has(node.id)) next.delete(node.id);
                    else next.add(node.id);
                    setCollapsed(next);
                  }}
                >
                  {collapsed.has(node.id) ? <ChevronRight /> : <ChevronDown />}
                </button>
              ) : (
                <span style={{ width: 20 }} />
              )}
              <LayerThumb ctx={ctx} node={node} />
              <LayerName ctx={ctx} node={node} canEdit={canEdit} />
              {p.mask && (
                <span className={`mask-chip${p.mask.enabled ? '' : ' off'}`} title={p.mask.enabled ? t('image.mask') : `${t('image.mask')} (disabled)`} aria-label={t('image.mask')}>
                  <Scan size={13} />
                </span>
              )}
              <button
                className="icon-btn xs"
                aria-label={`${p.locked ? 'Unlock' : t('image.lock')} ${p.name}`}
                aria-pressed={p.locked}
                disabled={!canEdit}
                onClick={(e) => {
                  e.stopPropagation();
                  A.updateLayer(ctx, node.id, { locked: !p.locked }, p.locked ? 'Unlock layer' : 'Lock layer');
                }}
              >
                {p.locked ? <Lock /> : <LockOpen className="hover-only" />}
              </button>
              <button
                className="icon-btn xs"
                aria-label={`${p.visible ? 'Hide' : 'Show'} ${p.name}`}
                aria-pressed={!p.visible}
                disabled={!canEdit}
                onClick={(e) => {
                  e.stopPropagation();
                  A.updateLayer(ctx, node.id, { visible: !p.visible }, p.visible ? 'Hide layer' : 'Show layer');
                }}
              >
                {p.visible ? <Eye /> : <EyeOff />}
              </button>
            </li>
          );
        })}
        {rows.length === 0 && <li className="muted" style={{ padding: 12, fontSize: 'var(--fs-sm)' }}>No layers yet. Add one with +.</li>}
      </ul>
      {canEdit && selected && (
        <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
          <IconButton small label={t('app.duplicate')} shortcut="Ctrl+J" onClick={() => A.duplicateLayer(ctx)}>
            <Copy />
          </IconButton>
          <IconButton small label="Group" shortcut="Ctrl+G" onClick={() => A.groupSelected(ctx)}>
            <FolderPlus />
          </IconButton>
          <IconButton small label={t('app.delete')} onClick={() => A.deleteLayer(ctx)}>
            <Trash2 />
          </IconButton>
        </div>
      )}
      {picker === 'image' && <AssetPicker kinds={['image']} title={t('image.importImage')} projectId={ctx.store.getState().projectId} multiple onPick={(as) => as.forEach((a) => A.placeImage(ctx, a))} onClose={() => setPicker(null)} />}
      {picker === 'psd' && <AssetPicker kinds={['other']} mime="image/vnd.adobe.photoshop" accept=".psd" title={t('image.importPsd')} projectId={ctx.store.getState().projectId} onPick={([a]) => a && void A.openPsd(ctx, a)} onClose={() => setPicker(null)} />}
      {picker === 'lut' && <AssetPicker kinds={['lut']} title={t('image.lutImport')} projectId={ctx.store.getState().projectId} onPick={([a]) => a && A.addAdjustment(ctx, 'lut', a.id)} onClose={() => setPicker(null)} />}
    </section>
  );
}

function LayerName({ ctx, node, canEdit }: { ctx: A.ImageCtx; node: SceneNode<'layer'>; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const p = node.props;
  if (editing)
    return (
      <input
        className="input sm"
        autoFocus
        defaultValue={p.name}
        aria-label={t('app.rename')}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setEditing(false);
        }}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && v !== p.name) A.updateLayer(ctx, node.id, { name: v }, 'Rename layer');
          setEditing(false);
        }}
      />
    );
  return (
    <span className="name truncate" onDoubleClick={(e) => canEdit && p.layerType !== 'text' && (e.stopPropagation(), setEditing(true))} title={`${p.name} · ${t(`image.layerTypes.${p.layerType}`)}`}>
      {p.name}
      <span className="sr-only">, {t(`image.layerTypes.${p.layerType}`)}{p.visible ? '' : `, ${t('image.hidden')}`}{p.locked ? ', locked' : ''}</span>
    </span>
  );
}

const LayerThumb = memo(function LayerThumb({ ctx, node }: { ctx: A.ImageCtx; node: SceneNode<'layer'> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const hostVersion = useHostVersion();
  const state = useProject((s) => s.state)!;
  // Groups depend on their children, so they re-render with the state; leaf layers only when they change.
  const dep = node.props.layerType === 'group' ? state : node;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const id = requestIdleCallbackSafe(() => {
      const cp = (state.nodes[ctx.canvasId] as SceneNode<'canvas'>).props;
      const scale = 68 / Math.max(cp.width, cp.height);
      const ctx2 = c.getContext('2d')!;
      c.width = Math.max(1, Math.round(cp.width * scale));
      c.height = Math.max(1, Math.round(cp.height * scale));
      ctx2.clearRect(0, 0, c.width, c.height);
      if (node.props.layerType === 'adjustment') return;
      try {
        if (node.props.layerType === 'fill') {
          ctx2.fillStyle = node.props.fillColor ?? '#fff';
          ctx2.fillRect(0, 0, c.width, c.height);
        } else {
          const out = renderSingleLayer(ctx.host, state, node.id, { scale, includeMask: true });
          ctx2.drawImage(out as unknown as CanvasImageSource, 0, 0, c.width, c.height);
        }
      } catch {
        // A layer can disappear between scheduling and drawing.
      }
    });
    return () => cancelIdleSafe(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep, hostVersion]);
  return (
    <span className="layer-thumb" aria-hidden="true">
      {node.props.layerType === 'adjustment' ? <SlidersHorizontal size={16} style={{ margin: 4 }} /> : <canvas ref={ref} />}
    </span>
  );
});

const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
function requestIdleCallbackSafe(fn: () => void): number {
  return ric ? ric(fn, { timeout: 300 }) : window.setTimeout(fn, 30);
}
function cancelIdleSafe(id: number) {
  const c = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
  if (c) c(id);
  else window.clearTimeout(id);
}

export type { LayerType };
