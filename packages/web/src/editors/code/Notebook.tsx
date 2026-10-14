import { useState } from 'react';
import { Play, Plus, Trash2, ArrowUp, ArrowDown, Type, Code2, RotateCcw, ListRestart, Eraser, FileText, Presentation } from 'lucide-react';
import type { CellOutput, SceneNode } from '@omnix/core';
import { childrenOf, makeNode } from '@omnix/core';
import { useProject } from '../../state/project.js';
import { IconButton, Spinner } from '../../ui/primitives.js';
import { Markdown } from '../../components/Markdown.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../i18n/index.js';
import { CodeMirror } from './CodeMirror.js';
import { Outputs } from './Outputs.js';
import { restartKernel, runTarget, type CodeCtx, type RunResult } from './codeApi.js';

export function NotebookView({ ctx, notebookId }: { ctx: CodeCtx; notebookId: string }) {
  const state = useProject((s) => s.state)!;
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  const streams = useProject((s) => s.codeStreams);
  const nb = state.nodes[notebookId] as SceneNode<'notebook'> | undefined;
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [editingMd, setEditingMd] = useState<string | null>(null);
  if (!nb) return null;
  const cells = childrenOf(state, nb.id).filter((c): c is SceneNode<'cell'> => c.type === 'cell');
  const s = ctx.store.getState();

  const addCell = (after: number, cellType: 'code' | 'markdown' = 'code') => {
    const node = makeNode('cell', { cellType, language: nb.props.language, source: '' });
    if (s.commit({ kind: 'create', parentId: nb.id, index: after + 1, nodes: [node] }, cellType === 'code' ? t('code.addCell') : t('code.addMarkdown'))) {
      setActive(node.id);
      if (cellType === 'markdown') setEditingMd(node.id);
    }
    return node.id;
  };

  const runCell = async (cell: SceneNode<'cell'>, advance: boolean) => {
    if (cell.props.cellType === 'markdown') {
      setEditingMd(null);
    } else {
      setRunning((r) => new Set(r).add(cell.id));
      try {
        const r = (await runTarget(ctx, { cellId: cell.id })) as RunResult;
        s.dropCodeStream(r.runId);
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setRunning((r) => {
          const n = new Set(r);
          n.delete(cell.id);
          return n;
        });
      }
    }
    if (advance) {
      const i = cells.findIndex((c) => c.id === cell.id);
      const next = cells[i + 1];
      if (next) setActive(next.id);
      else addCell(i);
    }
  };

  const runAll = async () => {
    setRunning(new Set(cells.filter((c) => c.props.cellType === 'code').map((c) => c.id)));
    try {
      const r = (await runTarget(ctx, { notebookId: nb.id })) as { results: RunResult[] };
      for (const x of r.results) s.dropCodeStream(x.runId);
      if (r.results.some((x) => !x.ok)) toast.error('Stopped at a cell with an error');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRunning(new Set());
    }
  };

  const move = (cell: SceneNode<'cell'>, d: -1 | 1) => {
    const i = cells.findIndex((c) => c.id === cell.id);
    const j = i + d;
    if (j < 0 || j >= cells.length) return;
    s.commit({ kind: 'move', id: cell.id, parentId: nb.id, index: j }, 'Move cell');
  };

  /** Live text for a running cell, from the streamed output. */
  const liveFor = (cellId: string): CellOutput[] => {
    const st = Object.values(streams).filter((x) => x.cellId === cellId);
    const last = st[st.length - 1];
    if (!last) return [];
    return [...(last.text ? [{ kind: 'stdout' as const, text: last.text }] : []), ...(last.stderr ? [{ kind: 'stderr' as const, text: last.stderr }] : [])];
  };

  const copyEmbed = (cell: SceneNode<'cell'>, where: 'doc' | 'slides') => {
    void navigator.clipboard?.writeText(`!embed[cell-output](${cell.id})`);
    toast.success(where === 'doc' ? 'Copied. Paste it into a document to show this output live.' : 'Copied. Paste it into a slide to show this output live.');
  };

  return (
    <div className="notebook" role="region" aria-label={nb.props.name}>
      <div className="row" style={{ gap: 8 }}>
        <h2 style={{ fontSize: 'var(--fs-lg)', flex: 1 }}>{nb.props.name}</h2>
        <select className="select sm" style={{ width: 130 }} value={nb.props.language} disabled={!canEdit} aria-label="Notebook language" onChange={(e) => s.commit({ kind: 'update', id: nb.id, set: { language: e.target.value } }, 'Change notebook language')}>
          <option value="python">Python</option>
          <option value="javascript">JavaScript</option>
          <option value="typescript">TypeScript</option>
        </select>
        <button className="btn btn-sm btn-primary" onClick={() => void runAll()} disabled={!canEdit || running.size > 0}>
          {running.size > 0 ? <Spinner /> : <ListRestart />} {t('code.runAll')}
        </button>
        <IconButton small label={t('code.restart')} onClick={() => void restartKernel(ctx).then(() => toast.info('Kernel restarted. Variables were cleared.'))} disabled={!canEdit}>
          <RotateCcw />
        </IconButton>
        <IconButton small label="Clear all outputs" disabled={!canEdit} onClick={() => s.commit({ kind: 'batch', ops: cells.filter((c) => c.props.outputs.length).map((c) => ({ kind: 'update' as const, id: c.id, set: { outputs: [] } })) }, 'Clear outputs')}>
          <Eraser />
        </IconButton>
      </div>
      {cells.map((cell, i) => {
        const p = cell.props;
        const isRunning = running.has(cell.id);
        const outputs = isRunning ? liveFor(cell.id) : p.outputs;
        const md = p.cellType === 'markdown';
        return (
          <div key={cell.id} className={`cell${active === cell.id ? ' active' : ''}`} onFocusCapture={() => setActive(cell.id)}>
            <div className="cell-gutter">
              {md ? (
                <Type size={14} aria-label="Text cell" />
              ) : (
                <>
                  <button className="icon-btn sm" aria-label={`${t('code.run')} cell ${i + 1}`} title={`${t('code.run')} (Shift+Enter)`} onClick={() => void runCell(cell, false)} disabled={!canEdit || isRunning}>
                    {isRunning ? <Spinner /> : <Play />}
                  </button>
                  <span aria-label={p.executionCount ? `Run ${p.executionCount} times` : 'Not run yet'}>[{isRunning ? '*' : p.executionCount || ' '}]</span>
                </>
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              {md && editingMd !== cell.id ? (
                <div className="cell-markdown" onDoubleClick={() => canEdit && setEditingMd(cell.id)} role="button" tabIndex={0} aria-label="Text cell. Press Enter to edit." onKeyDown={(e) => e.key === 'Enter' && canEdit && setEditingMd(cell.id)}>
                  {p.source.trim() ? <Markdown source={p.source} /> : <span className="muted">Double-click to write text</span>}
                </div>
              ) : (
                <div className="cell-source">
                  <CodeMirror
                    compact
                    value={p.source}
                    language={md ? 'markdown' : p.language}
                    readOnly={!canEdit}
                    autoFocus={active === cell.id && (md || !p.source)}
                    label={`Cell ${i + 1} source`}
                    placeholder={md ? 'Write notes in markdown…' : p.language === 'python' ? 'print("hello")' : 'console.log("hello")'}
                    onChange={(v) => ctx.text.edit(cell.id, 'source', v, 'Edit cell')}
                    onRun={() => void runCell(cell, false)}
                    onRunAndAdvance={() => void runCell(cell, true)}
                  />
                </div>
              )}
              <Outputs outputs={outputs} />
              {active === cell.id && canEdit && (
                <div className="row" style={{ gap: 2, marginTop: 4 }}>
                  <IconButton small label="Add code cell below" onClick={() => addCell(i)}>
                    <Plus />
                  </IconButton>
                  <IconButton small label="Add text cell below" onClick={() => addCell(i, 'markdown')}>
                    <Type />
                  </IconButton>
                  <IconButton small label={md ? 'Make code cell' : 'Make text cell'} onClick={() => s.commit({ kind: 'update', id: cell.id, set: { cellType: md ? 'code' : 'markdown', outputs: [] } }, 'Change cell type')}>
                    {md ? <Code2 /> : <FileText />}
                  </IconButton>
                  <IconButton small label="Move up" onClick={() => move(cell, -1)} disabled={i === 0}>
                    <ArrowUp />
                  </IconButton>
                  <IconButton small label="Move down" onClick={() => move(cell, 1)} disabled={i === cells.length - 1}>
                    <ArrowDown />
                  </IconButton>
                  <IconButton small label={t('app.delete')} onClick={() => s.commit({ kind: 'delete', id: cell.id }, 'Delete cell')}>
                    <Trash2 />
                  </IconButton>
                  {p.outputs.length > 0 && (
                    <>
                      <span className="spacer" />
                      <button className="btn btn-sm btn-ghost" onClick={() => copyEmbed(cell, 'doc')} title="Copy a live reference to this output">
                        <FileText /> {t('code.placeInDoc')}
                      </button>
                      <button className="btn btn-sm btn-ghost" onClick={() => copyEmbed(cell, 'slides')} title="Copy a live reference to this output">
                        <Presentation /> {t('code.placeInSlides')}
                      </button>
                    </>
                  )}
                  {p.lastRunMs !== null && !md && <span className="muted" style={{ fontSize: 'var(--fs-xs)', marginLeft: 8 }}>{p.lastRunMs} ms</span>}
                </div>
              )}
            </div>
          </div>
        );
      })}
      {canEdit && (
        <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
          <button className="btn btn-sm" onClick={() => addCell(cells.length - 1)}>
            <Plus /> {t('code.addCell')}
          </button>
          <button className="btn btn-sm" onClick={() => addCell(cells.length - 1, 'markdown')}>
            <Type /> {t('code.addMarkdown')}
          </button>
        </div>
      )}
    </div>
  );
}
