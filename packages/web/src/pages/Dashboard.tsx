import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LayoutTemplate, MoreHorizontal, Archive, Trash2, Pencil, ArchiveRestore, Upload, FolderOpen } from 'lucide-react';
import { TOOL_KINDS, type ToolKind } from '@omnix/core';
import { del, get, patch, uploadFile, thumbUrl, type AssetSummary } from '../lib/api.js';
import { createProject, thumbnailUrl, type ProjectListItem } from '../lib/projects.js';
import { useAuth } from '../state/auth.js';
import { realtime } from '../state/realtime.js';
import { ToolIcon, TOOL_COLORS } from '../ui/icons.js';
import { ConfirmDialog, Dialog, MenuButton, Spinner, Switch } from '../ui/primitives.js';
import { toast } from '../ui/toast.js';
import { ActivityFeed } from '../components/ActivityFeed.js';
import { ClaudeStatusCard } from '../components/ClaudeStatus.js';
import { formatRelative, plural, t } from '../i18n/index.js';

function useProjects(includeArchived: boolean) {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const load = useCallback(() => {
    get<{ projects: ProjectListItem[] }>(`/api/projects${includeArchived ? '?archived=true' : ''}`)
      .then((r) => setProjects(r.projects))
      .catch((e) => toast.error(e.message));
  }, [includeArchived]);
  useEffect(() => {
    load();
    let timer: number | null = null;
    const debounced = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(load, 800);
    };
    const offs = [realtime.on('meta', debounced), realtime.on('deleted', debounced), realtime.on('activity', debounced)];
    return () => offs.forEach((o) => o());
  }, [load]);
  return { projects, reload: load };
}

function isDark(): boolean {
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme === 'dark' || theme === 'high-contrast') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function ProjectCard({ p, onChanged }: { p: ProjectListItem; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(p.name);
  const label = t(`tools.${p.primaryTool}`);
  return (
    <article className="project-card">
      <Link to={`/projects/${p.id}`} className="cover" aria-label={`${p.name}, ${label}`}>
        <img src={thumbnailUrl(p, isDark() ? 'dark' : 'light')} alt="" loading="lazy" decoding="async" />
      </Link>
      <span className="tool-chip" aria-hidden="true">
        <ToolIcon tool={p.primaryTool} style={{ color: TOOL_COLORS[p.primaryTool] }} />
        {label}
      </span>
      <div className="meta">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="name truncate">{p.name}</div>
          <div className="sub">
            {formatRelative(p.updatedAt)}
            {p.archived ? ' · Archived' : ''}
          </div>
        </div>
        <MenuButton
          label={`${t('app.more')}: ${p.name}`}
          items={[
            { label: t('app.rename'), icon: <Pencil />, onSelect: () => setRenaming(true) },
            {
              label: p.archived ? t('project.unarchive') : t('project.archive'),
              icon: p.archived ? <ArchiveRestore /> : <Archive />,
              disabled: p.role !== 'owner',
              onSelect: () => void patch(`/api/projects/${p.id}`, { archived: !p.archived }).then(onChanged, (e) => toast.error(e.message)),
            },
            { separator: true, label: '' },
            { label: t('project.delete'), icon: <Trash2 />, danger: true, disabled: p.role !== 'owner', onSelect: () => setConfirmDelete(true) },
          ]}
        >
          <MoreHorizontal />
        </MenuButton>
      </div>
      {renaming && (
        <Dialog
          title={t('project.rename')}
          onClose={() => setRenaming(false)}
          footer={
            <>
              <button className="btn" onClick={() => setRenaming(false)}>
                {t('app.cancel')}
              </button>
              <button
                className="btn btn-primary"
                onClick={() =>
                  void patch(`/api/projects/${p.id}`, { name }).then(
                    () => {
                      setRenaming(false);
                      onChanged();
                    },
                    (e) => toast.error(e.message),
                  )
                }
              >
                {t('app.save')}
              </button>
            </>
          }
        >
          <input className="input" data-autofocus value={name} onChange={(e) => setName(e.target.value)} aria-label={t('project.rename')} />
        </Dialog>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={t('project.delete')}
          message={t('project.deleteConfirm', { name: p.name })}
          confirmLabel={t('app.delete')}
          danger
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await del(`/api/projects/${p.id}`);
            onChanged();
          }}
        />
      )}
    </article>
  );
}

interface TemplateInfo {
  id: string;
  name: string;
  tool: ToolKind;
  description: string;
  builtIn: boolean;
}

function TemplatesDialog({ onClose }: { onClose: () => void }) {
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    get<{ templates: TemplateInfo[] }>('/api/templates').then((r) => setTemplates(r.templates), (e) => toast.error(e.message));
  }, []);
  return (
    <Dialog title={t('dashboard.fromTemplate')} onClose={onClose} wide>
      {!templates && <Spinner />}
      <div className="project-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
        {templates?.map((tpl) => (
          <button
            key={tpl.id}
            className="project-card"
            style={{ textAlign: 'left', cursor: 'pointer', padding: 0 }}
            disabled={!!busy}
            onClick={async () => {
              setBusy(tpl.id);
              try {
                const p = await createProject(tpl.tool, { name: tpl.name, templateId: tpl.id });
                onClose();
                navigate(`/projects/${p.id}`);
              } catch (e) {
                toast.error((e as Error).message);
                setBusy(null);
              }
            }}
          >
            <span className="cover" style={{ display: 'block', aspectRatio: '16 / 10', background: 'var(--surface-2)' }}>
              <img src={`/api/templates/${tpl.id}/thumbnail`} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </span>
            <span className="tool-chip" aria-hidden="true">
              <ToolIcon tool={tpl.tool} style={{ color: TOOL_COLORS[tpl.tool] }} />
              {t(`tools.${tpl.tool}`)}
            </span>
            <span className="meta" style={{ display: 'block' }}>
              <span className="name" style={{ display: 'block' }}>
                {tpl.name} {busy === tpl.id && <Spinner />}
              </span>
              <span className="sub" style={{ display: 'block' }}>
                {tpl.description}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

function AssetStrip() {
  const [assets, setAssets] = useState<AssetSummary[] | null>(null);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const load = useCallback(() => {
    get<{ assets: AssetSummary[] }>('/api/assets?limit=12').then((r) => setAssets(r.assets), () => setAssets([]));
  }, []);
  useEffect(load, [load]);
  const upload = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      try {
        const r = await uploadFile(f);
        toast.success(r.deduplicated ? t('assets.duplicate', { name: f.name }) : t('assets.uploaded', { name: f.name }));
      } catch (e) {
        toast.error((e as Error).message);
      }
    }
    load();
  };
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void upload(e.dataTransfer.files);
      }}
    >
      {assets && assets.length === 0 ? (
        <div className={`dropzone${over ? ' over' : ''}`}>
          <p>{t('dashboard.noAssets')}</p>
          <button className="btn btn-sm" style={{ marginTop: 12 }} onClick={() => fileRef.current?.click()}>
            <Upload /> {t('assets.upload')}
          </button>
        </div>
      ) : (
        <div className={`asset-strip${over ? ' dropzone over' : ''}`} aria-label={t('dashboard.assets')}>
          {!assets && [0, 1, 2, 3].map((i) => <div key={i} className="asset-thumb skeleton" />)}
          {assets?.map((a) => (
            <Link key={a.id} to={`/assets?focus=${a.id}`} className="asset-thumb" style={{ backgroundImage: a.hasThumbnail ? `url(${thumbUrl(a.id)})` : undefined }} title={a.name} aria-label={a.name}>
              <span className="badge kind">{t(`assets.kinds.${a.kind}`)}</span>
            </Link>
          ))}
          <button className="asset-thumb" style={{ display: 'grid', placeItems: 'center', cursor: 'pointer' }} onClick={() => fileRef.current?.click()} aria-label={t('assets.upload')}>
            <Upload size={18} className="muted" />
          </button>
        </div>
      )}
      <input ref={fileRef} type="file" multiple hidden onChange={(e) => e.target.files && void upload(e.target.files)} />
    </div>
  );
}

export function Dashboard() {
  const user = useAuth((s) => s.user)!;
  const navigate = useNavigate();
  const [showArchived, setShowArchived] = useState(false);
  const { projects, reload } = useProjects(showArchived);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [creating, setCreating] = useState<ToolKind | null>(null);

  useEffect(() => {
    // Show the Claude setup guide on first launch.
    if (!user.setup.dismissed && user.setup.completed.length <= 1 && sessionStorage.getItem('omnix.setupShown') !== '1') {
      sessionStorage.setItem('omnix.setupShown', '1');
      navigate('/setup');
    }
  }, [user, navigate]);

  const create = async (tool: ToolKind) => {
    setCreating(tool);
    try {
      const p = await createProject(tool);
      navigate(`/projects/${p.id}`);
    } catch (e) {
      toast.error((e as Error).message);
      setCreating(null);
    }
  };

  const firstName = user.name.split(' ')[0] ?? user.name;
  return (
    <div className="page">
      <header className="page-header">
        <div className="grow">
          <h1>{t('dashboard.greeting', { name: firstName })}</h1>
          <p className="subtitle">{t('dashboard.subtitle')}</p>
        </div>
      </header>
      <div className="dash">
        <div>
          <section className="dash-section" aria-labelledby="create-title">
            <div className="dash-section-head">
              <h2 id="create-title">{t('dashboard.create')}</h2>
            </div>
            <div className="create-row">
              {TOOL_KINDS.map((tool) => (
                <button key={tool} className="create-tile" onClick={() => void create(tool)} disabled={!!creating}>
                  <span className="tile-icon" style={{ background: TOOL_COLORS[tool] }} aria-hidden="true">
                    {creating === tool ? <Spinner /> : <ToolIcon tool={tool} />}
                  </span>
                  <strong>{t(`tools.${tool}Long`)}</strong>
                  <span>{t(`tools.${tool}Hint`)}</span>
                </button>
              ))}
              <button className="create-tile template" onClick={() => setTemplatesOpen(true)}>
                <span className="tile-icon" aria-hidden="true">
                  <LayoutTemplate />
                </span>
                <strong>{t('dashboard.fromTemplate')}</strong>
                <span>Reports, decks, teasers and more</span>
              </button>
            </div>
          </section>

          <section className="dash-section" aria-labelledby="recent-title">
            <div className="dash-section-head">
              <h2 id="recent-title">{t('dashboard.recent')}</h2>
              {projects && <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>{plural('dashboard.projectCount', projects.length)}</span>}
              <Switch checked={showArchived} onChange={setShowArchived} label={t('dashboard.showArchived')} />
            </div>
            {!projects && (
              <div className="project-grid">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="skeleton" style={{ aspectRatio: '16 / 13' }} />
                ))}
              </div>
            )}
            {projects && projects.length === 0 && (
              <div className="empty card">
                <FolderOpen />
                <p>{t('dashboard.noProjects')}</p>
              </div>
            )}
            {projects && projects.length > 0 && (
              <div className="project-grid">
                {projects.map((p) => (
                  <ProjectCard key={p.id} p={p} onChanged={reload} />
                ))}
              </div>
            )}
          </section>

          <section className="dash-section" aria-labelledby="assets-title">
            <div className="dash-section-head">
              <h2 id="assets-title">{t('dashboard.assets')}</h2>
              <Link to="/assets" className="btn btn-ghost btn-sm">
                {t('dashboard.viewLibrary')}
              </Link>
            </div>
            <AssetStrip />
          </section>
        </div>

        <aside className="side-panel" aria-label="Status">
          <ClaudeStatusCard />
          <section aria-labelledby="activity-title">
            <div className="dash-section-head">
              <h2 id="activity-title">{t('dashboard.activity')}</h2>
              <Link to="/activity" className="btn btn-ghost btn-sm">
                {t('dashboard.viewAll')}
              </Link>
            </div>
            <ActivityFeed limit={12} changesOnly />
          </section>
          <nav className="col" aria-label={t('nav.help')} style={{ fontSize: 'var(--fs-sm)' }}>
            <Link to="/settings">{t('nav.settings')}</Link>
            <Link to="/settings/appearance">{t('nav.appearance')}</Link>
            <Link to="/setup">{t('nav.setupGuide')}</Link>
            <Link to="/help/troubleshooting">Troubleshooting</Link>
          </nav>
        </aside>
      </div>
      {templatesOpen && <TemplatesDialog onClose={() => setTemplatesOpen(false)} />}
    </div>
  );
}
