import { useContext } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { Sparkles } from 'lucide-react';
import type { AiMark } from '@omnix/core';
import { ProjectContext } from '../state/project.js';
import { formatRelative, t } from '../i18n/index.js';

export function aiMarkText(m: AiMark): string {
  const when = formatRelative(m.at);
  return m.approvedBy ? t('ai.markApproved', { name: m.by, when, approver: m.approvedBy }) : t('ai.mark', { name: m.by, when });
}

const NO_PROJECT = createStore<{ aiMarks: Record<string, AiMark> }>(() => ({ aiMarks: {} }));

/**
 * A small sparkle on anything an AI collaborator changed last (layers, clips, blocks, slides).
 * Pass `ids` to mark a container when any of its parts changed (a slide and its elements).
 */
export function AiMarker({ nodeId, ids, className }: { nodeId?: string; ids?: readonly string[]; className?: string }) {
  const store = useContext(ProjectContext) ?? NO_PROJECT;
  const mark = useStore(store, (s: { aiMarks: Record<string, AiMark> }) => {
    if (nodeId && s.aiMarks[nodeId]) return s.aiMarks[nodeId];
    let best: AiMark | undefined;
    for (const id of ids ?? []) {
      const m = s.aiMarks[id];
      if (m && (!best || m.at > best.at)) best = m;
    }
    return best;
  });
  if (!mark) return null;
  const text = aiMarkText(mark);
  return (
    <span className={`ai-mark${className ? ` ${className}` : ''}`} title={`${text}: ${mark.label}`} aria-label={text} role="img">
      <Sparkles size={11} aria-hidden="true" />
    </span>
  );
}
