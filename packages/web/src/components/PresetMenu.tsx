import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bookmark, BookmarkPlus, Settings2, Sparkles } from 'lucide-react';
import type { PresetKind } from '@omnix/core';
import { get, post } from '../lib/api.js';
import { Dialog, MenuButton, Spinner, type MenuItemDef } from '../ui/primitives.js';
import { useProjectStore } from '../state/project.js';
import { toast } from '../ui/toast.js';
import { plural, t } from '../i18n/index.js';

export interface PresetSummary {
  id: string;
  kind: PresetKind;
  name: string;
  description: string;
  builtIn: boolean;
  appliesTo: string[];
  by?: string;
  shared?: boolean;
  mine?: boolean;
  data: unknown;
}

/** Presets per kind, shared by every menu on the page and refreshed after a save. */
const cache = new Map<PresetKind, Promise<PresetSummary[]>>();
const listeners = new Set<() => void>();
export function loadPresets(kind: PresetKind, fresh = false): Promise<PresetSummary[]> {
  if (fresh || !cache.has(kind)) {
    const p = get<{ presets: PresetSummary[] }>(`/api/presets?kind=${kind}`).then((r) => r.presets);
    p.catch(() => cache.delete(kind));
    cache.set(kind, p);
  }
  return cache.get(kind)!;
}
export function invalidatePresets(): void {
  cache.clear();
  for (const l of listeners) l();
}

/**
 * The Presets menu in an editor: apply a built-in, saved or shared preset to the target, or
 * save the source's current look, rig, styles or theme as a new preset.
 */
export function PresetMenu({ kind, targetId, sourceId, canEdit, skipBuiltIn, className }: { kind: PresetKind; targetId: string; sourceId?: string; canEdit: boolean; skipBuiltIn?: boolean; className?: string }) {
  const store = useProjectStore();
  const navigate = useNavigate();
  const [presets, setPresets] = useState<PresetSummary[] | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => void loadPresets(kind).then((p) => alive && setPresets(p), () => alive && setPresets([]));
    load();
    listeners.add(load);
    return () => {
      alive = false;
      listeners.delete(load);
    };
  }, [kind]);
  const apply = async (p: PresetSummary) => {
    try {
      const r = await post<{ changed: number }>(`/api/projects/${store.getState().projectId}/presets/apply`, { presetId: p.id, targetId });
      toast.success(plural('presets.applied', r.changed, { name: p.name }));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const shown = (presets ?? []).filter((p) => !(skipBuiltIn && p.builtIn));
  const items = (): MenuItemDef[] => [
    { label: t('presets.apply'), heading: true },
    ...(presets === null ? [{ label: t('app.loading'), disabled: true }] : shown.length ? shown.map((p) => ({ label: p.builtIn ? p.name : `${p.name}${p.mine ? '' : ` · ${p.by ?? ''}`}`, icon: p.builtIn ? <Sparkles /> : <Bookmark />, disabled: !canEdit, onSelect: () => void apply(p) })) : [{ label: t('presets.noneYet'), disabled: true }]),
    { separator: true, label: '' },
    ...(sourceId && canEdit ? [{ label: t('presets.saveCurrent'), icon: <BookmarkPlus />, onSelect: () => setSaving(true) }] : []),
    { label: t('presets.manage'), icon: <Settings2 />, onSelect: () => navigate(`/presets?kind=${kind}`) },
  ];
  return (
    <>
      <MenuButton className={className ?? 'btn btn-sm'} label={t(`presets.kinds.${kind}`)} title={t('presets.menuTitle')} items={items}>
        <Bookmark /> {t('presets.menu')}
      </MenuButton>
      {saving && sourceId && <SavePresetDialog kind={kind} nodeId={sourceId} onClose={() => setSaving(false)} />}
    </>
  );
}

/** Name a new preset made from a layer, clip, rig, document or deck. */
export function SavePresetDialog({ kind, nodeId, onClose }: { kind: PresetKind; nodeId: string; onClose: () => void }) {
  const store = useProjectStore();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await post('/api/presets', { name, description, shared, from: { projectId: store.getState().projectId, nodeId } });
      invalidatePresets();
      toast.success(t('presets.saved', { name }));
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('presets.saveTitle', { kind: t(`presets.kinds.${kind}`) })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('app.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={() => void save()}>
            {busy ? <Spinner /> : <BookmarkPlus />} {t('app.save')}
          </button>
        </>
      }
    >
      <form
        className="col"
        style={{ gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void save();
        }}
      >
        <label className="field">
          <span className="label">{t('presets.name')}</span>
          <input className="input" data-autofocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </label>
        <label className="field">
          <span className="label">{t('presets.description')}</span>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
        </label>
        <label className="row" style={{ gap: 8, fontSize: 'var(--fs-sm)' }}>
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          {t('presets.shareWithEveryone')}
        </label>
      </form>
    </Dialog>
  );
}
