import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Wand2, ArrowRight, Check, Eye, Sparkles, CircleAlert } from 'lucide-react';
import { useProjectStore, useProject } from '../state/project.js';
import { realtime } from '../state/realtime.js';
import { get, post } from '../lib/api.js';
import { Spinner } from '../ui/primitives.js';
import { toast } from '../ui/toast.js';
import { plural, t } from '../i18n/index.js';

type Unmatched = { clause: string; reason: string }[];
type Result =
  | { status: 'proposed'; proposalId: string; steps: string[]; unmatched: Unmatched }
  | { status: 'delegated'; runId: string; unmatched: Unmatched }
  | { status: 'not-understood'; unmatched: Unmatched; examples: string[] };

export interface AiCapabilities {
  claude: boolean;
  imageProviders: { id: string; label: string; generative: boolean }[];
  commandExamples: Record<string, string[]>;
  styleAspects: string[];
}

let capsCache: Promise<AiCapabilities> | null = null;
/** What this server can do (Claude, image models, command examples), fetched once per page load. */
export function aiCapabilities(): Promise<AiCapabilities> {
  capsCache ??= get<AiCapabilities>('/api/ai/capabilities').catch((e) => {
    capsCache = null;
    throw e;
  });
  return capsCache;
}

function toolOfActive(type: string | undefined, purpose?: string): string {
  if (type === 'canvas') return 'image';
  if (type === 'sequence') return purpose === 'animation' ? 'animation' : 'video';
  if (type === 'deck') return 'slides';
  return 'document';
}

/**
 * Natural-language commands inside a project: "make the sky warmer and move the title to the lower
 * third" becomes one proposal with a step per phrase, which the person reviews like any AI change.
 */
export function CommandBar({ initialText, autoRun, onClose, onReview }: { initialText: string; autoRun: boolean; onClose: () => void; onReview: (proposalId: string) => void }) {
  const store = useProjectStore();
  const activeDocId = useProject((s) => s.activeDocId);
  const active = useProject((s) => (s.activeDocId ? s.state?.nodes[s.activeDocId] : undefined));
  const aiConsent = useProject((s) => !!s.meta?.aiConsent);
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [runState, setRunState] = useState<'running' | 'done' | 'failed' | null>(null);
  const [caps, setCaps] = useState<AiCapabilities | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tool = toolOfActive(active?.type, (active?.props as { purpose?: string } | undefined)?.purpose);
  const examples = caps?.commandExamples[tool] ?? [];

  useEffect(() => {
    void aiCapabilities().then(setCaps, () => {});
    setTimeout(() => inputRef.current?.focus(), 0);
    if (autoRun && initialText.trim()) void submit(initialText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow a command handed to Claude until its proposal is ready.
  useEffect(() => {
    if (result?.status !== 'delegated') return;
    setRunState('running');
    return realtime.on('job', (m: { job: { id: string; status: string; error: string | null } }) => {
      if (m.job.id !== result.runId) return;
      if (m.job.status === 'done') setRunState('done');
      if (m.job.status === 'failed' || m.job.status === 'cancelled') {
        setRunState('failed');
        if (m.job.error) toast.error(m.job.error);
      }
    });
  }, [result]);

  const submit = async (value = text) => {
    if (!value.trim() || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const ctx = store.getState();
      const r = await post<Result>(`/api/projects/${ctx.projectId}/commands`, { text: value.trim(), documentId: activeDocId, selection: ctx.selection, slideId: ctx.editorContext.slideId, time: ctx.editorContext.time });
      setResult(r);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const acceptAll = async (proposalId: string) => {
    try {
      await store.getState().acceptProposal(proposalId);
      toast.success(t('proposals.accepted'));
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const latestProposal = () => {
    if (result?.status !== 'delegated') return null;
    return store.getState().proposals.find((p) => p.jobId === result.runId) ?? null;
  };

  return createPortal(
    <div className="dialog-backdrop" style={{ alignItems: 'flex-start', paddingTop: '10vh' }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog command-bar" role="dialog" aria-modal="true" aria-label={t('commands.title')}>
        <form
          className="command-input"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Wand2 size={18} aria-hidden="true" className="ai-ink" />
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={examples[0] ? `${t('commands.placeholder')} ${examples[0]}` : t('commands.placeholder')}
            aria-label={t('commands.title')}
            onKeyDown={(e) => e.key === 'Escape' && onClose()}
          />
          <button className="btn btn-sm btn-ai" type="submit" disabled={busy || !text.trim()}>
            {busy ? <Spinner /> : <ArrowRight />} {t('commands.run')}
          </button>
        </form>
        <div className="command-body" aria-live="polite">
          {!result && !busy && (
            <>
              <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
                {t('commands.hint')}
              </p>
              {examples.length > 0 && (
                <div className="chip-row" style={{ marginTop: 8 }}>
                  {examples.map((x) => (
                    <button key={x} type="button" className="chip" onClick={() => setText(x)}>
                      {x}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          {result?.status === 'proposed' && (
            <div className="col" style={{ gap: 10 }}>
              <p>
                <Check size={16} className="success-ink" aria-hidden="true" /> {plural('commands.proposed', result.steps.length)}
              </p>
              <ol className="proposal-steps">
                {result.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
              <Unmatched list={result.unmatched} />
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-sm" onClick={() => onReview(result.proposalId)}>
                  <Eye /> {t('commands.review')}
                </button>
                <button className="btn btn-sm btn-ai" onClick={() => void acceptAll(result.proposalId)}>
                  <Check /> {t('commands.acceptAll')}
                </button>
              </div>
            </div>
          )}
          {result?.status === 'delegated' && (
            <div className="col" style={{ gap: 10 }}>
              <p className="row">
                {runState === 'running' ? <Spinner /> : <Sparkles size={16} className="ai-ink" aria-hidden="true" />}
                {runState === 'done' ? t('commands.claudeDone') : runState === 'failed' ? t('commands.claudeFailed') : t('commands.claudeWorking')}
              </p>
              {runState === 'done' && latestProposal() && (
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn btn-sm btn-ai" onClick={() => onReview(latestProposal()!.id)}>
                    <Eye /> {t('commands.review')}
                  </button>
                </div>
              )}
            </div>
          )}
          {result?.status === 'not-understood' && (
            <div className="col" style={{ gap: 10 }}>
              <Unmatched list={result.unmatched} />
              {!caps?.claude && <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>{t('commands.noClaude')}</p>}
              {caps?.claude && !aiConsent && <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>{t('commands.noConsent')}</p>}
              {result.examples.length > 0 && (
                <>
                  <span className="label">{t('commands.tryThese')}</span>
                  <div className="chip-row">
                    {result.examples.map((x) => (
                      <button key={x} type="button" className="chip" onClick={() => setText(x)}>
                        {x}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Unmatched({ list }: { list: Unmatched }) {
  if (!list.length) return null;
  return (
    <ul className="unmatched" aria-label={t('commands.notUnderstood')}>
      {list.map((u, i) => (
        <li key={i}>
          <CircleAlert size={14} aria-hidden="true" />
          <span>
            <strong>“{u.clause}”</strong> {u.reason}
          </span>
        </li>
      ))}
    </ul>
  );
}
