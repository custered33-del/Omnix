import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Play, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { childrenOf } from '@omnix/core';
import { del, get, patch, post } from '../lib/api.js';
import { useAuth } from '../state/auth.js';
import { useProject } from '../state/project.js';
import { ConfirmDialog, Dialog, IconButton, Spinner, Switch } from '../ui/primitives.js';
import { toast } from '../ui/toast.js';
import { formatRelative, t } from '../i18n/index.js';
import { defaultsOf, Field, ParamField, type JsonSchema } from './SchemaForm.js';

export interface PluginTool {
  name: string;
  omnixName: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  readOnly: boolean;
}

export interface PluginInfo {
  id: string;
  name: string;
  description: string | null;
  type: 'mcp-http' | 'mcp-stdio' | 'local';
  source: 'folder' | 'settings';
  slug: string;
  enabled: boolean;
  status: 'connected' | 'error' | 'disabled' | 'connecting';
  error: string | null;
  serverInfo: { name: string; version: string } | null;
  checkedAt: string | null;
  tools: PluginTool[];
  url?: string | null;
  command?: string | null;
  folder?: string | null;
}

/** Which documents a tool argument like canvasId or documentId can point at. */
const ID_TYPES: Record<string, string[] | null> = { canvasId: ['canvas'], sequenceId: ['sequence'], deckId: ['deck'], workspaceId: ['codeWorkspace'], documentId: null };

/** The Plugins panel in a project: run a plugin's tool with a form made from its schema. */
export function PluginsPanel() {
  const state = useProject((s) => s.state)!;
  const projectId = useProject((s) => s.projectId);
  const activeDocId = useProject((s) => s.activeDocId);
  const canEdit = useProject((s) => s.meta?.role !== 'viewer');
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [tool, setTool] = useState<{ plugin: PluginInfo; tool: PluginTool } | null>(null);
  useEffect(() => {
    get<{ plugins: PluginInfo[] }>('/api/plugins').then((r) => setPlugins(r.plugins), (e: Error) => toast.error(e.message));
  }, []);
  const docs = useMemo(() => childrenOf(state, state.rootId).filter((n) => ['canvas', 'sequence', 'deck', 'codeWorkspace', 'document'].includes(n.type)), [state]);
  const isOwner = useAuth((s) => s.user?.role === 'owner');
  if (!plugins) return <Spinner />;
  const ready = plugins.filter((p) => p.status === 'connected' && p.tools.length);
  if (tool) return <ToolRunner key={tool.tool.omnixName} plugin={tool.plugin} tool={tool.tool} projectId={projectId} docs={docs.map((d) => ({ id: d.id, type: d.type, name: String((d.props as { name?: string }).name ?? d.type) }))} activeDocId={activeDocId} canEdit={canEdit} onBack={() => setTool(null)} />;
  return (
    <div className="col" style={{ gap: 16 }}>
      <p className="muted" style={{ fontSize: 'var(--fs-sm)', margin: 0 }}>
        {t('plugins.panelHint')}
      </p>
      {ready.length === 0 && (
        <div className="empty" style={{ padding: 16 }}>
          <Plug aria-hidden="true" />
          <p>{t('plugins.none')}</p>
          {isOwner && (
            <Link to="/settings/plugins" className="btn btn-sm">
              {t('plugins.manage')}
            </Link>
          )}
        </div>
      )}
      {ready.map((p) => (
        <section key={p.id} className="col" style={{ gap: 6 }}>
          <h3 className="section-title" style={{ margin: 0 }}>
            {p.name}
          </h3>
          {p.description && (
            <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
              {p.description}
            </p>
          )}
          <ul className="plain-list">
            {p.tools.map((x) => (
              <li key={x.omnixName}>
                <button type="button" className="plugin-tool" onClick={() => setTool({ plugin: p, tool: x })} disabled={!x.readOnly && !canEdit}>
                  <strong>{x.title}</strong>
                  <span className="muted">{x.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ToolRunner({ plugin, tool, projectId, docs, activeDocId, canEdit, onBack }: { plugin: PluginInfo; tool: PluginTool; projectId: string; docs: { id: string; type: string; name: string }[]; activeDocId: string | null; canEdit: boolean; onBack: () => void }) {
  const props = tool.inputSchema.properties ?? {};
  const [args, setArgs] = useState<Record<string, unknown>>(() => {
    const init = defaultsOf(tool.inputSchema);
    // Start on the open document where it fits.
    for (const [name, types] of Object.entries(ID_TYPES)) {
      const active = docs.find((d) => d.id === activeDocId);
      if (name in props && active && (!types || types.includes(active.type))) init[name] = active.id;
    }
    return init;
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; data: Record<string, unknown> | null; images: string[] } | null>(null);
  const required = tool.inputSchema.required ?? [];
  const fields = Object.entries(props).filter(([name]) => name !== 'projectId');
  const missing = required.filter((k) => k !== 'projectId' && (args[k] === undefined || args[k] === '' || (Array.isArray(args[k]) && !(args[k] as unknown[]).length)));
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await post('/api/plugins/run', { tool: tool.omnixName, args: { ...args, ...('projectId' in props ? { projectId } : {}) } }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const assets = (result?.data?.assets as string[] | undefined) ?? [];
  return (
    <div className="col" style={{ gap: 12 }}>
      <button type="button" className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={onBack}>
        <ArrowLeft /> {t('plugins.allTools')}
      </button>
      <div>
        <h3 style={{ margin: 0 }}>{tool.title}</h3>
        <p className="muted" style={{ margin: '4px 0 0', fontSize: 'var(--fs-sm)' }}>
          {tool.description} <span>({plugin.name})</span>
        </p>
      </div>
      <form
        className="col"
        style={{ gap: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!missing.length) void run();
        }}
      >
        {fields.map(([name, schema]) => {
          const types = ID_TYPES[name];
          const choices = name in ID_TYPES ? docs.filter((d) => !types || types.includes(d.type)).map((d) => ({ value: d.id, label: d.name })) : undefined;
          return <ParamField key={name} name={name} schema={schema} required={required.includes(name)} value={args[name]} onChange={(v) => setArgs((a) => ({ ...a, [name]: v }))} {...(choices ? { choices } : {})} />;
        })}
        <button type="submit" className="btn btn-primary" disabled={busy || missing.length > 0 || (!tool.readOnly && !canEdit)} style={{ alignSelf: 'flex-start' }}>
          {busy ? <Spinner /> : <Play />} {t('plugins.run')}
        </button>
      </form>
      {result && (
        <div className="plugin-result" role="status">
          <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{result.text}</p>
          {result.images.map((src, i) => (
            <img key={i} src={src} alt={t('plugins.resultImage', { n: i + 1 })} />
          ))}
          {assets.map((id) => (
            <Link key={id} to={`/assets?focus=${id}`}>
              {t('plugins.openFile')}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** Settings → Plugins: what is installed, add an MCP server by URL, turn plugins on and off. */
export function PluginSettings() {
  const isOwner = useAuth((s) => s.user?.role === 'owner');
  const [data, setData] = useState<{ plugins: PluginInfo[]; folder?: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<PluginInfo | null>(null);
  const load = useCallback(() => {
    get<{ plugins: PluginInfo[]; folder?: string }>('/api/plugins').then(setData, (e: Error) => toast.error(e.message));
  }, []);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <section className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="row">
        <div className="grow">
          <h2 style={{ fontSize: 'var(--fs-lg)' }}>{t('plugins.title')}</h2>
          <p className="text-2" style={{ marginTop: 4, fontSize: 'var(--fs-sm)' }}>
            {t('plugins.settingsHint')}
          </p>
        </div>
        {isOwner && (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <Plus /> {t('plugins.addHttp')}
          </button>
        )}
      </div>
      {isOwner && data?.folder && (
        <p className="muted" style={{ fontSize: 'var(--fs-sm)', margin: 0 }}>
          {t('plugins.folderHint')} <code>{data.folder}</code>
        </p>
      )}
      {!data && <Spinner />}
      {data && data.plugins.length === 0 && <p className="muted">{t('plugins.noneInstalled')}</p>}
      <ul className="plain-list" style={{ gap: 12 }}>
        {data?.plugins.map((p) => (
          <li key={p.id} className="plugin-card">
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <div className="grow" style={{ minWidth: 0 }}>
                <strong>{p.name}</strong>{' '}
                <span className={`badge plugin-status ${p.status}`}>{t(`plugins.status.${p.status}`)}</span>
                <span className="muted" style={{ display: 'block', fontSize: 'var(--fs-sm)' }}>
                  {p.description ?? ''}
                </span>
                <span className="muted" style={{ display: 'block', fontSize: 'var(--fs-xs)' }}>
                  {t(`plugins.types.${p.type}`)}
                  {p.url ? ` · ${p.url}` : ''}
                  {p.command ? ` · ${p.command}` : ''}
                  {p.source === 'folder' ? ` · ${t('plugins.fromFolder')}` : ''}
                  {p.checkedAt ? ` · ${t('plugins.checked', { when: formatRelative(p.checkedAt) })}` : ''}
                </span>
                {p.error && (
                  <span className="error-text" style={{ display: 'block', fontSize: 'var(--fs-sm)' }}>
                    {p.error}
                  </span>
                )}
              </div>
              {isOwner && (
                <div className="row" style={{ gap: 4 }}>
                  <Switch checked={p.enabled} onChange={(v) => void act(() => patch(`/api/plugins/${p.id}`, { enabled: v }))} label={t('plugins.enabled')} />
                  <IconButton small label={t('plugins.reconnect')} onClick={() => void act(() => post(`/api/plugins/${p.id}/refresh`))}>
                    <RefreshCw />
                  </IconButton>
                  {p.source === 'settings' && (
                    <IconButton small label={t('app.remove')} onClick={() => setRemoving(p)}>
                      <Trash2 />
                    </IconButton>
                  )}
                </div>
              )}
            </div>
            {p.tools.length > 0 && (
              <details>
                <summary className="muted" style={{ fontSize: 'var(--fs-sm)', cursor: 'pointer' }}>
                  {t('plugins.toolCount', { count: p.tools.length })}
                </summary>
                <ul className="plain-list" style={{ marginTop: 6 }}>
                  {p.tools.map((x) => (
                    <li key={x.omnixName}>
                      <code>{x.omnixName}</code> {x.readOnly ? '' : <span className="badge">{t('plugins.changesThings')}</span>} <span className="muted">{x.description}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>
      {adding && <AddPluginDialog onClose={() => setAdding(false)} onAdded={load} />}
      {removing && <ConfirmDialog title={t('plugins.removeTitle')} message={t('plugins.removeConfirm', { name: removing.name })} confirmLabel={t('app.remove')} danger onConfirm={() => act(() => del(`/api/plugins/${removing.id}`))} onClose={() => setRemoving(null)} />}
    </section>
  );
}

function AddPluginDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const r = await post<{ plugin: PluginInfo }>('/api/plugins', { name, url, ...(token ? { token } : {}) });
      if (r.plugin.status === 'connected') toast.success(t('plugins.added', { name: r.plugin.name, count: r.plugin.tools.length }));
      else toast.error(t('plugins.addedButFailed', { name: r.plugin.name, error: r.plugin.error ?? '' }));
      onAdded();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('plugins.addHttp')}
      description={t('plugins.addHint')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('app.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!name.trim() || !url.trim() || busy} onClick={() => void add()}>
            {busy ? <Spinner /> : <Plug />} {t('plugins.connect')}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <Field label={t('plugins.name')}>{(a) => <input {...a} className="input" data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Stock photos" />}</Field>
        <Field label={t('plugins.url')}>{(a) => <input {...a} className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://plugins.example.com/mcp" />}</Field>
        <Field label={t('plugins.token')} hint={t('plugins.tokenHint')}>
          {(a) => <input {...a} className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />}
        </Field>
      </div>
    </Dialog>
  );
}
