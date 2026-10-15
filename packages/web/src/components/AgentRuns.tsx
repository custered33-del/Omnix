import { useEffect, useState } from 'react';
import { Bot, Check, CircleDot, Circle, CircleCheck, Square, RotateCcw, MessageSquareWarning, Play, ChevronDown, ChevronRight, Copy, Flag } from 'lucide-react';
import { get, post } from '../lib/api.js';
import { realtime } from '../state/realtime.js';
import { Dialog, Spinner, Switch } from '../ui/primitives.js';
import { toast } from '../ui/toast.js';
import { formatRelative, plural, t } from '../i18n/index.js';

export interface GateSpec {
  kind: 'plan' | 'stage' | 'export' | 'delete' | 'custom';
  label?: string;
}

export interface AgentRun {
  id: string;
  projectId: string | null;
  title: string;
  status: 'queued' | 'running' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled';
  progress: number;
  message: string;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  goal: string;
  driver: 'internal' | 'external';
  gates: GateSpec[];
  plan: { title: string; status: 'pending' | 'active' | 'done' }[];
  checkpoints: { id: string; stage: string; summary: string; snapshotId: string | null; head: string | null; at: string }[];
  pendingGate: { id: string; kind: string; title: string; summary: string; at: string; tool?: { name: string; input: unknown } } | null;
  decisions: { gateId: string; title: string; decision: string; feedback?: string; by: string; at: string }[];
  log: { at: string; kind: string; text: string; tool?: string; ok?: boolean }[];
  steps: number;
  maxSteps: number;
  model: string | null;
  usage: { input: number; output: number };
  summary: string | null;
}

/** Live list of agent runs for a project (updates on job events). */
export function useAgentRuns(projectId: string): AgentRun[] | null {
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => get<{ runs: AgentRun[] }>(`/api/agent/runs?projectId=${projectId}`).then((r) => alive && setRuns(r.runs), () => {});
    void load();
    let timer: number | null = null;
    const off = realtime.on('job', (m: { job: { kind: string; projectId: string | null } }) => {
      if (m.job.kind !== 'agent' || m.job.projectId !== projectId) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(load, 250);
    });
    return () => {
      alive = false;
      off();
      if (timer) window.clearTimeout(timer);
    };
  }, [projectId]);
  return runs;
}

const STATUS_BADGE: Record<AgentRun['status'], string> = { queued: '', running: 'ai', awaiting_approval: 'warning', done: 'success', failed: 'danger', cancelled: '' };

export function AgentRunsPanel({ projectId, projectName, focusId, onStart }: { projectId: string; projectName: string; focusId: string | null; onStart: () => void }) {
  const runs = useAgentRuns(projectId);
  void projectName;
  return (
    <div className="col" style={{ gap: 12 }}>
      <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
        {t('agent.panelHint')}
      </p>
      <button className="btn btn-ai" onClick={onStart} style={{ alignSelf: 'flex-start' }}>
        <Play /> {t('agent.start')}
      </button>
      {!runs && <Spinner />}
      {runs && runs.length === 0 && <p className="muted">{t('agent.none')}</p>}
      {runs?.map((r) => <RunCard key={r.id} run={r} focused={r.id === focusId} />)}
    </div>
  );
}

function StageIcon({ status }: { status: 'pending' | 'active' | 'done' }) {
  if (status === 'done') return <CircleCheck size={15} className="success-ink" aria-label={t('agent.stageDone')} />;
  if (status === 'active') return <CircleDot size={15} className="ai-ink" aria-label={t('agent.stageActive')} />;
  return <Circle size={15} className="muted" aria-label={t('agent.stagePending')} />;
}

export function RunCard({ run, focused }: { run: AgentRun; focused: boolean }) {
  const [feedback, setFeedback] = useState('');
  const [mode, setMode] = useState<'idle' | 'changes' | 'stop'>('idle');
  const [rollback, setRollback] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const live = run.status === 'running' || run.status === 'queued' || run.status === 'awaiting_approval';
  const act = async (decision: 'approve' | 'changes' | 'stop') => {
    setBusy(true);
    try {
      await post(`/api/agent/runs/${run.id}/decision`, { decision, ...(feedback.trim() ? { feedback: feedback.trim() } : {}), ...(decision === 'stop' && rollback ? { rollbackTo: rollback } : {}) });
      setFeedback('');
      setMode('idle');
      toast.success(decision === 'approve' ? t('agent.approved') : decision === 'changes' ? t('agent.changesSent') : t('agent.stopped'));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const rollbackTo = async (to: string) => {
    try {
      const r = await post<{ reverted: number }>(`/api/agent/runs/${run.id}/rollback`, { to });
      toast.success(plural('agent.rolledBack', r.reverted));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <article className={`card run-card${focused ? ' focused' : ''}`} aria-label={run.goal}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <Bot size={18} className="ai-ink" aria-hidden="true" style={{ marginTop: 2 }} />
        <div className="grow" style={{ minWidth: 0 }}>
          <strong className="run-goal">{run.goal}</strong>
          <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
            {formatRelative(run.createdAt)} · {run.driver === 'external' ? t('agent.drivenByConnection') : t('agent.drivenBuiltIn')}
            {run.steps > 0 && ` · ${t('agent.steps', { n: run.steps })}`}
          </div>
        </div>
        <span className={`badge ${STATUS_BADGE[run.status]}`}>{t(`agent.status.${run.status}`)}</span>
      </div>
      {live && run.status !== 'awaiting_approval' && (
        <div className="row" style={{ fontSize: 'var(--fs-sm)' }}>
          <Spinner /> <span className="truncate">{run.message}</span>
        </div>
      )}
      {run.plan.length > 0 && (
        <ol className="run-plan" aria-label={t('agent.plan')}>
          {run.plan.map((s, i) => (
            <li key={i} className={s.status}>
              <StageIcon status={s.status} />
              <span>{s.title}</span>
            </li>
          ))}
        </ol>
      )}
      {run.pendingGate && run.status === 'awaiting_approval' && (
        <div className="gate-card" role="group" aria-label={run.pendingGate.title}>
          <div className="row">
            <Flag size={16} aria-hidden="true" />
            <strong className="grow">{run.pendingGate.title}</strong>
          </div>
          {run.pendingGate.summary && <p className="gate-summary">{run.pendingGate.summary}</p>}
          {mode === 'idle' && (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="btn btn-sm btn-ai" disabled={busy} onClick={() => void act('approve')}>
                <Check /> {run.pendingGate.kind === 'budget' ? t('agent.continue') : t('agent.approve')}
              </button>
              <button className="btn btn-sm" disabled={busy} onClick={() => setMode('changes')}>
                <MessageSquareWarning /> {run.pendingGate.tool ? t('agent.decline') : t('agent.requestChanges')}
              </button>
              <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => setMode('stop')}>
                <Square /> {t('agent.stop')}
              </button>
            </div>
          )}
          {mode === 'changes' && (
            <form
              className="col"
              onSubmit={(e) => {
                e.preventDefault();
                void act('changes');
              }}
            >
              <label className="label" htmlFor={`fb-${run.id}`}>
                {t('agent.feedbackLabel')}
              </label>
              <textarea id={`fb-${run.id}`} className="textarea" value={feedback} onChange={(e) => setFeedback(e.target.value)} autoFocus />
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-sm" onClick={() => setMode('idle')}>
                  {t('app.cancel')}
                </button>
                <button type="submit" className="btn btn-sm btn-ai" disabled={busy}>
                  {t('agent.send')}
                </button>
              </div>
            </form>
          )}
          {mode === 'stop' && (
            <div className="col">
              <label className="label" htmlFor={`rb-${run.id}`}>
                {t('agent.stopAndKeep')}
              </label>
              <select id={`rb-${run.id}`} className="select" value={rollback} onChange={(e) => setRollback(e.target.value)}>
                <option value="">{t('agent.keepChanges')}</option>
                {run.checkpoints.map((c) => (
                  <option key={c.id} value={c.id}>
                    {t('agent.rollBackTo', { stage: c.stage })}
                  </option>
                ))}
                <option value="start">{t('agent.rollBackAll')}</option>
              </select>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-sm" onClick={() => setMode('idle')}>
                  {t('app.cancel')}
                </button>
                <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => void act('stop')}>
                  {t('agent.stop')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {run.status === 'running' && mode === 'idle' && (
        <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => void act('stop')}>
          <Square /> {t('agent.stop')}
        </button>
      )}
      {run.summary && <p className="run-summary">{run.summary}</p>}
      {run.error && <p className="danger-ink" style={{ fontSize: 'var(--fs-sm)' }}>{run.error}</p>}
      {run.status === 'failed' && run.driver === 'internal' && (
        <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => void post(`/api/agent/runs/${run.id}/retry`, {}).catch((e) => toast.error((e as Error).message))}>
          <RotateCcw /> {t('agent.retry')}
        </button>
      )}
      {run.checkpoints.length > 0 && (
        <div className="col" style={{ gap: 4 }}>
          <span className="label">{t('agent.checkpoints')}</span>
          <ul className="run-checkpoints">
            {run.checkpoints.map((c) => (
              <li key={c.id}>
                <span className="grow">
                  <strong>{c.stage}</strong> <span className="muted">{c.summary}</span>
                </span>
                {!live && (
                  <button className="btn btn-sm btn-ghost" onClick={() => void rollbackTo(c.id)} title={t('agent.rollBackTo', { stage: c.stage })}>
                    <RotateCcw size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {run.log.length > 0 && (
        <div>
          <button className="btn btn-sm btn-ghost" onClick={() => setShowLog(!showLog)} aria-expanded={showLog}>
            {showLog ? <ChevronDown /> : <ChevronRight />} {t('agent.log', { n: run.log.length })}
          </button>
          {showLog && (
            <ol className="run-log">
              {run.log.slice(-60).map((l, i) => (
                <li key={i} className={`log-${l.kind}${l.ok === false ? ' failed' : ''}`}>
                  <span className="muted tabular">{new Date(l.at).toLocaleTimeString()}</span> {l.tool && <code>{l.tool}</code>} {l.text}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </article>
  );
}

const GATE_KINDS = ['plan', 'stage', 'export', 'delete'] as const;

/** Start an autonomous run: the goal, and where Claude should stop for the person. */
export function AgentStartDialog({ projectId, projectName, initialGoal, onClose, onStarted }: { projectId: string; projectName: string; initialGoal: string; onClose: () => void; onStarted: (runId: string) => void }) {
  const [status, setStatus] = useState<{ available: boolean; model: string | null } | null>(null);
  const [goal, setGoal] = useState(initialGoal);
  const [gates, setGates] = useState<Set<(typeof GATE_KINDS)[number]>>(new Set(GATE_KINDS));
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void get<{ available: boolean; model: string | null }>('/api/agent/status').then(setStatus, () => setStatus({ available: false, model: null }));
  }, []);
  const prompt = `In Omnix, in the project "${projectName}" (id ${projectId}): ${goal.trim() || '<your goal>'}. Start with agent_start_run, plan the stages, and pause at my approval gates.`;
  const start = async () => {
    setBusy(true);
    try {
      const list: GateSpec[] = [...gates].map((kind) => ({ kind }));
      for (const c of custom.split('\n').map((x) => x.trim()).filter(Boolean)) list.push({ kind: 'custom', label: c });
      const r = await post<{ run: AgentRun }>(`/api/projects/${projectId}/agent`, { goal: goal.trim(), gates: list });
      onStarted(r.run.id);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('agent.startTitle')}
      description={t('agent.startHint')}
      onClose={onClose}
      icon={<Bot />}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('app.cancel')}
          </button>
          {status?.available && (
            <button className="btn btn-ai" disabled={busy || !goal.trim()} onClick={() => void start()}>
              {busy ? <Spinner /> : <Play />} {t('agent.start')}
            </button>
          )}
        </>
      }
    >
      <div className="col" style={{ gap: 16 }}>
        <div className="col">
          <label className="label" htmlFor="agent-goal">
            {t('agent.goal')}
          </label>
          <textarea id="agent-goal" className="textarea" rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={t('agent.goalPlaceholder')} autoFocus />
        </div>
        <fieldset className="col" style={{ border: 'none', padding: 0, margin: 0, gap: 8 }}>
          <legend className="label">{t('agent.gates')}</legend>
          {GATE_KINDS.map((k) => (
            <Switch
              key={k}
              checked={gates.has(k)}
              onChange={(v) => {
                const next = new Set(gates);
                if (v) next.add(k);
                else next.delete(k);
                setGates(next);
              }}
              label={t(`agent.gate.${k}`)}
            />
          ))}
          <label className="label" htmlFor="agent-custom" style={{ marginTop: 6 }}>
            {t('agent.customGates')}
          </label>
          <textarea id="agent-custom" className="textarea" rows={2} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={t('agent.customPlaceholder')} />
        </fieldset>
        {status && !status.available && (
          <div className="ai-note">
            <p style={{ fontSize: 'var(--fs-sm)' }}>{t('agent.noKey')}</p>
            <pre className="copy-block">{prompt}</pre>
            <button
              className="btn btn-sm"
              onClick={() => {
                void navigator.clipboard.writeText(prompt).then(() => toast.success(t('app.copied')));
              }}
            >
              <Copy /> {t('agent.copyPrompt')}
            </button>
          </div>
        )}
        {status?.available && status.model && <p className="muted" style={{ fontSize: 'var(--fs-xs)' }}>{t('agent.model', { model: status.model })}</p>}
      </div>
    </Dialog>
  );
}
