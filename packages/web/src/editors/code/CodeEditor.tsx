import { useEffect, useMemo, useRef, useState } from 'react';
import { FileCode, FilePlus, BookOpen, Play, X, Terminal as TerminalIcon, GitCommitHorizontal, Shield, MoreHorizontal, NotebookPen } from 'lucide-react';
import type { CodeLanguage, SceneNode } from '@omnix/core';
import { childrenOf, makeNode } from '@omnix/core';
import { useFocusRequest, useProject, useProjectStore } from '../../state/project.js';
import { addComment, CommentThread, NewComment } from '../../components/Comments.js';
import { allComments } from '../../components/CommentPins.js';
import { IconButton, MenuButton, Spinner } from '../../ui/primitives.js';
import { useShortcuts } from '../../ui/shortcuts.js';
import { useCommands } from '../../state/commands.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../i18n/index.js';
import { CodeMirror, languageForPath, type LineMarks } from './CodeMirror.js';
import { NotebookView } from './Notebook.js';
import { GitHistory, SandboxSettings, Terminal, type TerminalLine } from './SidePanels.js';
import { makeTextCommitter, runTarget, type CodeCtx, type RunResult } from './codeApi.js';
import '../../styles/editors.css';

const RUNNABLE = /\.(py|js|mjs|ts)$/i;

function fileLanguage(path: string): CodeLanguage {
  const l = languageForPath(path);
  return l === 'text' ? 'text' : l;
}

export function CodeEditor({ workspaceId }: { workspaceId: string }) {
  const store = useProjectStore();
  const state = useProject((s) => s.state)!;
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  const text = useMemo(() => makeTextCommitter(store), [store]);
  const ctx: CodeCtx = useMemo(() => ({ store, workspaceId, text }), [store, workspaceId, text]);
  const ws = state.nodes[workspaceId] as SceneNode<'codeWorkspace'> | undefined;
  const items = ws ? childrenOf(state, workspaceId).filter((n) => n.type === 'codeFile' || n.type === 'notebook') : [];
  const [tabs, setTabs] = useState<string[]>(() => items.slice(0, 2).map((n) => n.id));
  const [active, setActive] = useState<string | null>(() => items[0]?.id ?? null);
  const [side, setSide] = useState<'terminal' | 'history' | 'sandbox'>('terminal');
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [running, setRunning] = useState(false);
  const [creating, setCreating] = useState<null | 'file' | 'notebook'>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const commentMode = useProject((s) => s.commentMode);
  const presence = useProject((s) => s.presence);
  const [linePop, setLinePop] = useState<{ fileId: string; line: number; commentId: string | null; top: number } | null>(null);
  const [reveal, setReveal] = useState<{ line: number; seq: number } | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const pendingPop = useRef<{ fileId: string; commentId: string | null } | null>(null);

  // Drop tabs for deleted items; keep a valid active tab.
  useEffect(() => {
    const alive = tabs.filter((id) => state.nodes[id]);
    if (alive.length !== tabs.length) setTabs(alive);
    if (active && !state.nodes[active]) setActive(alive[0] ?? null);
  }, [state]);
  // Flush typing when leaving the editor.
  useEffect(() => () => text.flushAll(), [text]);

  const open = (id: string) => {
    if (!tabs.includes(id)) setTabs([...tabs, id]);
    setActive(id);
    store.getState().reportLocation({ tool: 'code', nodeId: id });
  };
  const close = (id: string) => {
    const next = tabs.filter((x) => x !== id);
    setTabs(next);
    if (active === id) setActive(next[next.length - 1] ?? null);
  };

  const activeNode = active ? state.nodes[active] : undefined;

  // Line comments and collaborators' cursor lines in the open file.
  const fileComments = activeNode ? allComments(state).filter((c) => c.props.anchor.nodeId === activeNode.id && c.props.anchor.line !== undefined) : [];
  const commentKey = fileComments.map((c) => `${c.id}:${c.props.anchor.line}:${c.props.resolved}`).join();
  const cursorKey = Object.values(presence)
    .filter((p) => p.location?.tool === 'code' && p.location.nodeId === activeNode?.id && p.location.line)
    .map((p) => `${p.clientId}:${p.location!.line}:${p.author.name}:${p.color}`)
    .join();
  const marks: LineMarks = useMemo(
    () => ({
      comments: fileComments.map((c, i) => ({ id: c.id, line: c.props.anchor.line!, n: i + 1, resolved: c.props.resolved })),
      cursors: Object.values(presence)
        .filter((p) => p.location?.tool === 'code' && p.location.nodeId === activeNode?.id && p.location.line)
        .map((p) => ({ id: p.clientId, line: p.location!.line!, name: p.author.name, color: p.color })),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commentKey, cursorKey, activeNode?.id],
  );
  const lastLineReport = useRef(0);
  const cursorLine = useRef(1);
  const reportLine = (line: number) => {
    if (!activeNode) return;
    cursorLine.current = line;
    const now = performance.now();
    if (now - lastLineReport.current < 120) return;
    lastLineReport.current = now;
    store.getState().reportLocation({ tool: 'code', nodeId: activeNode.id, line });
  };
  // Just below the line, kept inside the pane.
  const popTop = (rect: DOMRect) => {
    const pane = paneRef.current!.getBoundingClientRect();
    return Math.max(4, Math.min(rect.bottom - pane.top + 4, pane.height - 180));
  };
  const openLinePop = (line: number, commentId: string | null, rect: DOMRect) => {
    if (!activeNode) return;
    if (!commentId && !canEdit) return;
    setLinePop({ fileId: activeNode.id, line, commentId, top: popTop(rect) });
  };
  // Jump to a comment's line (from the comments panel or a link).
  useFocusRequest(workspaceId, (r) => {
    const target = r.nodeId ? state.nodes[r.nodeId] : undefined;
    if (!target || (target.type !== 'codeFile' && target.type !== 'notebook')) return;
    open(target.id);
    if (r.line !== undefined) {
      setReveal({ line: r.line, seq: r.seq });
      pendingPop.current = r.commentId ? { fileId: target.id, commentId: r.commentId } : null;
    }
  });
  const runFile = async () => {
    if (!activeNode || activeNode.type !== 'codeFile') return;
    const f = activeNode as SceneNode<'codeFile'>;
    if (!RUNNABLE.test(f.props.path)) return toast.info('Only Python, JavaScript and TypeScript files can be run.');
    setSide('terminal');
    setRunning(true);
    setLines((l) => [...l, { kind: 'cmd', text: `› run ${f.props.path}` }]);
    try {
      const r = (await runTarget(ctx, { fileId: f.id })) as RunResult;
      store.getState().dropCodeStream(r.runId);
      setLines((l) => [...l, { kind: 'outputs', outputs: r.outputs }, { kind: 'info', text: `${r.ok ? 'Finished' : 'Failed'} in ${r.ms} ms` }]);
    } catch (e) {
      setLines((l) => [...l, { kind: 'err', text: (e as Error).message }]);
    } finally {
      setRunning(false);
    }
  };

  const create = (kind: 'file' | 'notebook', name: string) => {
    const s = store.getState();
    const clean = name.trim();
    if (!clean) return;
    if (kind === 'file') {
      if (items.some((n) => n.type === 'codeFile' && (n as SceneNode<'codeFile'>).props.path === clean)) return toast.error(`${clean} already exists`);
      const node = makeNode('codeFile', { path: clean, language: fileLanguage(clean), content: '' });
      if (s.commit({ kind: 'create', parentId: workspaceId, nodes: [node] }, `Create ${clean}`)) open(node.id);
    } else {
      const nb = makeNode('notebook', { name: clean, language: 'python' });
      const cell = makeNode('cell', { language: 'python', source: '' });
      nb.children = [cell.id];
      cell.parentId = nb.id;
      if (s.commit({ kind: 'create', parentId: workspaceId, nodes: [nb, cell] }, `Create notebook ${clean}`)) open(nb.id);
    }
  };

  useShortcuts({ 'mod+enter': () => void runFile(), 'mod+s': () => (text.flushAll(), false) }, [activeNode?.id], { allowInInputs: ['mod+enter', 'mod+s'] });
  useCommands(
    'code',
    [
      { id: 'code.run', label: `${t('code.run')} file`, section: t('tools.codeLong'), shortcut: 'mod+enter', run: () => void runFile() },
      { id: 'code.newFile', label: t('code.newFile'), section: t('tools.codeLong'), run: () => setCreating('file') },
      { id: 'code.newNotebook', label: 'New notebook', section: t('tools.codeLong'), run: () => setCreating('notebook') },
      { id: 'code.history', label: t('code.history'), section: t('tools.codeLong'), run: () => setSide('history') },
      ...(canEdit && activeNode?.type === 'codeFile'
        ? [
            {
              id: 'code.comment',
              label: t('comments.addHere'),
              section: t('tools.codeLong'),
              keywords: 'comment review note',
              run: () => {
                pendingPop.current = { fileId: activeNode.id, commentId: null };
                setReveal({ line: cursorLine.current, seq: Date.now() });
              },
            },
          ]
        : []),
    ],
    [activeNode?.id, canEdit],
  );

  if (!ws) return null;
  return (
    <div className="code-editor">
      <aside className="code-files" aria-label={t('code.files')}>
        <div className="panel-header">
          <span className="grow">{t('code.files')}</span>
          {canEdit && (
            <>
              <IconButton small label={t('code.newFile')} onClick={() => setCreating('file')}>
                <FilePlus />
              </IconButton>
              <IconButton small label="New notebook" onClick={() => setCreating('notebook')}>
                <NotebookPen />
              </IconButton>
            </>
          )}
        </div>
        <ul role="tree" aria-label={t('code.files')} style={{ listStyle: 'none', margin: 0, padding: '4px 0' }}>
          {items.map((n) => {
            const label = n.type === 'codeFile' ? (n as SceneNode<'codeFile'>).props.path : `${(n as SceneNode<'notebook'>).props.name}.ipynb`;
            return (
              <li key={n.id} role="treeitem" aria-selected={active === n.id} className="row" style={{ gap: 0 }}>
                {renaming === n.id ? (
                  <input
                    className="input sm"
                    autoFocus
                    defaultValue={n.type === 'codeFile' ? label : (n as SceneNode<'notebook'>).props.name}
                    aria-label={t('app.rename')}
                    style={{ margin: '2px 8px' }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      setRenaming(null);
                      if (!v) return;
                      if (n.type === 'codeFile') store.getState().commit({ kind: 'update', id: n.id, set: { path: v, language: fileLanguage(v) } }, `Rename to ${v}`);
                      else store.getState().commit({ kind: 'update', id: n.id, set: { name: v } }, `Rename notebook`);
                    }}
                  />
                ) : (
                  <button className="file-row" aria-current={active === n.id ? 'true' : undefined} onClick={() => open(n.id)} title={label}>
                    {n.type === 'codeFile' ? <FileCode /> : <BookOpen />}
                    <span className="truncate grow">{label}</span>
                    {n.type === 'codeFile' && ws.props.entry === label && <span className="badge" style={{ fontSize: 10 }}>entry</span>}
                  </button>
                )}
                {canEdit && renaming !== n.id && (
                  <MenuButton
                    className="icon-btn xs"
                    label={`${label} options`}
                    items={[
                      { label: t('app.rename'), onSelect: () => setRenaming(n.id) },
                      ...(n.type === 'codeFile' && RUNNABLE.test(label) ? [{ label: 'Set as entry file', onSelect: () => store.getState().commit({ kind: 'update', id: ws.id, set: { entry: label } }, `Entry file ${label}`) }] : []),
                      { separator: true, label: '' },
                      { label: t('app.delete'), danger: true, onSelect: () => store.getState().commit({ kind: 'delete', id: n.id }, `Delete ${label}`) },
                    ]}
                  >
                    <MoreHorizontal />
                  </MenuButton>
                )}
              </li>
            );
          })}
          {creating && (
            <li style={{ padding: '4px 8px' }}>
              <input
                className="input sm"
                autoFocus
                aria-label={creating === 'file' ? t('code.filePath') : 'Notebook name'}
                placeholder={creating === 'file' ? 'analysis.py' : 'Exploration'}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setCreating(null);
                }}
                onBlur={(e) => {
                  create(creating, e.target.value);
                  setCreating(null);
                }}
              />
            </li>
          )}
        </ul>
        {items.length === 0 && !creating && <p className="muted" style={{ padding: 12, fontSize: 'var(--fs-sm)' }}>No files yet.</p>}
      </aside>

      <div className="code-main">
        <div className="code-tabs" role="group" aria-label="Open files">
          {tabs.map((id) => {
            const n = state.nodes[id];
            if (!n) return null;
            const label = n.type === 'codeFile' ? (n as SceneNode<'codeFile'>).props.path : (n as SceneNode<'notebook'>).props.name;
            return (
              <div key={id} className="row" style={{ gap: 0 }}>
                <button className="doc-tab" aria-current={active === id ? 'true' : undefined} onClick={() => setActive(id)}>
                  {n.type === 'codeFile' ? <FileCode /> : <BookOpen />}
                  {label}
                </button>
                <button className="icon-btn xs" aria-label={`Close ${label}`} onClick={() => close(id)}>
                  <X />
                </button>
              </div>
            );
          })}
          <span className="spacer" />
          {activeNode?.type === 'codeFile' && RUNNABLE.test((activeNode as SceneNode<'codeFile'>).props.path) && (
            <button className="btn btn-sm btn-primary" onClick={() => void runFile()} disabled={running || !canEdit} title={`${t('code.run')} (Ctrl+Enter)`}>
              {running ? <Spinner /> : <Play />} {t('code.run')}
            </button>
          )}
        </div>
        <div className={`code-pane${commentMode ? ' commenting' : ''}`} ref={paneRef} style={{ position: 'relative' }}>
          {activeNode?.type === 'codeFile' && (
            <CodeMirror
              key={activeNode.id}
              marks={marks}
              commentMode={commentMode && canEdit}
              onLineComment={openLinePop}
              onCursorLine={reportLine}
              reveal={reveal}
              onRevealed={(line, rect) => {
                const want = pendingPop.current;
                pendingPop.current = null;
                if (want && want.fileId === activeNode.id) setLinePop({ fileId: want.fileId, line, commentId: want.commentId, top: popTop(rect) });
              }}
              value={(activeNode as SceneNode<'codeFile'>).props.content}
              language={languageForPath((activeNode as SceneNode<'codeFile'>).props.path)}
              readOnly={!canEdit}
              label={`${(activeNode as SceneNode<'codeFile'>).props.path} source`}
              onChange={(v) => text.edit(activeNode.id, 'content', v, `Edit ${(activeNode as SceneNode<'codeFile'>).props.path}`)}
              onRun={() => void runFile()}
            />
          )}
          {activeNode?.type === 'notebook' && <NotebookView key={activeNode.id} ctx={ctx} notebookId={activeNode.id} />}
          {linePop && linePop.fileId === activeNode?.id && (
            <div className="code-comment-pop" style={{ top: linePop.top }} role="dialog" aria-label={t('comments.atLine', { name: (activeNode as SceneNode<'codeFile'>).props.path, line: linePop.line })}>
              {fileComments
                .filter((c) => (linePop.commentId ? c.props.anchor.line === fileComments.find((x) => x.id === linePop.commentId)?.props.anchor.line : c.props.anchor.line === linePop.line))
                .map((c) => (
                  <CommentThread key={c.id} store={store} comment={c} />
                ))}
              {!linePop.commentId && (
                <NewComment
                  quote={`${t('comments.atLine', { name: (activeNode as SceneNode<'codeFile'>).props.path, line: linePop.line })}`}
                  onSubmit={(body) => {
                    const id = addComment(store, { tool: 'code', nodeId: activeNode!.id, line: linePop.line }, body);
                    setLinePop(id ? { ...linePop, commentId: id } : null);
                  }}
                  onCancel={() => setLinePop(null)}
                />
              )}
              {linePop.commentId && (
                <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-end' }} onClick={() => setLinePop(null)}>
                  {t('app.close')}
                </button>
              )}
            </div>
          )}
          {!activeNode && (
            <div className="empty" style={{ height: '100%' }}>
              <p>Open a file or notebook, or create one.</p>
            </div>
          )}
        </div>
      </div>

      <aside className="code-side" aria-label="Terminal and history">
        <div className="segmented" role="tablist" style={{ margin: 8 }}>
          <button role="tab" aria-selected={side === 'terminal'} onClick={() => setSide('terminal')}>
            <TerminalIcon size={14} /> {t('code.terminal')}
          </button>
          <button role="tab" aria-selected={side === 'history'} onClick={() => setSide('history')}>
            <GitCommitHorizontal size={14} /> History
          </button>
          <button role="tab" aria-selected={side === 'sandbox'} onClick={() => setSide('sandbox')}>
            <Shield size={14} /> {t('code.sandbox')}
          </button>
        </div>
        {side === 'terminal' && <Terminal ctx={ctx} lines={lines} setLines={setLines} />}
        {side === 'history' && <GitHistory ctx={ctx} />}
        {side === 'sandbox' && <SandboxSettings ctx={ctx} />}
      </aside>
    </div>
  );
}
