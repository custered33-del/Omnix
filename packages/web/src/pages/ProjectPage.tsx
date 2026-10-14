import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useStore } from 'zustand';
import { ArrowLeft, Undo2, Redo2, History, Sparkles, NotebookPen, Download, Settings2, Plus, Activity as ActivityIcon, Eye, X, Bookmark } from 'lucide-react';
import { primaryDocumentNodes, childrenOf, type SceneNode, type ToolKind } from '@omnix/core';
import { createProjectStore, ProjectContext, useProject, type ProjectStore } from '../state/project.js';
import { BrowserRenderHost } from '../render/browserHost.js';
import { RenderHostContext } from '../render/context.js';
import { useShortcuts, formatShortcut } from '../ui/shortcuts.js';
import { useCommands } from '../state/commands.js';
import { IconButton, MenuButton, Avatar, Spinner, Dialog, Switch } from '../ui/primitives.js';
import { ToolIcon, TOOL_COLORS } from '../ui/icons.js';
import { useGlobalCommands, useConnectionStatus } from '../shell/Shell.js';
import { ProposalsPanel } from '../components/ProposalsPanel.js';
import { HistoryPanel } from '../components/HistoryPanel.js';
import { NotesPanel } from '../components/NotesPanel.js';
import { ActivityFeed } from '../components/ActivityFeed.js';
import { ExportDialog } from '../components/ExportDialog.js';
import { toast } from '../ui/toast.js';
import { t } from '../i18n/index.js';
import { post } from '../lib/api.js';

const ImageEditor = lazy(() => import('../editors/image/ImageEditor.js').then((m) => ({ default: m.ImageEditor })));
const TimelineEditor = lazy(() => import('../editors/video/TimelineEditor.js').then((m) => ({ default: m.TimelineEditor })));
const CodeEditor = lazy(() => import('../editors/code/CodeEditor.js').then((m) => ({ default: m.CodeEditor })));
const DocumentEditor = lazy(() => import('../editors/document/DocumentEditor.js').then((m) => ({ default: m.DocumentEditor })));
const SlidesEditor = lazy(() => import('../editors/slides/SlidesEditor.js').then((m) => ({ default: m.SlidesEditor })));

type Panel = 'proposals' | 'history' | 'notes' | 'activity' | null;

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
  const pending = useStore(store, (s) => s.pending.length);
  const proposals = useStore(store, (s) => s.proposals);
  const presence = useStore(store, (s) => s.presence);
  const preview = useStore(store, (s) => s.preview);
  const [params, setParams] = useSearchParams();
  const [panel, setPanel] = useState<Panel>(() => (params.get('panel') as Panel) ?? (params.get('proposal') ? 'proposals' : params.get('commit') ? 'history' : null));
  const [exportOpen, setExportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
    },
    [api],
    { allowInInputs: ['mod+s'] },
  );
  useCommands(
    'project',
    [
      { id: 'undo', label: t('project.undo'), section: t('palette.actions'), shortcut: 'mod+z', run: () => void api.undo() },
      { id: 'redo', label: t('project.redo'), section: t('palette.actions'), shortcut: 'mod+shift+z', run: () => void api.redo() },
      { id: 'history', label: t('project.history'), section: t('palette.actions'), run: () => setPanel('history') },
      { id: 'proposals', label: t('project.proposals'), section: t('palette.actions'), run: () => setPanel('proposals') },
      { id: 'notes', label: t('project.notes'), section: t('palette.actions'), run: () => setPanel('notes') },
      { id: 'export', label: t('project.export'), section: t('palette.actions'), run: () => setExportOpen(true) },
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
          <p>{status === 'notFound' ? t('project.notFound') : error}</p>
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
  return (
    <div className="workspace">
      <header className="workbar">
        <IconButton label={t('nav.home')} onClick={() => (window.location.href = '/')}>
          <ArrowLeft />
        </IconButton>
        <ProjectTitle name={meta.name} editable={meta.role !== 'viewer'} onRename={(name) => void api.updateMeta({ name })} />
        <nav className="doc-tabs" role="tablist" aria-label={t('project.documents')}>
          {docs.map((d) => {
            const k = toolOfDoc(d)!;
            return (
              <button key={d.id} role="tab" className="doc-tab" aria-selected={d.id === activeDocId} onClick={() => api.setActiveDoc(d.id)}>
                <ToolIcon tool={k} style={{ color: TOOL_COLORS[k] }} />
                {docName(d)}
              </button>
            );
          })}
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
        <span className="muted" style={{ fontSize: 'var(--fs-sm)' }} role="status" aria-live="polite">
          {meta.role === 'viewer' ? t('project.readOnly') : pending ? t('project.saving') : t('project.saved')}
        </span>
        {others.length > 0 && (
          <div className="presence" aria-label="People here">
            {others.slice(0, 5).map((p) => (
              <Avatar key={p.clientId} name={p.author.name} color={p.color} ai={p.author.type === 'ai'} />
            ))}
          </div>
        )}
        {!meta.aiConsent && (
          <button className="badge" onClick={() => setSettingsOpen(true)} style={{ border: 'none', cursor: 'pointer' }}>
            {t('claude.aiOff')}
          </button>
        )}
        <IconButton label={t('project.undo')} shortcut={formatShortcut('mod+z')} onClick={() => void api.undo()} disabled={meta.role === 'viewer'}>
          <Undo2 />
        </IconButton>
        <IconButton label={t('project.redo')} shortcut={formatShortcut('mod+shift+z')} onClick={() => void api.redo()} disabled={meta.role === 'viewer'}>
          <Redo2 />
        </IconButton>
        <button className={`btn btn-sm ${proposals.length ? 'btn-ai' : 'btn-ghost'}`} onClick={() => setPanel(panel === 'proposals' ? null : 'proposals')} aria-pressed={panel === 'proposals'} aria-label={`${t('project.proposals')} (${proposals.length})`}>
          <Sparkles />
          {proposals.length > 0 && <span className="tabular">{proposals.length}</span>}
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
                {panel === 'proposals' ? t('proposals.title') : panel === 'history' ? t('history.title') : panel === 'notes' ? t('notes.title') : t('activity.title')}
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
              {panel === 'activity' && <ActivityFeed projectId={meta.id} showProject={false} filter limit={100} />}
            </div>
          </aside>
        )}
      </div>
      {exportOpen && active && <ExportDialog node={active} onClose={() => setExportOpen(false)} />}
      {settingsOpen && <ProjectSettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function ProjectTitle({ name, editable, onRename }: { name: string; editable: boolean; onRename: (n: string) => void }) {
  const [value, setValue] = useState(name);
  useEffect(() => setValue(name), [name]);
  if (!editable) return <span style={{ fontWeight: 650, padding: '0 8px' }}>{name}</span>;
  return (
    <input
      className="title-input"
      value={value}
      aria-label={t('project.rename')}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => value.trim() && value !== name && onRename(value.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setValue(name);
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

