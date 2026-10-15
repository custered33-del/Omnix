import { useMemo, useState } from 'react';
import { Palette, ImageIcon, FolderOpen } from 'lucide-react';
import { childrenOf, type SceneNode } from '@omnix/core';
import { useProject, useProjectStore } from '../state/project.js';
import { post, thumbUrl, type AssetSummary } from '../lib/api.js';
import { Dialog, NumberField, Select, Spinner } from '../ui/primitives.js';
import { toast } from '../ui/toast.js';
import { t } from '../i18n/index.js';
import { AssetPicker } from './AssetPicker.js';

type Aspect = 'color' | 'tone' | 'texture' | 'typography' | 'motion';

const DOC_TYPES = ['canvas', 'sequence', 'deck', 'document'];

function nodeName(n: SceneNode): string {
  const p = n.props as { name?: string; text?: string };
  return p.name || p.text?.slice(0, 40) || n.type;
}

/** Which aspects make sense for a target. */
function aspectsFor(type: string | undefined, purpose?: string): Aspect[] {
  switch (type) {
    case 'canvas':
    case 'layer':
      return ['color', 'tone', 'texture', 'typography'];
    case 'clip':
      return ['color', 'tone', 'texture', 'motion'];
    case 'sequence':
      return purpose === 'animation' ? ['motion'] : ['color', 'tone', 'motion'];
    case 'animLayer':
      return ['motion'];
    case 'deck':
    case 'slide':
      return ['color', 'typography', 'motion'];
    case 'document':
      return ['color', 'typography'];
    default:
      return ['color', 'tone'];
  }
}

/**
 * Style reference: apply the color, tone, texture, typography or motion feel of a reference (a picture
 * or clip from the library, or another document in this project) to what you are working on.
 */
export function StyleDialog({ targetId: initialTarget, onClose }: { targetId: string | null; onClose: () => void }) {
  const store = useProjectStore();
  const state = useProject((s) => s.state)!;
  const activeDocId = useProject((s) => s.activeDocId);
  const selection = useProject((s) => s.selection);
  const targets = useMemo(() => {
    const list: { id: string; label: string }[] = [];
    const doc = activeDocId ? state.nodes[activeDocId] : undefined;
    if (doc) list.push({ id: doc.id, label: `${t('style.wholeDoc')}: ${nodeName(doc)}` });
    for (const id of selection) {
      const n = state.nodes[id];
      if (n && ['layer', 'clip', 'animLayer', 'slide'].includes(n.type)) list.push({ id, label: `${t('style.selected')}: ${nodeName(n)}` });
    }
    if (initialTarget && !list.some((x) => x.id === initialTarget) && state.nodes[initialTarget]) list.unshift({ id: initialTarget, label: nodeName(state.nodes[initialTarget]!) });
    return list;
  }, [state, activeDocId, selection, initialTarget]);
  const [targetId, setTargetId] = useState(initialTarget ?? targets[0]?.id ?? '');
  const target = state.nodes[targetId];
  const available = aspectsFor(target?.type, (target?.props as { purpose?: string } | undefined)?.purpose);
  const [aspects, setAspects] = useState<Set<Aspect>>(new Set(available));
  const [source, setSource] = useState<'library' | 'project'>('library');
  const [asset, setAsset] = useState<AssetSummary | null>(null);
  const [picking, setPicking] = useState(false);
  const docs = childrenOf(state, state.rootId).filter((n) => DOC_TYPES.includes(n.type) && n.id !== targetId);
  const [refNode, setRefNode] = useState<string>(docs[0]?.id ?? '');
  const [strength, setStrength] = useState(80);
  const [busy, setBusy] = useState(false);
  const reference = source === 'library' ? (asset ? { assetId: asset.id } : null) : refNode ? { nodeId: refNode } : null;
  const apply = async () => {
    if (!reference || !targetId) return;
    setBusy(true);
    try {
      const r = await post<{ commitId: string | null; applied: string[]; skipped: string[] }>(`/api/projects/${store.getState().projectId}/style-match`, { targetId, reference, aspects: [...aspects].filter((a) => available.includes(a)), strength: strength / 100 });
      if (r.applied.length) toast.success(`${t('style.matched')}: ${r.applied.join(', ')}`);
      else toast.info(r.skipped.join('. ') || t('style.nothing'));
      if (r.applied.length && r.skipped.length) toast.info(r.skipped.join('. '));
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('style.title')}
      description={t('style.hint')}
      icon={<Palette />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('app.cancel')}
          </button>
          <button className="btn btn-ai" disabled={busy || !reference || !targetId || ![...aspects].some((a) => available.includes(a))} onClick={() => void apply()}>
            {busy ? <Spinner /> : <Palette />} {t('style.apply')}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {targets.length > 1 && <Select label={t('style.target')} value={targetId} options={targets.map((x) => ({ value: x.id, label: x.label }))} onChange={setTargetId} />}
        <div className="col">
          <span className="label">{t('style.reference')}</span>
          <div className="segmented" role="group" aria-label={t('style.reference')}>
            <button aria-pressed={source === 'library'} onClick={() => setSource('library')}>
              <ImageIcon size={14} /> {t('style.fromLibrary')}
            </button>
            <button aria-pressed={source === 'project'} onClick={() => setSource('project')} disabled={!docs.length}>
              <FolderOpen size={14} /> {t('style.fromProject')}
            </button>
          </div>
          {source === 'library' && (
            <div className="row">
              {asset && <img src={thumbUrl(asset.id)} alt="" className="style-ref-thumb" />}
              <span className="grow truncate">{asset ? asset.name : t('style.noReference')}</span>
              <button className="btn btn-sm" onClick={() => setPicking(true)}>
                {asset ? t('style.change') : t('style.choose')}
              </button>
            </div>
          )}
          {source === 'project' && docs.length > 0 && <Select label={t('style.document')} hideLabel value={refNode} options={docs.map((d) => ({ value: d.id, label: nodeName(d) }))} onChange={setRefNode} />}
        </div>
        <fieldset className="chip-row" style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>
            {t('style.aspects')}
          </legend>
          {(['color', 'tone', 'texture', 'typography', 'motion'] as Aspect[]).map((a) => (
            <button
              key={a}
              type="button"
              className="chip"
              disabled={!available.includes(a)}
              aria-pressed={aspects.has(a) && available.includes(a)}
              onClick={() => {
                const next = new Set(aspects);
                if (next.has(a)) next.delete(a);
                else next.add(a);
                setAspects(next);
              }}
            >
              {t(`style.aspect.${a}`)}
            </button>
          ))}
        </fieldset>
        <NumberField label={t('style.strength')} value={strength} min={0} max={100} unit="%" onCommit={setStrength} />
      </div>
      {picking && (
        <AssetPicker
          kinds={['image', 'video']}
          title={t('style.choose')}
          projectId={store.getState().projectId}
          onPick={(a) => {
            setAsset(a[0] ?? null);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </Dialog>
  );
}
