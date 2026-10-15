import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useStore } from 'zustand';
import { ArrowLeft, Check, LoaderCircle, Undo2, Redo2, History, Sparkles, NotebookPen, Download, Settings2, Plus, Activity as ActivityIcon, Eye, X, Bookmark, Wand2, Bot, MessageSquare, MessageSquarePlus } from 'lucide-react';
import { primaryDocumentNodes, childrenOf, type SceneNode, type ToolKind } from '@omnix/core';
import { createProjectStore, ProjectContext, useProject, type ProjectStore } from '../state/project.js';
import { BrowserRenderHost } from '../render/browserHost.js';
import { RenderHostContext } from '../render/context.js';
import { useShortcuts, formatShortcut } from '../ui/shortcuts.js';
import { useCommands, useCommandStore } from '../state/commands.js';
import { useDialogs } from '../state/dialogs.js';
import { IconButton, MenuButton, Avatar, Spinner, Dialog, Switch } from '../ui/primitives.js';
import { ToolIcon, TOOL_COLORS } from '../ui/icons.js';
import { useGlobalCommands, useConnectionStatus } from '../shell/Shell.js';
import { ProposalsPanel } from '../components/ProposalsPanel.js';
import { HistoryPanel } from '../components/HistoryPanel.js';
import { NotesPanel } from '../components/NotesPanel.js';
import { ActivityFeed } from '../components/ActivityFeed.js';
import { ExportDialog } from '../components/ExportDialog.js';
import { CommandBar } from '../components/CommandBar.js';
import { AgentRunsPanel, AgentStartDialog, useAgentRuns } from '../components/AgentRuns.js';
import { StyleDialog } from '../components/StyleDialog.js';
import { FindDialog } from '../components/FindDialog.js';
import { CommentsPanel } from '../components/CommentsPanel.js';
import { CompareVersions } from '../components/CompareVersions.js';
import { DocumentBatchDialog } from '../components/BatchDialog.js';
import { PluginsPanel } from '../components/Plugins.js';
import { allComments } from '../components/CommentPins.js';
import { GenerativeDialog } from '../components/GenerativeDialog.js';
import { toast } from '../ui/toast.js';
import { plural, t } from '../i18n/index.js';
import { post } from '../lib/api.js';

const ImageEditor = lazy(() => import('../editors/image/ImageEditor.js').then((m) => ({ default: m.ImageEditor })));
const TimelineEditor = lazy(() => import('../editors/video/TimelineEditor.js').then((m) => ({ default: m.TimelineEditor })));
const CodeEditor = lazy(() => import('../editors/code/CodeEditor.js').then((m) => ({ default: m.CodeEditor })));
const DocumentEditor = lazy(() => import('../editors/document/DocumentEditor.js').then((m) => ({ default: m.DocumentEditor })));
const SlidesEditor = lazy(() => import('../editors/slides/SlidesEditor.js').then((m) => ({ default: m.SlidesEditor })));

type Panel = 'proposals' | 'history' | 'notes' | 'activity' | 'runs' | 'comments' | 'plugins' | null;

export function toolOfDoc(n: SceneNode): ToolKind | null {
  switch (n.type) {
    case 'canvas':
      return 'image';
    case 'sequence':
      return (n as SceneNode<'sequence'>).props.purpose === 'animation' ? 'animation' : 'video';
    case 'codeWorkspace':
      return 'code';
    case 'document':
      return 'document';
    case 'deck':
      return 'slides';
    default:
      return null;
  }
}

function docName(n: SceneNode): string {
  return ((n.props as { name?: string }).name ?? n.type) || t('app.untitled');
}

export function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [store, setStore] = useState<ProjectStore | null>(null);
  const [host, setHost] = useState<BrowserRenderHost | null>(null);
  useEffect(() => {
    const s = createProjectStore(projectId!);
    const h = new BrowserRenderHost();
    setStore(s);
    setHost(h);
    void s.getState().load();
    return () => {
      s.getState().dispose();
      h.dispose();
    };
  }, [projectId]);
  if (!store || !host) return null;
  return (
    <ProjectContext.Provider value={store}>
      <RenderHostContext.Provider value={host}>
        <ProjectView store={store} />
      </RenderHostContext.Provider>
    </ProjectContext.Provider>
  );
}

function ProjectView({ store }: { store: ProjectStore }) {
  const status = useStore(store, (s) => s.status);
  const error = useStore(store, (s) => s.error);
  const meta = useStore(store, (s) => s.meta);
  const state = useStore(store, (s) => s.state);
  const activeDocId = useStore(store, (s) => s.activeDocId);
  // Edits not yet confirmed by the server, including typing and drags not yet committed.
  const pending = useStore(store, (s) => s.pending.length + Object.keys(s.transient).length);
  const navigate = useNavigate();
  const proposals = useStore(store, (s) => s.proposals);
  const presence = useStore(store, (s) => s.presence);
  const preview = useStore(store, (s) => s.preview);
  const commentMode = useStore(store, (s) => s.commentMode);
  const focusRequest = useStore(store, (s) => s.focusRequest);
  const [params, setParams] = useSearchParams();
  const [panel, setPanel] = useState<Panel>(() => (params.get('panel') as Panel) ?? (params.get('proposal') ? 'proposals' : params.get('commit') ? 'history' : params.get('run') ? 'runs' : params.get('comment') ? 'comments' : null));
  const dialogs = useDialogs();
  const runs = useAgentRuns(store.getState().projectId);
  const waitingRuns = runs?.filter((r) => r.status === 'awaiting_approval').length ?? 0;
  const activeRuns = runs?.filter((r) => r.status === 'running' || r.status === 'queued').length ?? 0;
  // Project dialogs belong to this project: close them when leaving it.
  useEffect(() => () => useDialogs.setState({ command: null, style: null, agent: null, find: false, generative: null, compare: null }), []);
  const review = (proposalId: string) => {
    dialogs.close('command');
    params.set('proposal', proposalId);
    setParams(params, { replace: true });
    setPanel('proposals');
  };
  const [exportOpen, setExportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const conn = useConnectionStatus();
  useGlobalCommands();

  const api = store.getState();
  useShortcuts(
    {
      'mod+z': () => void api.undo(),
      'mod+shift+z': () => void api.redo(),
      'mod+y': () => void api.redo(),
      'mod+s': () => {
        const name = new Date().toLocaleString();
        void api.snapshot(name).then(() => toast.success(`${t('project.snapshot')}: ${name}`));
      },
      'mod+shift+k': () => dialogs.openCommand(),
      'mod+shift+f': () => dialogs.openFind(true),
      'mod+alt+m': () => {
        if (store.getState().canEdit()) api.setCommentMode(!store.getState().commentMode);
      },
      esc: () => {
        if (!store.getState().commentMode) return false;
        api.setCommentMode(false);
      },
    },
    [api],
    { allowInInputs: ['mod+s'] },
  );
  // Typing a request in the command palette runs it as a command here.
  useEffect(() => {
    if (meta?.role === 'viewer') return;
    useCommandStore.getState().setFreeText({ label: (text) => t('commands.paletteAsk', { text }), run: (text) => dialogs.openCommand(text, true) });
    return () => useCommandStore.getState().setFreeText(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.role]);
  useCommands(
    'project',
    [
      { id: 'undo', label: t('project.undo'), section: t('palette.actions'), shortcut: 'mod+z', run: () => void api.undo() },
      { id: 'redo', label: t('project.redo'), section: t('palette.actions'), shortcut: 'mod+shift+z', run: () => void api.redo() },
      { id: 'history', label: t('project.history'), section: t('palette.actions'), run: () => setPanel('history') },
      { id: 'proposals', label: t('project.proposals'), section: t('palette.actions'), run: () => setPanel('proposals') },
      { id: 'notes', label: t('project.notes'), section: t('palette.actions'), run: () => setPanel('notes') },
      { id: 'comments', label: t('comments.title'), section: t('palette.actions'), run: () => setPanel('comments') },
      { id: 'comment-mode', label: t('comments.mode'), section: t('palette.actions'), shortcut: 'mod+alt+m', keywords: 'pin annotate review feedback', run: () => api.setCommentMode(!store.getState().commentMode) },
      { id: 'export', label: t('project.export'), section: t('palette.actions'), run: () => setExportOpen(true) },
      { id: 'command', label: `${t('commands.title')}…`, section: t('palette.ai'), shortcut: 'mod+shift+k', keywords: 'ask natural language', run: () => dialogs.openCommand() },
      { id: 'agent', label: `${t('agent.start')}…`, section: t('palette.ai'), keywords: 'autonomous goal claude', run: () => dialogs.openAgent() },
      { id: 'runs', label: t('agent.runs'), section: t('palette.ai'), run: () => setPanel('runs') },
      { id: 'style', label: `${t('style.title')}…`, section: t('palette.ai'), keywords: 'reference look grade theme', run: () => dialogs.openStyle(null) },
      { id: 'plugins', label: t('plugins.title'), section: t('palette.actions'), keywords: 'plugin extension third-party tools mcp', run: () => setPanel('plugins') },
      { id: 'batch', label: t('batch.open'), section: t('palette.actions'), keywords: 'batch many all documents bulk export command', run: () => setBatchOpen(true) },
      { id: 'compare', label: t('versions.open'), section: t('palette.actions'), keywords: 'diff versions snapshot history before after', run: () => dialogs.openCompare({ documentId: store.getState().activeDocId }) },
      { id: 'find', label: t('find.title'), section: t('palette.actions'), shortcut: 'mod+shift+f', keywords: 'search', run: () => dialogs.openFind(true) },
    ],
    [api],
  );

  useEffect(() => {
    if (meta) document.title = `${meta.name} · Omnix`;
    return () => {
      document.title = 'Omnix';
    };
  }, [meta?.name]);

  // Open a document requested via ?doc=
  useEffect(() => {
    const d = params.get('doc');
    if (d && state?.nodes[d] && activeDocId !== d) api.setActiveDoc(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, state]);

  const docs = useMemo(() => (state ? childrenOf(state, state.rootId).filter((n) => toolOfDoc(n)) : []), [state]);

  if (status === 'loading') {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
        <Spinner />
      </div>
    );
  }
  if (status === 'notFound' || status === 'error') {
    return (
      <div className="page">
        <div className="empty card">
          <p>{status === 'notFound' ? (error ?? t('project.notFound')) : error}</p>
          <Link to="/" className="btn">
            {t('nav.home')}
          </Link>
        </div>
      </div>
    );
  }
  if (!state || !meta) return null;

  const active = activeDocId ? state.nodes[activeDocId] : undefined;
  const tool = active ? toolOfDoc(active) : null;

  const addDocument = (kind: ToolKind) => {
    const name = `${t(`tools.${kind}`)} ${docs.filter((d) => toolOfDoc(d) === kind).length + 1}`;
    const nodes = primaryDocumentNodes(kind, name);
    nodes[0]!.parentId = state.rootId;
    const id = api.commit({ kind: 'create', parentId: state.rootId, nodes }, `Add ${t(`tools.${kind}`).toLowerCase()}`);
    if (id) api.setActiveDoc(nodes[0]!.id);
  };

  const others = Object.values(presence);
  const openComments = allComments(state).filter((c) => !c.props.resolved).length;
  return (
    <div className="workspace">
      <header className="workbar">
        <IconButton label={t('nav.home')} onClick={() => navigate('/')}>
          <ArrowLeft />
        </IconButton>
        <h1 className="sr-only">{meta.name}</h1>
        <ProjectTitle name={meta.name} editable={meta.role !== 'viewer'} onRename={(name) => void api.updateMeta({ name })} />
        <nav className="doc-tabs" aria-label={t('project.documents')}>
          <div className="doc-tabs-list" role="tablist" aria-label={t('project.documents')}>
          {docs.map((d) => {
            const k = toolOfDoc(d)!;
            return (
              <button key={d.id} role="tab" className="doc-tab" aria-selected={d.id === activeDocId} onClick={() => api.setActiveDoc(d.id)} title={docName(d)}>
                <ToolIcon tool={k} style={{ color: TOOL_COLORS[k], flex: 'none' }} />
                <span className="truncate">{docName(d)}</span>
              </button>
            );
          })}
          </div>
          {meta.role !== 'viewer' && (
            <MenuButton
              label={t('project.addDocument')}
              items={[
                { label: t('project.addDocument'), heading: true },
                ...(['image', 'video', 'animation', 'code', 'document', 'slides'] as ToolKind[]).map((k) => ({ label: t(`tools.${k}Long`), icon: <ToolIcon tool={k} />, onSelect: () => addDocument(k) })),
              ]}
            >
              <Plus />
            </MenuButton>
          )}
        </nav>
        <div className="spacer" />
        {conn !== 'open' && <span className="conn-dot">{t('app.offline')}</span>}
        <span className="save-status muted" role="status" aria-live="polite" title={meta.role === 'viewer' ? t('project.readOnly') : pending ? t('project.saving') : t('project.saved')}>
          {meta.role === 'viewer' ? <Eye aria-hidden="true" /> : pending ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
          <span className="label-wide">{meta.role === 'viewer' ? t('project.readOnly') : pending ? t('project.saving') : t('project.saved')}</span>
        </span>
        {others.length > 0 && (
          <div className="presence" aria-label="People here">
            {others.slice(0, 5).map((p) => (
              <Avatar key={p.clientId} name={p.author.name} color={p.color} ai={p.author.type === 'ai'} />
            ))}
          </div>
        )}
        {!meta.aiConsent && (
          <button className="badge" onClick={() => setSettingsOpen(true)} style={{ border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }} title={t('claude.aiOff')}>
            {t('claude.aiOffShort')}
          </button>
        )}
        <IconButton label={t('project.undo')} shortcut={formatShortcut('mod+z')} onClick={() => void api.undo()} disabled={meta.role === 'viewer'}>
          <Undo2 />
        </IconButton>
        <IconButton label={t('project.redo')} shortcut={formatShortcut('mod+shift+z')} onClick={() => void api.redo()} disabled={meta.role === 'viewer'}>
          <Redo2 />
        </IconButton>
        {meta.role !== 'viewer' && (
          <button className="btn btn-sm btn-ghost command-trigger" onClick={() => dialogs.openCommand()} title={`${t('commands.title')} (${formatShortcut('mod+shift+k')})`}>
            <Wand2 /> <span className="hide-narrow">{t('commands.open')}</span>
          </button>
        )}
        <button className={`btn btn-sm ${proposals.length ? 'btn-ai' : 'btn-ghost'}`} onClick={() => setPanel(panel === 'proposals' ? null : 'proposals')} aria-pressed={panel === 'proposals'} aria-label={`${t('project.proposals')} (${proposals.length})`}>
          <Sparkles />
          {proposals.length > 0 && <span className="tabular">{proposals.length}</span>}
        </button>
        <button className={`btn btn-sm ${waitingRuns ? 'btn-ai' : 'btn-ghost'}`} onClick={() => setPanel(panel === 'runs' ? null : 'runs')} aria-pressed={panel === 'runs'} aria-label={`${t('agent.runs')}${waitingRuns ? ` (${t('agent.waiting', { n: waitingRuns })})` : activeRuns ? ` (${t('agent.active', { n: activeRuns })})` : ''}`}>
          <Bot />
          {(waitingRuns > 0 || activeRuns > 0) && <span className="tabular">{waitingRuns || activeRuns}</span>}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => setPanel(panel === 'comments' ? null : 'comments')} aria-pressed={panel === 'comments'} aria-label={`${t('comments.title')} (${plural('comments.count', openComments)})`} title={t('comments.title')}>
          <MessageSquare />
          {openComments > 0 && <span className="tabular">{openComments}</span>}
        </button>
        <IconButton label={t('project.history')} pressed={panel === 'history'} onClick={() => setPanel(panel === 'history' ? null : 'history')}>
          <History />
        </IconButton>
        <IconButton label={t('project.notes')} pressed={panel === 'notes'} onClick={() => setPanel(panel === 'notes' ? null : 'notes')}>
          <NotebookPen />
        </IconButton>
        <IconButton label={t('activity.title')} pressed={panel === 'activity'} onClick={() => setPanel(panel === 'activity' ? null : 'activity')}>
          <ActivityIcon />
        </IconButton>
        <IconButton label={t('project.export')} onClick={() => setExportOpen(true)}>
          <Download />
        </IconButton>
        <IconButton label={t('project.settings')} onClick={() => setSettingsOpen(true)}>
          <Settings2 />
        </IconButton>
      </header>
      <div className="workarea">
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
          {commentMode && (
            <div className="commenting-banner" role="status">
              <MessageSquarePlus size={16} aria-hidden="true" />
              <span className="grow">{t('comments.modeHint')}</span>
              <button className="btn btn-sm" onClick={() => api.setCommentMode(false)}>
                <X /> {t('app.done')}
              </button>
            </div>
          )}
          {preview && (
            <div className="preview-banner" role="status">
              <Eye size={16} aria-hidden="true" />
              <span className="grow">Previewing a proposed change. Nothing is applied until you accept it.</span>
              <button className="btn btn-sm" onClick={() => void api.previewProposal(null)}>
                <X /> {t('proposals.stopPreview')}
              </button>
              <button className="btn btn-sm btn-ai" onClick={() => void api.acceptProposal(preview.proposalId).then(() => toast.success(t('proposals.accepted')), (e) => toast.error(e.message))}>
                {t('proposals.accept')}
              </button>
            </div>
          )}
          <main id="main" style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            {active && <h2 className="sr-only">{docName(active)}</h2>}
            <Suspense fallback={<div style={{ display: 'grid', placeItems: 'center', height: '100%' }}><Spinner /></div>}>
              {active && tool === 'image' && <ImageEditor key={active.id} canvasId={active.id} />}
              {active && (tool === 'video' || tool === 'animation') && <TimelineEditor key={active.id} sequenceId={active.id} />}
              {active && tool === 'code' && <CodeEditor key={active.id} workspaceId={active.id} />}
              {active && tool === 'document' && <DocumentEditor key={active.id} documentId={active.id} />}
              {active && tool === 'slides' && <SlidesEditor key={active.id} deckId={active.id} />}
              {!active && (
                <div className="empty" style={{ height: '100%' }}>
                  <p>This project is empty. Add a document to get started.</p>
                  <div className="row">
                    {(['image', 'video', 'document', 'slides'] as ToolKind[]).map((k) => (
                      <button key={k} className="btn" onClick={() => addDocument(k)}>
                        <ToolIcon tool={k} /> {t(`tools.${k}`)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </Suspense>
          </main>
        </div>
        {panel && (
          <aside className="drawer" aria-label={panel}>
            <div className="panel-header">
              <span className="grow">
                {panel === 'proposals' ? t('proposals.title') : panel === 'history' ? t('history.title') : panel === 'notes' ? t('notes.title') : panel === 'runs' ? t('agent.runs') : panel === 'comments' ? t('comments.title') : panel === 'plugins' ? t('plugins.title') : t('activity.title')}
              </span>
              <IconButton
                small
                label={t('app.close')}
                onClick={() => {
                  setPanel(null);
                  if (params.get('panel')) {
                    params.delete('panel');
                    setParams(params);
                  }
                }}
              >
                <X />
              </IconButton>
            </div>
            <div className="drawer-body">
              {panel === 'proposals' && <ProposalsPanel focusId={params.get('proposal')} />}
              {panel === 'history' && <HistoryPanel focusCommit={params.get('commit')} />}
              {panel === 'notes' && <NotesPanel />}
              {panel === 'comments' && <CommentsPanel focusId={params.get('comment')} />}
              {panel === 'plugins' && <PluginsPanel />}
              {panel === 'activity' && <ActivityFeed projectId={meta.id} showProject={false} filter limit={100} />}
              {panel === 'runs' && <AgentRunsPanel projectId={meta.id} projectName={meta.name} focusId={params.get('run')} onStart={() => dialogs.openAgent()} />}
            </div>
          </aside>
        )}
      </div>
      {exportOpen && active && <ExportDialog node={active} onClose={() => setExportOpen(false)} />}
      {dialogs.command && <CommandBar key={dialogs.command.text} initialText={dialogs.command.text} autoRun={dialogs.command.autoRun} onClose={() => dialogs.close('command')} onReview={review} />}
      {dialogs.style && <StyleDialog targetId={dialogs.style.targetId} onClose={() => dialogs.close('style')} />}
      {dialogs.agent && (
        <AgentStartDialog
          projectId={meta.id}
          projectName={meta.name}
          initialGoal={dialogs.agent.goal}
          onClose={() => dialogs.close('agent')}
          onStarted={(id) => {
            params.set('run', id);
            setParams(params, { replace: true });
            setPanel('runs');
          }}
        />
      )}
      {dialogs.find && <FindDialog onClose={() => dialogs.openFind(false)} />}
      {dialogs.compare && <CompareVersions {...(dialogs.compare.from ? { from: dialogs.compare.from } : {})} {...(dialogs.compare.to ? { to: dialogs.compare.to } : {})} documentId={dialogs.compare.documentId ?? activeDocId} onClose={() => dialogs.close('compare')} />}
      {dialogs.generative && <GenerativeDialog mode={dialogs.generative.mode} canvasId={dialogs.generative.canvasId} {...(dialogs.generative.replaceLayerId ? { replaceLayerId: dialogs.generative.replaceLayerId } : {})} {...(dialogs.generative.prompt !== undefined ? { initialPrompt: dialogs.generative.prompt } : {})} onClose={() => dialogs.close('generative')} />}
      {settingsOpen && <ProjectSettingsDialog onClose={() => setSettingsOpen(false)} />}
      {batchOpen && <DocumentBatchDialog projectId={meta.id} docs={docs.map((d) => ({ id: d.id, name: docName(d), type: d.type }))} initial={docs.filter((d) => active && d.type === active.type).map((d) => d.id)} onClose={() => setBatchOpen(false)} />}
    </div>
  );
}

function ProjectTitle({ name, editable, onRename }: { name: string; editable: boolean; onRename: (n: string) => void }) {
  const [value, setValue] = useState(name);
  const cancelled = useRef(false);
  useEffect(() => setValue(name), [name]);
  if (!editable) return <span style={{ fontWeight: 650, padding: '0 8px' }}>{name}</span>;
  return (
    <input
      className="title-input"
      value={value}
      size={Math.max(6, Math.min(32, value.length + 1))}
      aria-label={t('project.rename')}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (cancelled.current) {
          cancelled.current = false;
          setValue(name);
        } else if (value.trim() && value.trim() !== name) onRename(value.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          // Escape cancels the rename; the blur that follows must not save it.
          cancelled.current = true;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function ProjectSettingsDialog({ onClose }: { onClose: () => void }) {
  const store = useProject((s) => s);
  const meta = store.meta!;
  const [templateName, setTemplateName] = useState(meta.name);
  return (
    <Dialog title={t('project.settings')} onClose={onClose}>
      <div className="col" style={{ gap: 20 }}>
        <Switch
          checked={meta.aiConsent}
          disabled={meta.role !== 'owner'}
          onChange={(v) => void store.updateMeta({ aiConsent: v }).catch((e) => toast.error(e.message))}
          label={t('claude.aiAllowed')}
          hint={t('claude.aiAllowedHint')}
        />
        <hr className="divider" />
        <div className="col">
          <span className="label">
            <Bookmark size={14} style={{ verticalAlign: '-2px' }} /> Save as template
          </span>
          <div className="row">
            <input className="input" value={templateName} onChange={(e) => setTemplateName(e.target.value)} aria-label="Template name" />
            <button
              className="btn"
              onClick={() =>
                void post('/api/templates', { projectId: meta.id, name: templateName }).then(
                  () => toast.success('Saved as a template'),
                  (e) => toast.error(e.message),
                )
              }
            >
              {t('app.save')}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

