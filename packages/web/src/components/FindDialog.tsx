import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import type { ToolKind } from '@omnix/core';
import { useProjectStore } from '../state/project.js';
import { get } from '../lib/api.js';
import { ToolIcon } from '../ui/icons.js';
import { t } from '../i18n/index.js';

interface Hit {
  nodeId: string;
  type: string;
  tool: string | null;
  documentId: string | null;
  label: string;
  snippet: string;
}

const TOOL_OF: Record<string, ToolKind> = { image: 'image', video: 'video', recense: 'recense', animation: 'animation', code: 'code', document: 'document', slides: 'slides' };

/** Search text across every tool in the project and jump to it (cross-tool context, feature 50). */
export function FindDialog({ onClose }: { onClose: () => void }) {
  const store = useProjectStore();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);
  useEffect(() => {
    if (q.trim().length < 2) {
      setHits(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void get<{ hits: Hit[] }>(`/api/projects/${store.getState().projectId}/search?q=${encodeURIComponent(q.trim())}`).then((r) => {
        setHits(r.hits);
        setActive(0);
      }, () => {});
    }, 180);
    return () => window.clearTimeout(timer);
  }, [q, store]);
  const open = (h: Hit | undefined) => {
    if (!h) return;
    const s = store.getState();
    if (h.documentId) s.setActiveDoc(h.documentId);
    if (h.nodeId !== h.documentId) setTimeout(() => store.getState().select([h.nodeId]), 0);
    onClose();
  };
  return createPortal(
    <div className="dialog-backdrop" style={{ alignItems: 'flex-start', paddingTop: '12vh' }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={t('find.title')} style={{ width: 'min(620px, 100%)' }}>
        <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <Search size={18} className="muted" aria-hidden="true" />
          <input
            ref={inputRef}
            className="grow"
            style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 'var(--fs-lg)' }}
            placeholder={t('find.placeholder')}
            value={q}
            aria-label={t('find.title')}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min((hits?.length ?? 1) - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') open(hits?.[active]);
              else if (e.key === 'Escape') onClose();
            }}
          />
        </div>
        <div role="listbox" aria-label={t('find.results')} style={{ maxHeight: '50vh', overflow: 'auto', padding: 6 }}>
          {hits && hits.length === 0 && <div className="empty">{t('find.none')}</div>}
          {!hits && <div className="empty muted">{t('find.hint')}</div>}
          {hits?.map((h, i) => (
            <div key={h.nodeId} role="option" aria-selected={i === active} className="menu-item" data-active={i === active} onMouseEnter={() => setActive(i)} onClick={() => open(h)}>
              {h.tool && TOOL_OF[h.tool] ? <ToolIcon tool={TOOL_OF[h.tool]!} /> : <Search size={16} />}
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="truncate" style={{ display: 'block' }}>
                  {h.snippet}
                </span>
                <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                  {h.label} · {h.type}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
