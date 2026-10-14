import { memo, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { MousePointer2, Brush, Eraser, Square, Circle, Bone as BoneIcon, Hand, Route, Plus, Copy, Trash2, Eye, EyeOff, Minus, ImagePlus, Layers } from 'lucide-react';
import type { AnimFrame, SceneNode } from '@omnix/core';
import { childrenOf, makeNode, newId, tracksOf } from '@omnix/core';
import { drawFrameContent, frameIndexAt } from '@omnix/render';
import { useProject } from '../../state/project.js';
import { useRenderHost, useHostVersion } from '../../render/context.js';
import { ColorField, IconButton, NumberField, Switch } from '../../ui/primitives.js';
import { AssetPicker } from '../../components/AssetPicker.js';
import { EasingEditor } from '../shared/EasingEditor.js';
import { t } from '../../i18n/index.js';
import type { AnimTool } from '../video/timelineState.js';
import type { TimelineCtx } from '../video/timelineOps.js';
import { activeAnimLayer } from './useAnimationStage.js';

const TOOLS: { tool: AnimTool; icon: typeof Brush; label: string }[] = [
  { tool: 'select', icon: MousePointer2, label: 'Move layer' },
  { tool: 'brush', icon: Brush, label: 'Brush' },
  { tool: 'eraser', icon: Eraser, label: 'Eraser' },
  { tool: 'rect', icon: Square, label: 'Rectangle' },
  { tool: 'ellipse', icon: Circle, label: 'Ellipse' },
  { tool: 'bone', icon: BoneIcon, label: t('anim.addBone') },
  { tool: 'pose', icon: Hand, label: t('anim.poseMode') },
  { tool: 'path', icon: Route, label: t('anim.drawPath') },
];

/** Start time (layer-local seconds) of each drawing frame, from the per-frame holds. */
function frameStarts(frames: readonly AnimFrame[], fps: number): number[] {
  let tick = 0;
  return frames.map((f) => {
    const s = tick / fps;
    tick += Math.max(1, f.hold);
    return s;
  });
}

export function AnimationPanel({ ctx }: { ctx: TimelineCtx }) {
  const { ed, store } = ctx;
  const state = useProject((s) => s.state)!;
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  const tool = useStore(ed, (s) => s.animTool);
  const brush = useStore(ed, (s) => s.brush);
  const shapeFill = useStore(ed, (s) => s.shapeFill);
  const selected = useStore(ed, (s) => s.selectedClips);
  const time = useStore(ed, (s) => s.time);
  const showBones = useStore(ed, (s) => s.showBones);
  const pathDraft = useStore(ed, (s) => s.pathDraft);
  const [spritePicker, setSpritePicker] = useState(false);
  const seq = state.nodes[ctx.sequenceId] as SceneNode<'sequence'>;
  const fps = seq.props.fps;
  const layer = activeAnimLayer(state, ctx.sequenceId, selected);
  const s = store.getState();
  const layers = tracksOf(state, ctx.sequenceId).flatMap((tr) => childrenOf(state, tr.id).filter((n): n is SceneNode<'animLayer'> => n.type === 'animLayer'));
  const p = layer?.props;
  const local = layer ? Math.max(0, time - layer.props.start) : 0;
  const idx = p && p.frames.length ? frameIndexAt(p, local, fps) : -1;
  const starts = p ? frameStarts(p.frames, fps) : [];
  const upd = (set: Record<string, unknown>, label: string) => layer && s.commit({ kind: 'update', id: layer.id, set }, label);

  const addLayer = () => {
    let track = tracksOf(state, ctx.sequenceId).find((tr) => tr.props.trackType === 'animation');
    const ops = [];
    if (!track) {
      track = makeNode('track', { name: 'Animation', trackType: 'animation' });
      ops.push({ kind: 'create' as const, parentId: ctx.sequenceId, index: 0, nodes: [track] });
    }
    const node = makeNode('animLayer', { name: `Layer ${layers.length + 1}`, start: 0, duration: seq.props.duration });
    ops.push({ kind: 'create' as const, parentId: track.id, nodes: [node] });
    if (s.commit(ops.length === 1 ? ops[0]! : { kind: 'batch', ops }, 'Add animation layer')) ed.getState().set({ selectedClips: [node.id] });
  };

  const insertFrame = (copy: boolean) => {
    if (!layer || !p) return;
    const src = p.frames[idx];
    const f: AnimFrame = copy && src ? { ...structuredClone(src), id: newId('frm') } : { id: newId('frm'), hold: src?.hold ?? 1, shapes: [], strokes: [], assetId: null };
    const at = idx + 1;
    if (s.commit({ kind: 'listInsert', id: layer.id, prop: 'frames', index: at, items: [f] }, copy ? t('anim.duplicateFrame') : t('anim.addFrame'))) {
      const nextStarts = frameStarts([...p.frames.slice(0, at), f], fps);
      ed.getState().set({ time: layer.props.start + nextStarts[at]! + 1e-4 });
    }
  };

  return (
    <aside className="tl-media" aria-label="Animation tools">
      <div className="panel-header">
        <span className="grow">{t('anim.layers')}</span>
        {canEdit && (
          <IconButton small label={t('anim.addLayer')} onClick={addLayer}>
            <Plus />
          </IconButton>
        )}
      </div>
      <ul className="layer-list" style={{ padding: '4px 8px' }} aria-label={t('anim.layers')}>
        {layers.map((l) => (
          <li key={l.id} className="layer-row" aria-selected={l.id === layer?.id} onClick={() => ed.getState().set({ selectedClips: [l.id], inspectorTab: 'clip' })} style={{ minHeight: 32 }}>
            <Layers size={14} aria-hidden="true" />
            <span className="name truncate">{l.props.name}</span>
            <button className="icon-btn xs" aria-label={`${l.props.visible ? 'Hide' : 'Show'} ${l.props.name}`} disabled={!canEdit} onClick={(e) => (e.stopPropagation(), s.commit({ kind: 'update', id: l.id, set: { visible: !l.props.visible } }, 'Toggle layer'))}>
              {l.props.visible ? <Eye /> : <EyeOff />}
            </button>
            <button className="icon-btn xs" aria-label={`${t('app.delete')} ${l.props.name}`} disabled={!canEdit} onClick={(e) => (e.stopPropagation(), s.commit({ kind: 'delete', id: l.id }, `Delete ${l.props.name}`))}>
              <Trash2 />
            </button>
          </li>
        ))}
      </ul>

      <section className="inspector-section">
        <h3>Tools</h3>
        <div className="row" style={{ flexWrap: 'wrap', gap: 2 }} role="toolbar" aria-label="Animation tools">
          {TOOLS.map(({ tool: tl, icon: Icon, label }) => (
            <IconButton key={tl} label={label} pressed={tool === tl} onClick={() => ed.getState().set({ animTool: tl, pathDraft: tl === 'path' ? ed.getState().pathDraft : null })}>
              <Icon />
            </IconButton>
          ))}
        </div>
        {(tool === 'brush' || tool === 'eraser') && (
          <>
            <NumberField compact label={t('image.size')} value={brush.size} min={1} max={200} unit="px" onCommit={(v) => ed.getState().set({ brush: { ...brush, size: v } })} />
            {tool === 'brush' && <ColorField label={t('image.color')} value={brush.color} onChange={(v) => ed.getState().set({ brush: { ...brush, color: v } })} />}
            <NumberField compact label={t('image.opacity')} value={Math.round(brush.opacity * 100)} min={1} max={100} unit="%" onCommit={(v) => ed.getState().set({ brush: { ...brush, opacity: v / 100 } })} />
          </>
        )}
        {(tool === 'rect' || tool === 'ellipse') && <ColorField label={t('image.fill')} value={shapeFill} onChange={(v) => ed.getState().set({ shapeFill: v })} />}
        {tool === 'bone' && <p className="muted hint-inline">Drag to draw a bone. Start at the end of a bone to chain onto it.</p>}
        {tool === 'pose' && <p className="muted hint-inline">Drag the end of a bone; the chain follows (IK). Each pose is saved at the playhead.</p>}
        {tool === 'path' && (
          <div className="col" style={{ gap: 6 }}>
            <p className="muted hint-inline">Click to add points, double-click to finish. The layer follows the path over its duration.</p>
            {pathDraft && pathDraft.length > 0 && (
              <div className="row" style={{ gap: 6 }}>
                <button className="btn btn-sm btn-primary" disabled={pathDraft.length < 2} onClick={() => layer && (s.commit({ kind: 'update', id: layer.id, set: { motionPath: { path: { closed: false, anchors: pathDraft }, orientToPath: p?.motionPath?.orientToPath ?? false, easing: p?.motionPath?.easing ?? 'ease-in-out' } } }, 'Set motion path'), ed.getState().set({ pathDraft: null }))}>
                  {t('app.done')}
                </button>
                <button className="btn btn-sm" onClick={() => ed.getState().set({ pathDraft: null })}>
                  {t('app.cancel')}
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {layer && p && (
        <>
          <section className="inspector-section">
            <h3>
              <span className="grow">{t('anim.frames')}</span>
              <span className="muted tabular" style={{ fontWeight: 400 }}>
                {idx >= 0 ? `${idx + 1} / ${p.frames.length}` : 'none'}
              </span>
            </h3>
            <FrameStrip ctx={ctx} layer={layer} current={idx} starts={starts} />
            <div className="row" style={{ gap: 2, flexWrap: 'wrap' }}>
              <IconButton small label={t('anim.addFrame')} onClick={() => insertFrame(false)} disabled={!canEdit}>
                <Plus />
              </IconButton>
              <IconButton small label={t('anim.duplicateFrame')} onClick={() => insertFrame(true)} disabled={!canEdit || idx < 0}>
                <Copy />
              </IconButton>
              <IconButton small label={t('anim.deleteFrame')} onClick={() => s.commit({ kind: 'listRemove', id: layer.id, prop: 'frames', index: idx, count: 1 }, t('anim.deleteFrame'))} disabled={!canEdit || idx < 0}>
                <Trash2 />
              </IconButton>
              <span className="spacer" />
              {idx >= 0 && (
                <>
                  <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                    {t('anim.hold')}
                  </span>
                  <IconButton small label="Shorter hold" disabled={!canEdit || p.frames[idx]!.hold <= 1} onClick={() => s.commit({ kind: 'listUpdate', id: layer.id, prop: 'frames', itemId: p.frames[idx]!.id, set: { hold: p.frames[idx]!.hold - 1 } }, 'Change hold')}>
                    <Minus />
                  </IconButton>
                  <span className="tabular" aria-live="polite">{p.frames[idx]!.hold}</span>
                  <IconButton small label="Longer hold" disabled={!canEdit} onClick={() => s.commit({ kind: 'listUpdate', id: layer.id, prop: 'frames', itemId: p.frames[idx]!.id, set: { hold: p.frames[idx]!.hold + 1 } }, 'Change hold')}>
                    <Plus />
                  </IconButton>
                </>
              )}
            </div>
            <Switch checked={p.onionSkin.enabled} onChange={(v) => upd({ onionSkin: { ...p.onionSkin, enabled: v } }, t('anim.onionSkin'))} label={t('anim.onionSkin')} />
            {p.onionSkin.enabled && (
              <div className="grid-2">
                <NumberField compact slider={false} label={t('anim.before')} value={p.onionSkin.before} min={0} max={5} onCommit={(v) => upd({ onionSkin: { ...p.onionSkin, before: v } }, t('anim.onionSkin'))} />
                <NumberField compact slider={false} label={t('anim.after')} value={p.onionSkin.after} min={0} max={5} onCommit={(v) => upd({ onionSkin: { ...p.onionSkin, after: v } }, t('anim.onionSkin'))} />
              </div>
            )}
          </section>

          <section className="inspector-section">
            <h3>{t('anim.rig')}</h3>
            <Switch checked={showBones} onChange={(v) => ed.getState().set({ showBones: v })} label="Show bones" />
            {p.rig && p.rig.bones.length > 0 ? (
              <>
                <ul className="git-list" aria-label="Bones">
                  {p.rig.bones.map((b) => (
                    <li key={b.id} className="row" style={{ cursor: 'default' }}>
                      <span className="grow">
                        {b.name}
                        {b.parentId && <span className="muted"> · child of {p.rig!.bones.find((x) => x.id === b.parentId)?.name}</span>}
                      </span>
                      <button
                        className="icon-btn xs"
                        aria-label={`${t('app.delete')} ${b.name}`}
                        disabled={!canEdit}
                        onClick={() => {
                          // Removing a bone removes its children too.
                          const gone = new Set([b.id]);
                          let grew = true;
                          while (grew) {
                            grew = false;
                            for (const x of p.rig!.bones) if (x.parentId && gone.has(x.parentId) && !gone.has(x.id)) (gone.add(x.id), (grew = true));
                          }
                          upd({ rig: { bones: p.rig!.bones.filter((x) => !gone.has(x.id)), poses: p.rig!.poses.map((q) => ({ ...q, angles: Object.fromEntries(Object.entries(q.angles).filter(([k]) => !gone.has(k))) })) } }, 'Delete bone');
                        }}
                      >
                        <Trash2 />
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="row muted" style={{ fontSize: 'var(--fs-xs)', justifyContent: 'space-between' }}>
                  <span>{p.rig.poses.length} saved {p.rig.poses.length === 1 ? 'pose' : 'poses'}</span>
                  {p.rig.poses.length > 0 && (
                    <button className="btn btn-sm btn-ghost" disabled={!canEdit} onClick={() => upd({ rig: { ...p.rig!, poses: [] } }, 'Clear poses')}>
                      Clear poses
                    </button>
                  )}
                </div>
              </>
            ) : (
              <p className="muted hint-inline">No bones yet. Use the bone tool to build a skeleton.</p>
            )}
          </section>

          <section className="inspector-section">
            <h3>{t('anim.motionPath')}</h3>
            {p.motionPath ? (
              <>
                <Switch checked={p.motionPath.orientToPath} onChange={(v) => upd({ motionPath: { ...p.motionPath!, orientToPath: v } }, t('anim.orient'))} label={t('anim.orient')} />
                <EasingEditor value={p.motionPath.easing} onChange={(e) => upd({ motionPath: { ...p.motionPath!, easing: e } }, 'Path easing')} />
                <button className="btn btn-sm btn-ghost" onClick={() => upd({ motionPath: null }, 'Remove motion path')}>
                  Remove path
                </button>
              </>
            ) : (
              <button className="btn btn-sm" onClick={() => ed.getState().set({ animTool: 'path', pathDraft: [] })} disabled={!canEdit}>
                <Route /> {t('anim.drawPath')}
              </button>
            )}
          </section>

          <section className="inspector-section">
            <h3>{t('anim.spriteSheet')}</h3>
            {p.sprite ? (
              <>
                <div className="grid-2">
                  <NumberField compact slider={false} label={t('anim.columns')} value={p.sprite.columns} min={1} max={64} onCommit={(v) => upd({ sprite: { ...p.sprite!, columns: v } }, 'Sprite sheet')} />
                  <NumberField compact slider={false} label={t('anim.rows')} value={p.sprite.rows} min={1} max={64} onCommit={(v) => upd({ sprite: { ...p.sprite!, rows: v } }, 'Sprite sheet')} />
                  <NumberField compact slider={false} label={t('anim.frameCount')} value={p.sprite.frameCount} min={1} max={4096} onCommit={(v) => upd({ sprite: { ...p.sprite!, frameCount: v } }, 'Sprite sheet')} />
                </div>
                <button className="btn btn-sm btn-ghost" onClick={() => upd({ sprite: null }, 'Remove sprite sheet')}>
                  Remove sprite sheet
                </button>
              </>
            ) : (
              <button className="btn btn-sm" onClick={() => setSpritePicker(true)} disabled={!canEdit}>
                <ImagePlus /> {t('anim.importSprite')}
              </button>
            )}
          </section>
          {spritePicker && (
            <AssetPicker
              kinds={['image']}
              title={t('anim.importSprite')}
              projectId={store.getState().projectId}
              onPick={([a]) => {
                if (!a) return;
                const cols = Math.max(1, Math.round((a.width ?? 64) / (a.height ?? 64)));
                upd({ sprite: { assetId: a.id, columns: cols, rows: 1, frameCount: cols, frameWidth: Math.round((a.width ?? 64) / cols), frameHeight: a.height ?? 64 } }, t('anim.importSprite'));
              }}
              onClose={() => setSpritePicker(false)}
            />
          )}
        </>
      )}
    </aside>
  );
}

function FrameStrip({ ctx, layer, current, starts }: { ctx: TimelineCtx; layer: SceneNode<'animLayer'>; current: number; starts: number[] }) {
  const p = layer.props;
  if (!p.frames.length) return <p className="muted hint-inline">Draw on the stage to create the first frame.</p>;
  return (
    <div className="frame-strip" role="listbox" aria-label={t('anim.frames')}>
      {p.frames.map((f, i) => (
        <button key={f.id} className="frame-cell" role="option" aria-selected={i === current} onClick={() => ctx.ed.getState().set({ time: p.start + starts[i]! + 1e-4, playing: false })} aria-label={`Frame ${i + 1}, held ${f.hold}`}>
          <FrameThumb layer={layer} index={i} />
          {i + 1}
          {f.hold > 1 ? ` ×${f.hold}` : ''}
        </button>
      ))}
    </div>
  );
}

const FrameThumb = memo(function FrameThumb({ layer, index }: { layer: SceneNode<'animLayer'>; index: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const host = useRenderHost();
  const hv = useHostVersion();
  const seq = useProject((s) => s.state?.nodes[layer.parentId ? s.state.nodes[layer.parentId]!.parentId! : '']) as SceneNode<'sequence'> | undefined;
  const frame = layer.props.frames[index];
  useEffect(() => {
    const c = ref.current;
    if (!c || !seq || !frame) return;
    const W = 96;
    const H = Math.round((W * seq.props.height) / seq.props.width);
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    g.save();
    g.scale(W / seq.props.width, H / seq.props.height);
    drawFrameContent(host, g as never, layer.props, index, seq.props.width, seq.props.height);
    g.restore();
  }, [frame, hv, seq?.props.width, seq?.props.height]);
  return <canvas ref={ref} aria-hidden="true" />;
});
