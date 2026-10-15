import { useEffect, useState } from 'react';
import { Check, X, Eye, Pencil, Plus, Minus, PenLine } from 'lucide-react';
import type { Operation, Proposal, StateDiff, NodeChange } from '@omnix/core';
import { describeOp, opCount } from '@omnix/core';
import { useProject, useProjectStore } from '../state/project.js';
import { get } from '../lib/api.js';
import { Avatar, Dialog, Spinner } from '../ui/primitives.js';
import { toast } from '../ui/toast.js';
import { formatRelative, t } from '../i18n/index.js';

function short(v: unknown): string {
  if (v === undefined) return '—';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

export function DiffView({ diff }: { diff: StateDiff }) {
  if (diff.empty) return <p className="muted">No visible changes.</p>;
  const changeRow = (c: NodeChange) => (
    <li key={c.id} style={{ marginBottom: 6 }}>
      <div className="row" style={{ fontSize: 'var(--fs-sm)' }}>
        <PenLine size={14} style={{ color: 'var(--warning)' }} aria-hidden="true" />
        <strong className="truncate">{c.name}</strong>
        <span className="muted">{c.type}</span>
        {c.moved && <span className="badge">moved</span>}
        {c.reordered && <span className="badge">reordered</span>}
      </div>
      {c.props.length > 0 && (
        <dl className="kv" style={{ marginLeft: 20, marginTop: 4, gridTemplateColumns: 'auto 1fr' }}>
          {c.props.slice(0, 8).map((p) => (
            <div key={p} style={{ display: 'contents' }}>
              <dt>{p}</dt>
              <dd className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                <span style={{ color: 'var(--danger)', textDecoration: 'line-through' }}>{short(c.before[p])}</span> → <span style={{ color: 'var(--success)' }}>{short(c.after[p])}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {diff.added.map((a) => (
        <li key={a.id} className="row" style={{ fontSize: 'var(--fs-sm)', marginBottom: 6 }}>
          <Plus size={14} style={{ color: 'var(--success)' }} aria-label={t('proposals.added')} />
          <strong className="truncate">{a.name}</strong>
          <span className="muted">{a.type}</span>
        </li>
      ))}
      {diff.removed.map((a) => (
        <li key={a.id} className="row" style={{ fontSize: 'var(--fs-sm)', marginBottom: 6 }}>
          <Minus size={14} style={{ color: 'var(--danger)' }} aria-label={t('proposals.removed')} />
          <strong className="truncate">{a.name}</strong>
          <span className="muted">{a.type}</span>
        </li>
      ))}
      {diff.changed.map(changeRow)}
    </ul>
  );
}

function ProposalCard({ p, focused }: { p: Proposal; focused: boolean }) {
  const store = useProjectStore();
  const preview = useProject((s) => s.preview);
  const [diff, setDiff] = useState<StateDiff | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [modifying, setModifying] = useState(false);
  const [busy, setBusy] = useState(false);
  const projectId = store.getState().projectId;
  useEffect(() => {
    get<{ diff: StateDiff }>(`/api/projects/${projectId}/proposals/${p.id}/preview`).then(
      (r) => setDiff(r.diff),
      () => setDiff(null),
    );
  }, [p.id, projectId]);
  const previewing = preview?.proposalId === p.id;
  const act = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, outline: focused ? '2px solid var(--ai)' : undefined }}>
      <div className="row">
        <Avatar name={p.author.name} ai={p.author.type === 'ai'} />
        <div className="grow" style={{ minWidth: 0 }}>
          <strong>{p.label}</strong>
          <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
            {t('proposals.by', { name: p.author.name })} · {formatRelative(p.createdAt)} · {opCount({ kind: 'batch', ops: p.ops })} ops
          </div>
        </div>
      </div>
      {p.description && <p className="text-2" style={{ fontSize: 'var(--fs-sm)' }}>{p.description}</p>}
      {p.steps && p.steps.length > 1 && (
        <details open={p.steps.length <= 6}>
          <summary className="label" style={{ cursor: 'pointer' }}>
            {t('ai.steps')} ({p.steps.length})
          </summary>
          <ol className="proposal-steps">
            {p.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </details>
      )}
      {diff ? <DiffView diff={diff} /> : <Spinner />}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn btn-sm" aria-pressed={previewing} onClick={() => void store.getState().previewProposal(previewing ? null : p.id)}>
          <Eye /> {previewing ? t('proposals.stopPreview') : t('proposals.preview')}
        </button>
        <button className="btn btn-sm btn-ai" disabled={busy} onClick={() => void act(() => store.getState().acceptProposal(p.id), t('proposals.accepted'))}>
          <Check /> {t('proposals.accept')}
        </button>
        <button className="btn btn-sm" disabled={busy} onClick={() => setModifying(true)}>
          <Pencil /> {t('proposals.modify')}
        </button>
        <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => setRejecting(true)}>
          <X /> {t('proposals.reject')}
        </button>
      </div>
      {rejecting && (
        <form
          className="col"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => store.getState().rejectProposal(p.id, reason || undefined), t('proposals.rejected'));
          }}
        >
          <label className="label" htmlFor={`reason-${p.id}`}>
            {t('proposals.rejectReason')}
          </label>
          <textarea id={`reason-${p.id}`} className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="row">
            <button type="button" className="btn btn-sm" onClick={() => setRejecting(false)}>
              {t('app.cancel')}
            </button>
            <button type="submit" className="btn btn-sm btn-danger">
              {t('proposals.reject')}
            </button>
          </div>
        </form>
      )}
      {modifying && <ModifyDialog proposal={p} onClose={() => setModifying(false)} />}
    </article>
  );
}

/** Modify a proposal before accepting: include or exclude individual changes and edit values. */
function ModifyDialog({ proposal, onClose }: { proposal: Proposal; onClose: () => void }) {
  const store = useProjectStore();
  const state = useProject((s) => s.confirmed);
  // Stacked AI changes and commands carry one named step per operation: review them step by step.
  const bySteps = !!proposal.steps && proposal.steps.length === proposal.ops.length;
  const flat = bySteps ? proposal.ops : proposal.ops.flatMap((o) => (o.kind === 'batch' ? o.ops : [o]));
  const [included, setIncluded] = useState(() => flat.map(() => true));
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const buildOps = (): Operation[] =>
    flat
      .map((op, i) => {
        if (!included[i]) return null;
        if (edits[i] !== undefined && op.kind === 'update') return { ...op, set: JSON.parse(edits[i]!) } as Operation;
        return op;
      })
      .filter((x): x is Operation => !!x);
  return (
    <Dialog
      title={`${t('proposals.modify')}: ${proposal.label}`}
      onClose={onClose}
      wide
      footer={
        <>
          {error && <span style={{ color: 'var(--danger)', marginRight: 'auto' }}>{error}</span>}
          <button className="btn" onClick={onClose}>
            {t('app.cancel')}
          </button>
          <button
            className="btn btn-ai"
            onClick={async () => {
              try {
                const ops = buildOps();
                await store.getState().acceptProposal(proposal.id, ops);
                toast.success(t('proposals.accepted'));
                onClose();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {t('proposals.accept')}
          </button>
        </>
      }
    >
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {flat.map((op, i) => (
          <li key={i} className="card" style={{ padding: 12 }}>
            <label className="check">
              <input type="checkbox" checked={included[i]} onChange={(e) => setIncluded((cur) => cur.map((v, j) => (j === i ? e.target.checked : v)))} />
              {bySteps ? proposal.steps![i] : describeOp(op, state ?? undefined)}
            </label>
            {op.kind === 'update' && included[i] && (
              <textarea
                className="textarea mono"
                style={{ marginTop: 8, fontSize: 12, minHeight: 60 }}
                aria-label="Values"
                value={edits[i] ?? JSON.stringify(op.set, null, 2)}
                onChange={(e) => {
                  setEdits((cur) => ({ ...cur, [i]: e.target.value }));
                  try {
                    JSON.parse(e.target.value);
                    setError(null);
                  } catch {
                    setError('Values must be valid JSON');
                  }
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

export function ProposalsPanel({ focusId }: { focusId: string | null }) {
  const proposals = useProject((s) => s.proposals);
  if (!proposals.length) return <p className="muted">{t('proposals.empty')}</p>;
  return (
    <div className="col" style={{ gap: 12 }}>
      {proposals
        .slice()
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((p) => (
          <ProposalCard key={p.id} p={p} focused={p.id === focusId} />
        ))}
    </div>
  );
}
