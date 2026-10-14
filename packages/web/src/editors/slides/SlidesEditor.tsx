import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { Type, ImagePlus, Film, Shapes, BarChart3, Link2, Play, Timer, Plus, FileUp, Square, Circle, Minus } from 'lucide-react';
import type { SceneNode, SlideElementProps } from '@omnix/core';
import { deckSlides, makeNode, newId } from '@omnix/core';
import { useProject, useProjectStore } from '../../state/project.js';
import { useRenderHost } from '../../render/context.js';
import { useShortcuts } from '../../ui/shortcuts.js';
import { useCommands } from '../../state/commands.js';
import { MenuButton } from '../../ui/primitives.js';
import { AssetPicker } from '../../components/AssetPicker.js';
import { EmbedPicker } from '../../components/EmbedView.js';
import { post } from '../../lib/api.js';
import { toast } from '../../ui/toast.js';
import { createSlidesStore } from './slidesState.js';
import { addAssetElement, SlideStage, type SlidesCtx } from './SlideStage.js';
import { layoutMenu, SlideSorter } from './SlideSorter.js';
import { SlideInspector } from './SlideInspector.js';
import { BuildTimeline, NotesEditor } from './BuildTimeline.js';
import { Presenter } from './Presenter.js';
import '../../styles/editors.css';
import '../../styles/slides.css';

export function SlidesEditor({ deckId }: { deckId: string }) {
  const store = useProjectStore();
  const host = useRenderHost();
  const state = useProject((s) => s.state)!;
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  const deck = state.nodes[deckId] as SceneNode<'deck'> | undefined;
  const ed = useMemo(() => createSlidesStore(deck ? (deckSlides(state, deckId)[0]?.id ?? null) : null), [deckId]);
  const ctx: SlidesCtx = useMemo(() => ({ store, ed, deckId }), [store, ed, deckId]);
  const slideId = useStore(ed, (s) => s.slideId);
  const presenting = useStore(ed, (s) => s.presenting);
  const [picker, setPicker] = useState<null | 'image' | 'video' | 'embed' | 'import'>(null);
  const [bottom, setBottom] = useState<'notes' | 'build'>('notes');

  // Keep a valid current slide when slides are added or removed (also by Claude or collaborators).
  useEffect(() => {
    if (!deck) return;
    const ids = deckSlides(state, deckId).map((s) => s.id);
    if (!slideId || !ids.includes(slideId)) ed.getState().set({ slideId: ids[0] ?? null, selected: [] });
    const sel = ed.getState().selected.filter((id) => state.nodes[id]);
    if (sel.length !== ed.getState().selected.length) ed.getState().set({ selected: sel });
  }, [state]);
  useEffect(() => {
    if (slideId) store.getState().reportLocation({ tool: 'slides', nodeId: slideId });
  }, [slideId]);

  const add = (props: Partial<SlideElementProps>, label: string) => {
    if (!slideId || !deck) return;
    const W = deck.props.width;
    const H = deck.props.height;
    const w = props.w ?? Math.round(W * 0.5);
    const h = props.h ?? Math.round(H * 0.4);
    const node = makeNode('slideElement', { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h, role: null, ...props });
    if (store.getState().commit({ kind: 'create', parentId: slideId, nodes: [node] }, label)) ed.getState().set({ selected: [node.id], inspectorTab: 'element', ...(props.elementType === 'text' ? { editingText: node.id } : {}) });
  };
  const addText = () => add({ elementType: 'text', text: 'Text', w: Math.round((deck?.props.width ?? 1920) * 0.4), h: 120 }, 'Add text');
  const addShape = (kind: 'rect' | 'ellipse' | 'line') =>
    add({ elementType: 'shape', w: 400, h: kind === 'line' ? 4 : 300, shape: { id: newId('shp'), kind, x: 0, y: 0, width: 400, height: kind === 'line' ? 4 : 300, ...(kind === 'line' ? { points: [{ x: 0, y: 2 }, { x: 400, y: 2 }] } : {}), fill: kind === 'line' ? null : (deck?.props.theme.colors.accent ?? '#3b5bdb'), stroke: kind === 'line' ? (deck?.props.theme.colors.text ?? '#1d1f24') : null, strokeWidth: kind === 'line' ? 6 : 0, ...(kind === 'rect' ? { radius: 16 } : {}) } }, 'Add shape');
  const addChart = () => add({ elementType: 'chart', w: 1100, h: 620, chart: { type: 'bar', title: 'Chart title', labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'Revenue', values: [12, 18, 15, 24] }] } }, 'Add chart');

  const elementOps = {
    remove: () => {
      const ids = ed.getState().selected;
      if (!ids.length) return false;
      store.getState().commit(ids.length === 1 ? { kind: 'delete', id: ids[0]! } : { kind: 'batch', ops: ids.map((id) => ({ kind: 'delete' as const, id })) }, ids.length === 1 ? 'Delete element' : `Delete ${ids.length} elements`);
      ed.getState().set({ selected: [] });
      return true;
    },
    nudge: (dx: number, dy: number) => {
      const ids = ed.getState().selected;
      if (!ids.length) return false;
      store.getState().commit({ kind: 'batch', ops: ids.map((id) => { const p = (store.getState().state!.nodes[id] as SceneNode<'slideElement'>).props; return { kind: 'update' as const, id, set: { x: p.x + dx, y: p.y + dy } }; }) }, 'Nudge');
      return true;
    },
    copy: () => {
      const ids = ed.getState().selected;
      if (!ids.length) return false;
      ed.getState().set({ clipboard: ids.map((id) => structuredClone((store.getState().state!.nodes[id] as SceneNode<'slideElement'>).props)) });
      return true;
    },
    paste: () => {
      const clip = ed.getState().clipboard;
      if (!clip.length || !slideId) return false;
      const nodes = clip.map((p) => makeNode('slideElement', { ...structuredClone(p), x: p.x + 24, y: p.y + 24, animations: p.animations.map((a) => ({ ...a, id: newId('anim') })) }));
      if (store.getState().commit({ kind: 'batch', ops: nodes.map((n) => ({ kind: 'create' as const, parentId: slideId, nodes: [n] })) }, 'Paste')) ed.getState().set({ selected: nodes.map((n) => n.id) });
      return true;
    },
  };

  useShortcuts(
    {
      del: () => (canEdit ? elementOps.remove() : false),
      arrowleft: () => (canEdit ? elementOps.nudge(-1, 0) : false),
      arrowright: () => (canEdit ? elementOps.nudge(1, 0) : false),
      arrowup: () => (canEdit ? elementOps.nudge(0, -1) : false),
      arrowdown: () => (canEdit ? elementOps.nudge(0, 1) : false),
      'shift+arrowleft': () => (canEdit ? elementOps.nudge(-10, 0) : false),
      'shift+arrowright': () => (canEdit ? elementOps.nudge(10, 0) : false),
      'shift+arrowup': () => (canEdit ? elementOps.nudge(0, -10) : false),
      'shift+arrowdown': () => (canEdit ? elementOps.nudge(0, 10) : false),
      'mod+c': () => elementOps.copy(),
      'mod+v': () => (canEdit ? elementOps.paste() : false),
      'mod+d': () => (canEdit ? (elementOps.copy(), elementOps.paste()) : false),
      esc: () => (ed.getState().selected.length ? (ed.getState().set({ selected: [], editingText: null, preview: null }), true) : false),
      f5: () => ed.getState().set({ presenting: { mode: 'present', startSlide: null } }),
      'shift+f5': () => ed.getState().set({ presenting: { mode: 'present', startSlide: slideId } }),
    },
    [slideId, canEdit],
  );
  useCommands(
    'slides',
    [
      { id: 'sl.present', label: 'Present from the start', section: 'Slides', shortcut: 'f5', run: () => ed.getState().set({ presenting: { mode: 'present', startSlide: null } }) },
      { id: 'sl.presentHere', label: 'Present from this slide', section: 'Slides', shortcut: 'shift+f5', run: () => ed.getState().set({ presenting: { mode: 'present', startSlide: slideId } }) },
      { id: 'sl.rehearse', label: 'Rehearse timings', section: 'Slides', run: () => ed.getState().set({ presenting: { mode: 'rehearse', startSlide: null } }) },
      { id: 'sl.text', label: 'Add text box', section: 'Slides', run: addText },
      { id: 'sl.chart', label: 'Add chart', section: 'Slides', run: addChart },
      { id: 'sl.link', label: 'Add live link', section: 'Slides', run: () => setPicker('embed') },
      { id: 'sl.import', label: 'Import PowerPoint or PDF', section: 'Slides', run: () => setPicker('import') },
    ],
    [slideId],
  );

  if (!deck) return null;
  const importFile = async (assetId: string) => {
    try {
      const r = await post<{ slides: number; firstSlideId: string | null; notes: string[] }>(`/api/projects/${store.getState().projectId}/decks/${deckId}/import`, { assetId });
      toast.success(`Imported ${r.slides} ${r.slides === 1 ? 'slide' : 'slides'}`);
      if (r.firstSlideId) {
        // The imported slides arrive through the project's live updates.
        for (let i = 0; i < 60 && !store.getState().state?.nodes[r.firstSlideId]; i++) await new Promise((res) => setTimeout(res, 50));
        if (store.getState().state?.nodes[r.firstSlideId]) ed.getState().set({ slideId: r.firstSlideId, selected: [] });
      }
      for (const n of r.notes.slice(0, 3)) toast.info(n);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="slides-editor">
      <div className="editor-toolbar" role="toolbar" aria-label="Slides">
        {canEdit && (
          <MenuButton className="btn btn-sm" label="New slide" items={() => layoutMenu(ctx)}>
            <Plus /> Slide
          </MenuButton>
        )}
        <div className="row" style={{ gap: 2 }}>
          <button className="btn btn-sm btn-ghost" onClick={addText} disabled={!canEdit}>
            <Type /> Text
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setPicker('image')} disabled={!canEdit}>
            <ImagePlus /> Image
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setPicker('video')} disabled={!canEdit}>
            <Film /> Video
          </button>
          <MenuButton
            className="btn btn-sm btn-ghost"
            label="Shape"
            items={[
              { label: 'Rectangle', icon: <Square />, onSelect: () => addShape('rect') },
              { label: 'Ellipse', icon: <Circle />, onSelect: () => addShape('ellipse') },
              { label: 'Line', icon: <Minus />, onSelect: () => addShape('line') },
            ]}
          >
            <Shapes /> Shape
          </MenuButton>
          <button className="btn btn-sm btn-ghost" onClick={addChart} disabled={!canEdit}>
            <BarChart3 /> Chart
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setPicker('embed')} disabled={!canEdit}>
            <Link2 /> Live link
          </button>
        </div>
        <span className="spacer" />
        <button className="btn btn-sm btn-ghost" onClick={() => setPicker('import')} disabled={!canEdit}>
          <FileUp /> Import
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => ed.getState().set({ presenting: { mode: 'rehearse', startSlide: null } })}>
          <Timer /> Rehearse
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => ed.getState().set({ presenting: { mode: 'present', startSlide: slideId } })} title="Present (F5 from the start, Shift+F5 from here)">
          <Play /> Present
        </button>
      </div>
      <div className="slides-body">
        <SlideSorter ctx={ctx} />
        <div className="slides-center">
          <SlideStage ctx={ctx} />
          <div className="slides-bottom">
            <div className="segmented" role="tablist" aria-label="Bottom panel" style={{ margin: '6px 10px' }}>
              <button role="tab" aria-selected={bottom === 'notes'} aria-pressed={bottom === 'notes'} onClick={() => setBottom('notes')}>
                Speaker notes
              </button>
              <button role="tab" aria-selected={bottom === 'build'} aria-pressed={bottom === 'build'} onClick={() => setBottom('build')}>
                Animations
              </button>
            </div>
            {bottom === 'notes' ? <NotesEditor ctx={ctx} /> : <BuildTimeline ctx={ctx} />}
          </div>
        </div>
        <SlideInspector ctx={ctx} />
      </div>
      {(picker === 'image' || picker === 'video') && <AssetPicker kinds={[picker]} projectId={store.getState().projectId} multiple={picker === 'image'} onPick={(as) => as.forEach((a) => addAssetElement(ctx, a))} onClose={() => setPicker(null)} />}
      {picker === 'embed' && <EmbedPicker excludeDeck={deckId} onPick={(e) => add({ elementType: 'embed', embed: e, w: 1100, h: 620 }, 'Add live link')} onClose={() => setPicker(null)} />}
      {picker === 'import' && <AssetPicker kinds={['other']} mime={['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/pdf', 'application/vnd.ms-powerpoint', 'application/vnd.oasis.opendocument.presentation', 'application/x-iwork-keynote-sffkey', 'application/vnd.openxmlformats-officedocument.presentationml.slideshow']} title="Import PowerPoint, Keynote or PDF" accept=".pptx,.ppsx,.pdf,.ppt,.odp,.key" projectId={store.getState().projectId} onPick={([a]) => a && void importFile(a.id)} onClose={() => setPicker(null)} />}
      {presenting && (
        <Presenter
          host={host}
          state={state}
          deckId={deckId}
          startSlide={presenting.startSlide}
          mode={presenting.mode}
          onExit={(r) => {
            const mode = presenting.mode;
            ed.getState().set({ presenting: null });
            if (mode === 'rehearse' && Object.keys(r.timings).length && canEdit) {
              store.getState().commit({ kind: 'batch', ops: Object.entries(r.timings).filter(([id]) => store.getState().state!.nodes[id]).map(([id, sec]) => ({ kind: 'update' as const, id, set: { rehearsalSeconds: Math.round(sec * 10) / 10 } })) }, 'Save rehearsal timings');
              toast.success('Rehearsal timings saved');
            }
          }}
        />
      )}
    </div>
  );
}
