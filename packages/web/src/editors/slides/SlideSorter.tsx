import { memo, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Plus, EyeOff, Timer } from 'lucide-react';
import type { ProjectState, SceneNode } from '@omnix/core';
import { deckSlides, duplicateSlideOps, LAYOUT_LABELS, newSlideOps, type SlideLayout } from '@omnix/core';
import { renderSlide } from '@omnix/render';
import { useProject } from '../../state/project.js';
import { useHostVersion, useRenderHost } from '../../render/context.js';
import { Menu, MenuButton, type MenuItemDef } from '../../ui/primitives.js';
import type { SlidesCtx } from './SlideStage.js';

const LAYOUTS = Object.keys(LAYOUT_LABELS) as SlideLayout[];

export function addSlide(ctx: SlidesCtx, layout: SlideLayout, after?: string | null): void {
  const s = ctx.store.getState();
  const st = s.state!;
  const deck = st.nodes[ctx.deckId]!;
  const cur = after ?? ctx.ed.getState().slideId;
  const index = cur ? deck.children.indexOf(cur) + 1 : deck.children.length;
  const r = newSlideOps(st, ctx.deckId, layout, { index });
  if (s.commit(r.op, `Add ${LAYOUT_LABELS[layout].toLowerCase()} slide`)) ctx.ed.getState().set({ slideId: r.slideId, selected: [] });
}

export function layoutMenu(ctx: SlidesCtx, after?: string | null): MenuItemDef[] {
  return [{ label: 'New slide', heading: true }, ...LAYOUTS.map((l) => ({ label: LAYOUT_LABELS[l], onSelect: () => addSlide(ctx, l, after) }))];
}

export function SlideSorter({ ctx }: { ctx: SlidesCtx }) {
  const state = useProject((s) => s.state)!;
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  const current = useStore(ctx.ed, (s) => s.slideId);
  const slides = deckSlides(state, ctx.deckId);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [drag, setDrag] = useState<{ id: string; over: string | null; after: boolean } | null>(null);
  const s = ctx.store.getState();

  const del = (id: string) => {
    const i = slides.findIndex((x) => x.id === id);
    if (slides.length <= 1) return;
    if (s.commit({ kind: 'delete', id }, 'Delete slide') && current === id) ctx.ed.getState().set({ slideId: (slides[i + 1] ?? slides[i - 1])!.id, selected: [] });
  };

  return (
    <aside className="slide-sorter" aria-label="Slides">
      <div className="panel-header">
        <span className="grow">Slides</span>
        {canEdit && (
          <MenuButton className="icon-btn sm" label="New slide" items={() => layoutMenu(ctx)}>
            <Plus />
          </MenuButton>
        )}
      </div>
      <ol
        className="sorter-list"
        role="listbox"
        aria-label="Slides"
        onKeyDown={(e) => {
          const i = slides.findIndex((x) => x.id === current);
          if (e.key === 'ArrowDown' && slides[i + 1]) (e.preventDefault(), ctx.ed.getState().set({ slideId: slides[i + 1]!.id, selected: [] }));
          if (e.key === 'ArrowUp' && slides[i - 1]) (e.preventDefault(), ctx.ed.getState().set({ slideId: slides[i - 1]!.id, selected: [] }));
          if ((e.key === 'Delete' || e.key === 'Backspace') && current && canEdit) (e.preventDefault(), del(current));
        }}
      >
        {slides.map((sl, i) => (
          <li
            key={sl.id}
            role="option"
            aria-selected={sl.id === current}
            tabIndex={sl.id === current ? 0 : -1}
            className={`sorter-item${drag?.over === sl.id ? (drag.after ? ' drop-after' : ' drop-before') : ''}${sl.props.hidden ? ' is-hidden' : ''}`}
            draggable={canEdit}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', sl.id);
              setDrag({ id: sl.id, over: null, after: false });
            }}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setDrag({ ...drag, over: sl.id, after: e.clientY > r.top + r.height / 2 });
            }}
            onDragEnd={() => setDrag(null)}
            onDrop={(e) => {
              e.preventDefault();
              if (drag && drag.over && drag.over !== drag.id) {
                const order = slides.map((x) => x.id).filter((x) => x !== drag.id);
                const ti = order.indexOf(drag.over) + (drag.after ? 1 : 0);
                s.commit({ kind: 'move', id: drag.id, parentId: ctx.deckId, index: ti }, 'Reorder slides');
              }
              setDrag(null);
            }}
            onClick={() => ctx.ed.getState().set({ slideId: sl.id, selected: [], editingText: null })}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, id: sl.id });
            }}
          >
            <span className="sorter-num">{i + 1}</span>
            <Thumb state={state} slide={sl} />
            <span className="sorter-flags">
              {sl.props.hidden && <EyeOff size={12} aria-label="Hidden" />}
              {sl.props.rehearsalSeconds !== null && (
                <span title="Rehearsed time">
                  <Timer size={12} aria-hidden="true" /> {Math.round(sl.props.rehearsalSeconds)}s
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {menu && (
        <Menu
          anchor={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          label="Slide"
          items={[
            ...layoutMenu(ctx, menu.id),
            { separator: true, label: '' },
            {
              label: 'Duplicate',
              disabled: !canEdit,
              onSelect: () => {
                const r = duplicateSlideOps(s.state!, menu.id);
                if (s.commit(r.op, 'Duplicate slide')) ctx.ed.getState().set({ slideId: r.slideId });
              },
            },
            { label: (s.state!.nodes[menu.id] as SceneNode<'slide'>).props.hidden ? 'Show in presentation' : 'Hide in presentation', disabled: !canEdit, onSelect: () => s.commit({ kind: 'update', id: menu.id, set: { hidden: !(s.state!.nodes[menu.id] as SceneNode<'slide'>).props.hidden } }, 'Toggle slide visibility') },
            { label: 'Delete', danger: true, disabled: !canEdit || slides.length <= 1, onSelect: () => del(menu.id) },
          ]}
        />
      )}
    </aside>
  );
}

const Thumb = memo(function Thumb({ state, slide }: { state: ProjectState; slide: SceneNode<'slide'> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const host = useRenderHost();
  const hv = useHostVersion();
  useEffect(() => {
    const id = window.setTimeout(() => {
      const c = ref.current;
      if (!c || !state.nodes[slide.id]) return;
      const deck = state.nodes[slide.parentId!] as SceneNode<'deck'>;
      const scale = (176 * (window.devicePixelRatio || 1)) / deck.props.width;
      try {
        const out = renderSlide(host, state, slide.id, { scale });
        c.width = out.width;
        c.height = out.height;
        c.getContext('2d')!.drawImage(out as unknown as CanvasImageSource, 0, 0);
      } catch {
        // The slide may have been removed meanwhile.
      }
    }, 60);
    return () => window.clearTimeout(id);
  }, [state, slide, hv]);
  return <canvas ref={ref} className="sorter-thumb" aria-hidden="true" />;
});
