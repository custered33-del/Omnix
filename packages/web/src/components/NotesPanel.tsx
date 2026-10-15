import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { childrenOf, makeNode, notesContainer, type NoteKind, type SceneNode } from '@omnix/core';
import { useProject, useProjectStore } from '../state/project.js';
import { useAuth } from '../state/auth.js';
import { Avatar, IconButton } from '../ui/primitives.js';
import { formatRelative, t } from '../i18n/index.js';

const KINDS: NoteKind[] = ['decision', 'prompt', 'rejected', 'note'];
const KIND_BADGE: Record<NoteKind, string> = { decision: 'success', prompt: 'ai', rejected: 'danger', note: '' };

/** Session memory: decisions, prompts and rejected options shared by people and AI. */
export function NotesPanel() {
  const store = useProjectStore();
  const state = useProject((s) => s.state)!;
  const canEdit = useProject((s) => s.meta?.role !== 'viewer');
  const user = useAuth((s) => s.user)!;
  const [text, setText] = useState('');
  const [kind, setKind] = useState<NoteKind>('decision');
  const [filter, setFilter] = useState<NoteKind | 'all'>('all');
  const container = notesContainer(state);
  const notes = childrenOf(state, container.id).filter((n): n is SceneNode<'note'> => n.type === 'note');
  const shown = notes.filter((n) => filter === 'all' || n.props.kind === filter);
  return (
    <div className="col" style={{ gap: 16 }}>
      <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
        {t('notes.hint')}
      </p>
      {canEdit && (
        <form
          className="col"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            const note = makeNode('note', { kind, text: text.trim(), author: { type: 'human', id: user.id, name: user.name }, createdAt: new Date().toISOString() });
            store.getState().commit({ kind: 'create', parentId: container.id, nodes: [note] }, `Note: ${text.trim().slice(0, 40)}`);
            setText('');
          }}
        >
          <div className="segmented" role="group" aria-label="Kind">
            {KINDS.map((k) => (
              <button type="button" key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
                {t(`notes.kinds.${k}`)}
              </button>
            ))}
          </div>
          <textarea className="textarea" placeholder={t('notes.placeholder')} value={text} onChange={(e) => setText(e.target.value)} aria-label={t('notes.add')} />
          <button className="btn btn-sm" type="submit" style={{ alignSelf: 'flex-end' }} disabled={!text.trim()}>
            {t('notes.add')}
          </button>
        </form>
      )}
      {notes.length > 0 && (
        <div className="chip-row" role="group" aria-label={t('notes.filter')}>
          {(['all', ...KINDS] as const).map((k) => {
            const count = k === 'all' ? notes.length : notes.filter((n) => n.props.kind === k).length;
            return (
              <button key={k} type="button" className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)} disabled={!count && k !== 'all'}>
                {k === 'all' ? t('notes.all') : t(`notes.kinds.${k}`)} <span className="tabular muted">{count}</span>
              </button>
            );
          })}
        </div>
      )}
      {notes.length === 0 && <p className="muted">{t('notes.empty')}</p>}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {[...shown].reverse().map((n) => (
          <li key={n.id} className="card note-card" style={{ padding: 12 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <Avatar name={n.props.author.name} ai={n.props.author.type === 'ai'} />
              <span className="grow" style={{ fontSize: 'var(--fs-sm)' }}>
                <strong>{n.props.author.name}</strong> <span className="muted">{formatRelative(n.props.createdAt)}</span>
                {n.props.auto && <span className="muted"> · {t('notes.auto')}</span>}
              </span>
              <span className={`badge ${KIND_BADGE[n.props.kind]}`}>{t(`notes.kinds.${n.props.kind}`)}</span>
              {canEdit && (
                <IconButton small className="hover-only" label={t('notes.remove')} onClick={() => store.getState().commit({ kind: 'delete', id: n.id }, 'Remove note')}>
                  <Trash2 />
                </IconButton>
              )}
            </div>
            <p style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--fs-sm)' }}>{n.props.text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
