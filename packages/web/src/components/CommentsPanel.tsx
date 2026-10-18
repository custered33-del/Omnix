import { useEffect, useState } from 'react';
import { MessageSquarePlus, Locate } from 'lucide-react';
import type { ProjectState, SceneNode, ToolKind } from '@omnix/core';
import { useProject, useProjectStore } from '../state/project.js';
import { ToolIcon } from '../ui/icons.js';
import { t } from '../i18n/index.js';
import { CommentThread } from './Comments.js';
import { allComments, anchorLabel } from './CommentPins.js';

const DOC_TOOL: Record<string, ToolKind> = { canvas: 'image', codeWorkspace: 'code', document: 'document', deck: 'slides' };

/** The document (canvas, sequence, workspace, document, deck) a node lives in. */
export function documentOf(state: ProjectState, nodeId: string): SceneNode | null {
  let cur: SceneNode | undefined = state.nodes[nodeId];
  while (cur) {
    if (cur.type in DOC_TOOL || cur.type === 'sequence') return cur;
    cur = cur.parentId ? state.nodes[cur.parentId] : undefined;
  }
  return null;
}

function toolOf(doc: SceneNode): ToolKind {
  if (doc.type === 'sequence') return (doc as SceneNode<'sequence'>).props.purpose;
  return DOC_TOOL[doc.type]!;
}

/** Every comment thread in the project, across all tools, with a way to jump to each one. */
export function CommentsPanel({ focusId }: { focusId?: string | null }) {
  const store = useProjectStore();
  const state = useProject((s) => s.state)!;
  const commentMode = useProject((s) => s.commentMode);
  const canEdit = useProject((s) => s.meta?.role !== 'viewer');
  const comments = allComments(state);
  const [filter, setFilter] = useState<'open' | 'resolved' | 'all'>(() => (focusId && state.nodes[focusId] && (state.nodes[focusId] as SceneNode<'comment'>).props.resolved ? 'all' : 'open'));
  const shown = comments.filter((c) => filter === 'all' || (filter === 'open' ? !c.props.resolved : c.props.resolved));
  const show = (c: SceneNode<'comment'>) => {
    const doc = documentOf(state, c.props.anchor.nodeId);
    if (!doc) return;
    const a = c.props.anchor;
    store.getState().requestFocus({ documentId: doc.id, nodeId: a.nodeId, commentId: c.id, ...(a.time !== undefined ? { time: a.time } : {}), ...(a.line !== undefined ? { line: a.line } : {}) });
  };
  // Opened from a link to one comment: bring it into view and show where it points.
  useEffect(() => {
    const c = focusId ? state.nodes[focusId] : undefined;
    if (!c || c.type !== 'comment') return;
    document.getElementById(`comment-${focusId}`)?.scrollIntoView({ block: 'center' });
    show(c as SceneNode<'comment'>);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);
  return (
    <div className="col" style={{ gap: 12 }}>
      <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
        {t('comments.panelHint')}
      </p>
      {canEdit && (
        <button className={`btn btn-sm ${commentMode ? 'btn-primary' : ''}`} style={{ alignSelf: 'flex-start' }} aria-pressed={commentMode} onClick={() => store.getState().setCommentMode(!commentMode)}>
          <MessageSquarePlus /> {commentMode ? t('comments.modeOn') : t('comments.add')}
        </button>
      )}
      <div className="chip-row" role="group" aria-label={t('comments.filter')}>
        {(['open', 'resolved', 'all'] as const).map((f) => (
          <button key={f} type="button" className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {t(`comments.filters.${f}`)}{' '}
            <span className="tabular muted">{f === 'all' ? comments.length : comments.filter((c) => (f === 'open' ? !c.props.resolved : c.props.resolved)).length}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 && <p className="muted">{filter === 'open' ? t('comments.noneOpen') : t('comments.none')}</p>}
      {shown.map((c) => {
        const doc = documentOf(state, c.props.anchor.nodeId);
        return (
          <div key={c.id} id={`comment-${c.id}`} className="col" style={{ gap: 4 }}>
            <div className="row" style={{ fontSize: 'var(--fs-xs)' }}>
              {doc && <ToolIcon tool={toolOf(doc)} size={14} />}
              <span className="grow truncate muted">
                {doc ? `${String((doc.props as { name?: string }).name ?? '')} · ` : ''}
                {anchorLabel(state, c.props.anchor)}
              </span>
              {doc && (
                <button className="btn btn-sm btn-ghost" onClick={() => show(c)}>
                  <Locate size={14} /> {t('comments.show')}
                </button>
              )}
            </div>
            <CommentThread store={store} comment={c} active={c.id === focusId} />
          </div>
        );
      })}
    </div>
  );
}
