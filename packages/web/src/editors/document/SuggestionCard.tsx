import { useState } from 'react';
import { Check, X, Pencil } from 'lucide-react';
import { diffWords } from 'diff';
import type { SceneNode } from '@omnix/core';
import { acceptSuggestionOp, inlineToPlain, rejectSuggestionOp } from '@omnix/core';
import { Avatar } from '../../ui/primitives.js';
import { toast } from '../../ui/toast.js';
import { formatRelative } from '../../i18n/index.js';
import type { DocCtx } from './docOps.js';

/** Word-level difference between two inline-markdown strings, as readable plain text. */
export function WordDiff({ before, after }: { before: string; after: string }) {
  const parts = diffWords(inlineToPlain(before), inlineToPlain(after));
  return (
    <span className="word-diff">
      {parts.map((p, i) =>
        p.added ? (
          <ins key={i}>{p.value}</ins>
        ) : p.removed ? (
          <del key={i}>{p.value}</del>
        ) : (
          <span key={i}>{p.value}</span>
        ),
      )}
    </span>
  );
}

/**
 * A proposed change to a block, from a person or Claude. Accepting applies the change and marks
 * the suggestion accepted in one undoable step; modifying lets you adjust the text first.
 */
export function SuggestionCard({ ctx, suggestion, block, canEdit }: { ctx: DocCtx; suggestion: SceneNode<'suggestion'>; block: SceneNode<'block'> | undefined; canEdit: boolean }) {
  const p = suggestion.props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.text);
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const s = ctx.store.getState();
  const accept = (text?: string) => {
    try {
      s.commit(acceptSuggestionOp(s.state!, suggestion.id, text !== undefined ? { text } : undefined), p.author.type === 'ai' ? `Accept ${p.author.name}'s suggestion` : 'Accept suggestion');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const reject = () => {
    try {
      s.commit(rejectSuggestionOp(s.state!, suggestion.id, reason.trim() || undefined), 'Reject suggestion');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const verb = p.kind === 'replace' ? 'suggests a change' : p.kind === 'insert-after' ? 'suggests adding' : 'suggests deleting this';
  return (
    <div className={`suggestion-card${p.author.type === 'ai' ? ' ai' : ''}`} role="group" aria-label={`${p.author.name} ${verb}`}>
      <div className="row" style={{ gap: 6 }}>
        <Avatar name={p.author.name} ai={p.author.type === 'ai'} />
        <span style={{ fontSize: 'var(--fs-sm)' }}>
          <strong>{p.author.name}</strong> {verb}
        </span>
        <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
          {formatRelative(p.createdAt)}
        </span>
      </div>
      {p.reason && <p className="muted" style={{ fontSize: 'var(--fs-sm)', margin: '4px 0' }}>“{p.reason}”</p>}
      {!editing && (
        <div className="suggestion-body">
          {p.kind === 'replace' && block && <WordDiff before={block.props.text} after={p.text} />}
          {p.kind === 'insert-after' && <ins>{inlineToPlain(p.text) || '(empty paragraph)'}</ins>}
          {p.kind === 'delete' && block && <del>{inlineToPlain(block.props.text)}</del>}
        </div>
      )}
      {editing && <textarea className="input" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Edit the suggested text" autoFocus />}
      {rejecting && <input className="input sm" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? (optional, the author will see this)" aria-label="Reason for rejecting" autoFocus onKeyDown={(e) => e.key === 'Enter' && reject()} />}
      {canEdit && (
        <div className="row" style={{ gap: 4, marginTop: 6 }}>
          {editing ? (
            <>
              <button className="btn btn-sm btn-primary" onClick={() => accept(draft)}>
                <Check /> Accept edited
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </>
          ) : rejecting ? (
            <>
              <button className="btn btn-sm" onClick={reject}>
                <X /> Reject
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => setRejecting(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-sm btn-primary" onClick={() => accept()}>
                <Check /> Accept
              </button>
              {p.kind !== 'delete' && (
                <button className="btn btn-sm btn-ghost" onClick={() => (setDraft(p.text), setEditing(true))}>
                  <Pencil /> Modify
                </button>
              )}
              <button className="btn btn-sm btn-ghost" onClick={() => setRejecting(true)}>
                <X /> Reject
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
