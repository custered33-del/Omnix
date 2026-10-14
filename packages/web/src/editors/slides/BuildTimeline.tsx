import { useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Play } from 'lucide-react';
import type { ElementAnimation, SceneNode } from '@omnix/core';
import { inlineToPlain, slideElements } from '@omnix/core';
import { animationGroups, slideStepCount } from '@omnix/render';
import { useProject } from '../../state/project.js';
import type { SlidesCtx } from './SlideStage.js';

const PX_PER_SEC = 90;

/**
 * Slide builds on a timeline: one column per click step ("On enter", "Click 1", …),
 * one row per animated element. Drag a bar to change its delay, drag its end to change
 * its duration. The same animation engine drives the editor, presenting and exports.
 */
export function BuildTimeline({ ctx }: { ctx: SlidesCtx }) {
  const state = useProject((s) => s.state)!;
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  const slideId = useStore(ctx.ed, (s) => s.slideId);
  const selected = useStore(ctx.ed, (s) => s.selected);
  const drag = useRef<{ el: string; anim: ElementAnimation; group: number; kind: 'move' | 'end'; startX: number } | null>(null);
  const [live, setLive] = useState<{ id: string; delay: number; duration: number; click?: number } | null>(null);
  if (!slideId || !state.nodes[slideId]) return null;
  const els = slideElements(state, slideId).filter((e) => e.props.animations.length);
  const steps = slideStepCount(state, slideId);
  // Width of each step column: the longest animation that runs in it.
  const colSec = Array.from({ length: steps + 1 }, (_, g) =>
    Math.max(
      1.5,
      ...els.flatMap((e) => {
        const groups = animationGroups(e.props.animations);
        return e.props.animations.filter((_, i) => groups[i] === g).map((a) => a.delay + a.duration + 0.3);
      }),
    ),
  );
  const colX = colSec.map((_, i) => colSec.slice(0, i).reduce((a, b) => a + b, 0) * PX_PER_SEC);
  const s = ctx.store.getState();

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    if (d.kind === 'end') {
      setLive({ id: d.anim.id, delay: d.anim.delay, duration: Math.max(0.05, Math.round((d.anim.duration + dx / PX_PER_SEC) * 20) / 20) });
      return;
    }
    // On-click animations can be dragged into another click's column.
    const left = colX[d.group]! + d.anim.delay * PX_PER_SEC + dx;
    let g = d.group;
    if (d.anim.trigger === 'on-click') {
      g = 1;
      for (let i = 1; i < colX.length; i++) if (left >= colX[i]! - 4) g = i;
      // Allow starting a new click after the last one.
      const end = colX[colX.length - 1]! + colSec[colSec.length - 1]! * PX_PER_SEC;
      if (left >= end - 4) g = colX.length;
    }
    const base = g < colX.length ? colX[g]! : colX[colX.length - 1]! + colSec[colSec.length - 1]! * PX_PER_SEC;
    const delay = Math.max(0, Math.round(((left - base) / PX_PER_SEC) * 20) / 20);
    setLive({ id: d.anim.id, delay, duration: d.anim.duration, ...(g !== d.group ? { click: g } : {}) });
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && live) s.commit({ kind: 'listUpdate', id: d.el, prop: 'animations', itemId: d.anim.id, set: { delay: live.delay, duration: live.duration, ...(live.click ? { click: live.click } : {}) } }, live.click ? 'Move animation to another click' : 'Change animation timing');
    setLive(null);
  };

  return (
    <div className="build-timeline" onPointerMove={onMove} onPointerUp={onUp}>
      <div className="row" style={{ gap: 8, padding: '6px 10px' }}>
        <strong style={{ fontSize: 'var(--fs-sm)' }}>Build</strong>
        <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
          {steps === 0 ? 'Everything appears with the slide.' : `${steps} ${steps === 1 ? 'click' : 'clicks'} to fully build this slide.`}
        </span>
        <span className="spacer" />
        {Array.from({ length: steps + 1 }, (_, g) => (
          <button key={g} className="btn btn-sm btn-ghost" onClick={() => ctx.ed.getState().set({ preview: { step: g, startedAt: performance.now() } })}>
            <Play size={12} /> {g === 0 ? 'Enter' : `Click ${g}`}
          </button>
        ))}
        <button className="btn btn-sm btn-ghost" onClick={() => ctx.ed.getState().set({ preview: null })}>
          Show built
        </button>
      </div>
      {els.length === 0 ? (
        <p className="muted" style={{ padding: '0 10px', fontSize: 'var(--fs-sm)' }}>
          Select an element and add an animation in the inspector.
        </p>
      ) : (
        <div className="build-grid" style={{ ['--cols' as string]: `${colX[colX.length - 1]! + colSec[colSec.length - 1]! * PX_PER_SEC}px` }}>
          <div className="build-head">
            <span className="build-label" />
            <div className="build-track">
              {colSec.map((_, g) => (
                <span key={g} className="build-col" style={{ left: colX[g], width: colSec[g]! * PX_PER_SEC }}>
                  {g === 0 ? 'On enter' : `Click ${g}`}
                </span>
              ))}
            </div>
          </div>
          {els.map((el) => {
            const groups = animationGroups(el.props.animations);
            const name = el.props.elementType === 'text' ? inlineToPlain((el.props.text ?? '').split('\n')[0] ?? '').slice(0, 24) || 'Text' : el.props.elementType;
            return (
              <div key={el.id} className={`build-row${selected.includes(el.id) ? ' selected' : ''}`}>
                <button className="build-label" onClick={() => ctx.ed.getState().set({ selected: [el.id], inspectorTab: 'element' })}>
                  {name}
                </button>
                <div className="build-track">
                  {el.props.animations.map((a, i) => {
                    const v = live?.id === a.id ? live : a;
                    const g = live?.id === a.id && live.click ? Math.min(live.click, colX.length - 1) : groups[i]!;
                    return (
                      <div
                        key={a.id}
                        className={`build-bar k-${a.kind}`}
                        style={{ left: colX[g]! + v.delay * PX_PER_SEC, width: Math.max(8, v.duration * PX_PER_SEC) }}
                        title={`${a.kind} · delay ${v.delay}s · ${v.duration}s${a.trigger === 'on-click' ? ' · drag across columns or press ↑/↓ to change the click' : ''}`}
                        role="button"
                        tabIndex={0}
                        aria-label={`${name}: ${a.kind}, ${g === 0 ? 'on enter' : `click ${g}`}, delay ${v.delay} seconds, lasts ${v.duration} seconds`}
                        onPointerDown={(e) => {
                          if (!canEdit) return;
                          e.currentTarget.setPointerCapture(e.pointerId);
                          drag.current = { el: el.id, anim: a, group: groups[i]!, kind: 'move', startX: e.clientX };
                        }}
                        onKeyDown={(e) => {
                          if (!canEdit) return;
                          if (a.trigger === 'on-click' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                            // Up/Down moves an on-click animation to the previous or next click.
                            e.preventDefault();
                            const next = Math.max(1, Math.min(steps + 1, groups[i]! + (e.key === 'ArrowDown' ? 1 : -1)));
                            if (next !== groups[i]) s.commit({ kind: 'listUpdate', id: el.id, prop: 'animations', itemId: a.id, set: { click: next } }, 'Move animation to another click');
                            return;
                          }
                          const d = e.key === 'ArrowRight' ? 0.1 : e.key === 'ArrowLeft' ? -0.1 : 0;
                          if (!d) return;
                          e.preventDefault();
                          s.commit({ kind: 'listUpdate', id: el.id, prop: 'animations', itemId: a.id, set: e.shiftKey ? { duration: Math.max(0.05, Math.round((a.duration + d) * 100) / 100) } : { delay: Math.max(0, Math.round((a.delay + d) * 100) / 100) } }, 'Change animation timing');
                        }}
                      >
                        <span className="build-bar-label">{a.kind.replace('-', ' ')}</span>
                        <span
                          className="build-bar-end"
                          onPointerDown={(e) => {
                            if (!canEdit) return;
                            e.stopPropagation();
                            e.currentTarget.setPointerCapture(e.pointerId);
                            drag.current = { el: el.id, anim: a, group: groups[i]!, kind: 'end', startX: e.clientX };
                          }}
                          aria-hidden="true"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function NotesEditor({ ctx }: { ctx: SlidesCtx }) {
  const slideId = useStore(ctx.ed, (s) => s.slideId);
  const slide = useProject((s) => (slideId ? s.state?.nodes[slideId] : undefined)) as SceneNode<'slide'> | undefined;
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  if (!slide) return null;
  return (
    <textarea
      className="notes-editor"
      aria-label="Speaker notes"
      placeholder="Speaker notes for this slide (only you see them while presenting)…"
      readOnly={!canEdit}
      value={slide.props.notes}
      onChange={(e) => ctx.store.getState().setTransient(slide.id, { notes: e.target.value })}
      onBlur={() => ctx.store.getState().commitTransient('Edit speaker notes')}
    />
  );
}
