import { useState } from 'react';
import { childrenOf, makeNode, notesContainer, type NoteKind, type SceneNode } from '@omnix/core';
import { useProject, useProjectStore } from '../state/project.js';
import { useAuth } from '../state/auth.js';
import { Avatar } from '../ui/primitives.js';
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
  const container = notesContainer(state);
  const notes = childrenOf(state, container.id).filter((n): n is SceneNode<'note'> => n.type === 'note');
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
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {[...notes].reverse().map((n) => (
          <li key={n.id} className="card" style={{ padding: 12 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <Avatar name={n.props.author.name} ai={n.props.author.type === 'ai'} />
              <span className="grow" style={{ fontSize: 'var(--fs-sm)' }}>
                <strong>{n.props.author.name}</strong> <span className="muted">{formatRelative(n.props.createdAt)}</span>
              </span>
              <span className={`badge ${KIND_BADGE[n.props.kind]}`}>{t(`notes.kinds.${n.props.kind}`)}</span>
            </div>
            <p style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--fs-sm)' }}>{n.props.text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
