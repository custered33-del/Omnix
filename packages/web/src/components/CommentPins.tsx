import { useEffect, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { commentsContainer, type CommentAnchor, type ProjectState, type SceneNode } from '@omnix/core';
import { freshFocus, useProject, useProjectStore } from '../state/project.js';
import { addComment, CommentThread, NewComment } from './Comments.js';
import { t } from '../i18n/index.js';

/** Every comment thread in the project, open first. */
export function allComments(state: ProjectState): SceneNode<'comment'>[] {
  const container = commentsContainer(state);
  return container.children
    .map((id) => state.nodes[id])
    .filter((n): n is SceneNode<'comment'> => !!n && n.type === 'comment')
    .sort((a, b) => Number(a.props.resolved) - Number(b.props.resolved) || a.props.createdAt.localeCompare(b.props.createdAt));
}

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

const DOCUMENT_TYPES = new Set(['canvas', 'sequence', 'codeWorkspace', 'document', 'deck']);

/**
 * Where a comment points, in words: "Slide 3", "calc.py, line 42", "Intro at 0:12.5",
 * "At 0:03.7" or "At 520, 300" (a spot on the document itself, which the caller names).
 */
export function anchorLabel(state: ProjectState, a: CommentAnchor): string {
  const n = state.nodes[a.nodeId];
  const name = n ? String((n.props as { name?: string; path?: string }).name ?? (n.props as { path?: string }).path ?? n.type) : t('comments.deleted');
  if (a.line !== undefined) return t('comments.atLine', { name, line: a.line });
  if (n && DOCUMENT_TYPES.has(n.type)) {
    if (a.time !== undefined) return t('comments.atMoment', { time: formatTime(a.time) });
    if (a.x !== undefined && a.y !== undefined) return t('comments.atPoint', { x: Math.round(a.x), y: Math.round(a.y) });
    return t('comments.whole');
  }
  if (a.time !== undefined) return t('comments.atTime', { name, time: formatTime(a.time) });
  if (n?.type === 'slide') {
    const deck = state.nodes[n.parentId!];
    const idx = deck ? deck.children.filter((id) => state.nodes[id]?.type === 'slide').indexOf(n.id) + 1 : 0;
    return t('comments.onSlide', { n: idx });
  }
  if (a.range) return t('comments.inText', { name });
  return t('comments.on', { name });
}

export interface Pin {
  comment: SceneNode<'comment'>;
  /** Position in the layer's own pixels. */
  x: number;
  y: number;
}

/**
 * Comment pins over an editor surface, plus the composer for a new one. Positions are in the
 * layer's coordinates (the parent places this layer over the canvas, slide or video).
 */
export function PinLayer({ pins, composer, onCompose, onCancelCompose, label }: { pins: Pin[]; composer: { x: number; y: number; anchor: CommentAnchor } | null; onCompose: (id: string | null) => void; onCancelCompose: () => void; label: string }) {
  const store = useProjectStore();
  const [open, setOpen] = useState<string | null>(null);
  const focus = useProject((s) => s.focusRequest);
  useEffect(() => {
    if (freshFocus(focus) && focus.commentId && pins.some((p) => p.comment.id === focus.commentId)) setOpen(focus.commentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);
  const numbered = pins.map((p, i) => ({ ...p, n: i + 1 }));
  return (
    <div className="pin-layer" role="group" aria-label={label}>
      {numbered.map((p) => (
        <div key={p.comment.id} className="pin-wrap" style={{ left: p.x, top: p.y }}>
          <button
            type="button"
            className={`comment-pin${p.comment.props.resolved ? ' resolved' : ''}${open === p.comment.id ? ' open' : ''}`}
            aria-label={t('comments.pinLabel', { n: p.n, name: p.comment.props.author.name })}
            aria-expanded={open === p.comment.id}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(open === p.comment.id ? null : p.comment.id);
            }}
          >
            {p.n}
          </button>
          {open === p.comment.id && (
            <div className="pin-popover" onPointerDown={(e) => e.stopPropagation()}>
              <CommentThread store={store} comment={p.comment} />
            </div>
          )}
        </div>
      ))}
      {composer && (
        <div className="pin-wrap" style={{ left: composer.x, top: composer.y }}>
          <span className="comment-pin draft" aria-hidden="true">
            <MessageSquare size={12} />
          </span>
          <div className="pin-popover" onPointerDown={(e) => e.stopPropagation()}>
            <NewComment
              onSubmit={(text) => {
                const id = addComment(store, composer.anchor, text);
                onCompose(id);
                if (id) setOpen(id);
              }}
              onCancel={onCancelCompose}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Comments anchored to one node (and optionally a filter on the anchor). */
export function useAnchoredComments(nodeIds: readonly string[], filter?: (a: CommentAnchor) => boolean): SceneNode<'comment'>[] {
  const state = useProject((s) => s.state);
  if (!state) return [];
  const ids = new Set(nodeIds);
  return allComments(state).filter((c) => ids.has(c.props.anchor.nodeId) && (!filter || filter(c.props.anchor)));
}
