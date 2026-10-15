import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { CellOutput, SceneNode } from '@omnix/core';
import { childrenOf } from '@omnix/core';
import { get } from '../../lib/api.js';
import { useProject } from '../../state/project.js';
import { Spinner, Switch } from '../../ui/primitives.js';
import { toast } from '../../ui/toast.js';
import { formatRelative, t } from '../../i18n/index.js';
import { Outputs } from './Outputs.js';
import { restartKernel, runTarget, type CodeCtx, type RunResult } from './codeApi.js';

/* ---------------- terminal ---------------- */

type Line = { kind: 'cmd' | 'out' | 'err' | 'info'; text: string } | { kind: 'outputs'; outputs: CellOutput[] };

/** A small command console for the workspace (not a system shell: everything runs in the sandbox). */
export function Terminal({ ctx, lines, setLines }: { ctx: CodeCtx; lines: Line[]; setLines: (f: (l: Line[]) => Line[]) => void }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const past = useRef<string[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const state = useProject((s) => s.state)!;
  const streams = useProject((s) => s.codeStreams);
  const startedAt = useRef<Set<string>>(new Set());
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [lines, streams]);

  const files = childrenOf(state, ctx.workspaceId).filter((n): n is SceneNode<'codeFile'> => n.type === 'codeFile');
  const push = (...l: Line[]) => setLines((cur) => [...cur, ...l].slice(-400));

  const exec = async (raw: string) => {
    const cmd = raw.trim();
    if (!cmd) return;
    past.current.push(cmd);
    setHistoryIdx(null);
    push({ kind: 'cmd', text: `› ${cmd}` });
    const [head, ...rest] = cmd.split(/\s+/);
    const arg = cmd.slice(head!.length).trim();
    try {
      switch (head) {
        case 'help':
          push({ kind: 'info', text: t('code.terminalHelp') });
          return;
        case 'clear':
          setLines(() => []);
          return;
        case 'ls':
          push({ kind: 'out', text: files.map((f) => f.props.path).join('\n') || '(no files)' });
          return;
        case 'cat': {
          const f = files.find((x) => x.props.path === arg);
          push(f ? { kind: 'out', text: f.props.content } : { kind: 'err', text: `No such file: ${arg}` });
          return;
        }
        case 'restart':
          await restartKernel(ctx);
          push({ kind: 'info', text: 'Kernels restarted.' });
          return;
        case 'run':
        case 'python':
        case 'js':
        case 'ts': {
          setBusy(true);
          const before = new Set(Object.keys(ctx.store.getState().codeStreams));
          startedAt.current = before;
          let target: Parameters<typeof runTarget>[1];
          if (head === 'run') {
            const f = files.find((x) => x.props.path === (arg || rest[0]));
            if (!f) throw new Error(`No such file: ${arg}. Try ls.`);
            target = { fileId: f.id };
          } else target = { source: arg, language: head === 'python' ? 'python' : head === 'js' ? 'javascript' : 'typescript' };
          const r = (await runTarget(ctx, target)) as RunResult;
          ctx.store.getState().dropCodeStream(r.runId);
          push({ kind: 'outputs', outputs: r.outputs }, { kind: 'info', text: `${r.ok ? 'Finished' : 'Failed'} in ${r.ms} ms` });
          return;
        }
        default:
          push({ kind: 'err', text: `Unknown command: ${head}. Type help.` });
      }
    } catch (e) {
      push({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const live = busy ? Object.entries(streams).filter(([id, st]) => !startedAt.current.has(id) && st.cellId === null) : [];
  return (
    <div className="col" style={{ flex: 1, minHeight: 0, gap: 0 }}>
      <div className="terminal" role="log" aria-live="polite" aria-label={t('code.terminal')}>
        {lines.length === 0 && <div className="muted">{t('code.terminalHelp')}</div>}
        {lines.map((l, i) =>
          l.kind === 'outputs' ? (
            <div key={i} className="terminal-outputs">
              <Outputs outputs={l.outputs} />
            </div>
          ) : (
            <div key={i} className={l.kind === 'cmd' ? 'cmd' : l.kind === 'err' ? 'err' : l.kind === 'info' ? 'muted' : undefined}>
              {l.text}
            </div>
          ),
        )}
        {live.map(([id, st]) => (
          <div key={id}>
            {st.text}
            {st.stderr && <span className="err">{st.stderr}</span>}
          </div>
        ))}
        {busy && <Spinner />}
        <div ref={end} />
      </div>
      <form
        className="terminal-input"
        onSubmit={(e) => {
          e.preventDefault();
          const v = input;
          setInput('');
          void exec(v);
        }}
      >
        <span aria-hidden="true">›</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="Terminal command"
          placeholder="run main.py"
          disabled={busy}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' && past.current.length) {
              e.preventDefault();
              const i = historyIdx === null ? past.current.length - 1 : Math.max(0, historyIdx - 1);
              setHistoryIdx(i);
              setInput(past.current[i]!);
            } else if (e.key === 'ArrowDown' && historyIdx !== null) {
              e.preventDefault();
              const i = historyIdx + 1;
              if (i >= past.current.length) {
                setHistoryIdx(null);
                setInput('');
              } else {
                setHistoryIdx(i);
                setInput(past.current[i]!);
              }
            }
          }}
        />
      </form>
    </div>
  );
}

export type { Line as TerminalLine };

/* ---------------- git history ---------------- */

interface CommitInfo {
  oid: string;
  message: string;
  author: { name: string; email: string };
  timestamp: number;
  aiAuthored: boolean;
}

export function GitHistory({ ctx }: { ctx: CodeCtx }) {
  const projectId = ctx.store.getState().projectId;
  const head = useProject((s) => s.head);
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ files: { path: string; status: string; patch: string }[] } | null>(null);
  useEffect(() => {
    // Code history is written a moment after edits; refresh shortly after the project changes.
    const timer = window.setTimeout(() => get<{ commits: CommitInfo[] }>(`/api/projects/${projectId}/code/${ctx.workspaceId}/history`).then((r) => setCommits(r.commits), (e) => toast.error(e.message)), 1500);
    return () => window.clearTimeout(timer);
  }, [head, projectId, ctx.workspaceId]);
  useEffect(() => {
    if (!open) return setDetail(null);
    get<{ files: { path: string; status: string; patch: string }[] }>(`/api/projects/${projectId}/code/${ctx.workspaceId}/history/${open}`).then(setDetail, (e) => toast.error(e.message));
  }, [open]);
  if (!commits) return <Spinner />;
  if (!commits.length) return <p className="muted" style={{ padding: 12 }}>No code history yet. Edits are saved as git commits.</p>;
  return (
    <div style={{ overflow: 'auto', flex: 1 }}>
      <ul className="git-list" role="listbox" aria-label={t('code.history')}>
        {commits.map((c) => (
          <li key={c.oid} role="option" aria-selected={open === c.oid} tabIndex={0} onClick={() => setOpen(open === c.oid ? null : c.oid)} onKeyDown={(e) => e.key === 'Enter' && setOpen(open === c.oid ? null : c.oid)}>
            <div className="row" style={{ gap: 6 }}>
              {c.aiAuthored && <Sparkles size={13} className="ai-mark" aria-label="By Claude" />}
              <span className="grow truncate" style={{ fontWeight: 550 }}>
                {c.message.split('\n')[0]}
              </span>
              <code className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                {c.oid.slice(0, 7)}
              </code>
            </div>
            <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
              {t('code.commitBy', { name: c.author.name, when: formatRelative(new Date(c.timestamp).toISOString()) })}
            </div>
            {open === c.oid && detail && (
              <div onClick={(e) => e.stopPropagation()}>
                {detail.files.map((f) => (
                  <div key={f.path} style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 'var(--fs-xs)', fontWeight: 600 }}>
                      {f.path} · {f.status}
                    </div>
                    <div className="diff">
                      {f.patch
                        .split('\n')
                        .slice(4)
                        .map((l, i) => (
                          <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : undefined}>
                            {l || ' '}
                            {'\n'}
                          </span>
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------- sandbox settings ---------------- */

interface SandboxStatus {
  sandbox: { kernels: { key: string; language: string; busy: boolean; rssMb?: number }[]; canRun: boolean; permissionModel: boolean; warnings: string[] };
  limits: { timeoutMs: number; maxRssMb: number; packageAllowlist: string[]; maxPackages: number };
}

export function SandboxSettings({ ctx }: { ctx: CodeCtx }) {
  const ws = useProject((s) => s.state?.nodes[ctx.workspaceId]) as SceneNode<'codeWorkspace'>;
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  useEffect(() => {
    get<SandboxStatus>('/api/code/status').then(setStatus, () => {});
  }, []);
  const s = ctx.store.getState();
  const p = ws.props;
  return (
    <div className="col" style={{ padding: 12, gap: 14, overflow: 'auto' }}>
      {status?.sandbox.warnings.map((w) => (
        <p key={w} className={`notice ${status.sandbox.canRun ? 'warning' : 'danger'}`} role="note" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
          {w}
        </p>
      ))}
      <Switch checked={p.allowNetwork} disabled={!canEdit} onChange={(v) => s.commit({ kind: 'update', id: ws.id, set: { allowNetwork: v } }, v ? 'Allow network access' : 'Block network access')} label={t('code.network')} hint={t('code.networkHint')} />
      <div className="col" style={{ gap: 6 }}>
        <span className="label">{t('code.packages')}</span>
        {status ? (
          <>
            <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
              Python packages bundled for offline use. Choose up to {status.limits.maxPackages}.
            </span>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {status.limits.packageAllowlist.map((pkg) => {
                const on = p.packages.includes(pkg);
                return (
                  <button
                    key={pkg}
                    className={`badge${on ? ' accent' : ''}`}
                    style={{ border: 'none', cursor: canEdit ? 'pointer' : 'default' }}
                    aria-pressed={on}
                    disabled={!canEdit || (!on && p.packages.length >= status.limits.maxPackages)}
                    onClick={() => s.commit({ kind: 'update', id: ws.id, set: { packages: on ? p.packages.filter((x) => x !== pkg) : [...p.packages, pkg] } }, on ? `Remove ${pkg}` : `Add ${pkg}`)}
                  >
                    {pkg}
                  </button>
                );
              })}
            </div>
            <p className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
              Each run is limited to {Math.round(status.limits.timeoutMs / 1000)} s and {status.limits.maxRssMb} MB of memory.{status.sandbox.permissionModel ? ' Code cannot see your files or other projects; it can only read assets used in this project.' : ''}
            </p>
          </>
        ) : (
          <Spinner />
        )}
      </div>
    </div>
  );
}
