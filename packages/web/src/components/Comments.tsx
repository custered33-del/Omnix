import { useState } from 'react';
import { Check, RotateCcw, Trash2, Reply } from 'lucide-react';
import type { Author, CommentAnchor, ProjectState, SceneNode } from '@omnix/core';
import { commentsContainer, makeNode, newId } from '@omnix/core';
import { useAuth } from '../state/auth.js';
import type { ProjectStore } from '../state/project.js';
import { Avatar, IconButton } from '../ui/primitives.js';
import { formatRelative } from '../i18n/index.js';

export function currentAuthor(): Author {
  const u = useAuth.getState().user;
  return { type: 'human', id: u?.id ?? 'anonymous', name: u?.name ?? 'Someone' };
}

/** Pin a new comment thread to something in the project. */
export function addComment(store: ProjectStore, anchor: CommentAnchor, text: string): string | null {
  const st = store.getState().state!;
  const node = makeNode('comment', { anchor, text, author: currentAuthor(), createdAt: new Date().toISOString(), resolved: false, replies: [] });
  return store.getState().commit({ kind: 'create', parentId: commentsContainer(st).id, nodes: [node] }, 'Add comment') ? node.id : null;
}

/** Comments anchored to any of the given node ids (open first, then resolved). */
export function commentsFor(state: ProjectState, nodeIds: ReadonlySet<string>): SceneNode<'comment'>[] {
  const container = commentsContainer(state);
  return container.children
    .map((id) => state.nodes[id])
    .filter((n): n is SceneNode<'comment'> => !!n && n.type === 'comment' && nodeIds.has((n as SceneNode<'comment'>).props.anchor.nodeId))
    .sort((a, b) => Number(a.props.resolved) - Number(b.props.resolved) || a.props.createdAt.localeCompare(b.props.createdAt));
}

export function CommentThread({ store, comment, quote, onFocus, active }: { store: ProjectStore; comment: SceneNode<'comment'>; quote?: string; onFocus?: () => void; active?: boolean }) {
  const p = comment.props;
  const [reply, setReply] = useState('');
  const [open, setOpen] = useState(false);
  const canEdit = store.getState().canEdit();
  const me = useAuth((s) => s.user?.id);
  const s = store.getState();
  const send = () => {
    const text = reply.trim();
    if (!text) return;
    s.commit({ kind: 'listInsert', id: comment.id, prop: 'replies', items: [{ id: newId('rep'), author: currentAuthor(), text, createdAt: new Date().toISOString() }] }, 'Reply to comment');
    setReply('');
    setOpen(false);
  };
  return (
    <article className={`comment-card${p.resolved ? ' resolved' : ''}${active ? ' active' : ''}`} aria-label={`Comment by ${p.author.name}`} onClick={onFocus}>
      {quote && <blockquote className="comment-quote">{quote}</blockquote>}
      <CommentLine author={p.author} text={p.text} at={p.createdAt} />
      {p.replies.map((r) => (
        <CommentLine key={r.id} author={r.author} text={r.text} at={r.createdAt} reply />
      ))}
      {canEdit && (
        <div className="row" style={{ gap: 2, marginTop: 4 }}>
          {!p.resolved && (
            <IconButton small label="Reply" onClick={() => setOpen(!open)}>
              <Reply />
            </IconButton>
          )}
          <IconButton small label={p.resolved ? 'Reopen' : 'Resolve'} onClick={() => s.commit({ kind: 'update', id: comment.id, set: { resolved: !p.resolved } }, p.resolved ? 'Reopen comment' : 'Resolve comment')}>
            {p.resolved ? <RotateCcw /> : <Check />}
          </IconButton>
          {p.author.id === me && (
            <IconButton small label="Delete comment" onClick={() => s.commit({ kind: 'delete', id: comment.id }, 'Delete comment')}>
              <Trash2 />
            </IconButton>
          )}
        </div>
      )}
      {open && (
        <form
          className="col"
          style={{ gap: 6, marginTop: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea className="input" rows={2} autoFocus value={reply} onChange={(e) => setReply(e.target.value)} aria-label="Reply" placeholder="Reply…" onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && send()} />
          <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={!reply.trim()}>
              Reply
            </button>
          </div>
        </form>
      )}
    </article>
  );
}

function CommentLine({ author, text, at, reply }: { author: Author; text: string; at: string; reply?: boolean }) {
  return (
    <div className="comment-line" style={reply ? { marginTop: 8 } : undefined}>
      <div className="row" style={{ gap: 6 }}>
        <Avatar name={author.name} ai={author.type === 'ai'} />
        <strong style={{ fontSize: 'var(--fs-sm)' }}>{author.name}</strong>
        <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
          {formatRelative(at)}
        </span>
      </div>
      <p style={{ margin: '4px 0 0', fontSize: 'var(--fs-sm)', whiteSpace: 'pre-wrap' }}>{text}</p>
    </div>
  );
}

/** Composer for a new comment. */
export function NewComment({ onSubmit, onCancel, quote }: { onSubmit: (text: string) => void; onCancel: () => void; quote?: string }) {
  const [text, setText] = useState('');
  return (
    <form
      className="comment-card active"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onSubmit(text.trim());
      }}
    >
      {quote && <blockquote className="comment-quote">{quote}</blockquote>}
      <textarea className="input" rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)} aria-label="Comment" placeholder="Add a comment…" onKeyDown={(e) => (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim() ? onSubmit(text.trim()) : e.key === 'Escape' && onCancel())} />
      <div className="row" style={{ justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={!text.trim()}>
          Comment
        </button>
      </div>
    </form>
  );
}
