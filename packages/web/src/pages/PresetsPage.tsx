import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bookmark, Pencil, Share2, Sparkles, Trash2, Users } from 'lucide-react';
import { PRESET_KINDS, type PresetDataMap, type PresetKind } from '@omnix/core';
import { del, get, patch } from '../lib/api.js';
import { ConfirmDialog, IconButton, Spinner } from '../ui/primitives.js';
import { toast } from '../ui/toast.js';
import { plural, t } from '../i18n/index.js';
import { invalidatePresets, type PresetSummary } from '../components/PresetMenu.js';

/** A small picture of what a preset holds: theme colors, a font sample, the effect names, the rig. */
function PresetPreview({ p }: { p: PresetSummary }) {
  switch (p.kind) {
    case 'slide-theme': {
      const th = (p.data as PresetDataMap['slide-theme']).theme;
      return (
        <div className="preset-preview" style={{ background: th.colors.background, color: th.colors.text, fontFamily: th.fonts.heading }} aria-hidden="true">
          <strong>Aa</strong>
          <span style={{ background: th.colors.accent }} className="dot" />
          <span style={{ background: th.colors.accent2 }} className="dot" />
        </div>
      );
    }
    case 'doc-styles': {
      const s = (p.data as PresetDataMap['doc-styles']).styles;
      return (
        <div className="preset-preview doc" aria-hidden="true">
          <span style={{ fontFamily: s.h1?.fontFamily, color: s.h1?.color, fontWeight: s.h1?.fontWeight }}>Heading</span>
          <span style={{ fontFamily: s.body?.fontFamily, color: s.body?.color, fontSize: 12 }}>Body text reads like this.</span>
        </div>
      );
    }
    case 'layer-effects':
    case 'clip-effects': {
      const list = p.kind === 'layer-effects' ? (p.data as PresetDataMap['layer-effects']).filters.map((f) => f.filter) : (p.data as PresetDataMap['clip-effects']).effects.map((e) => e.effect);
      return (
        <div className="preset-preview fx" aria-hidden="true">
          {list.map((x, i) => (
            <span key={i} className="chip">
              {x.replace(/([A-Z])/g, ' $1').toLowerCase()}
            </span>
          ))}
        </div>
      );
    }
    case 'rig': {
      const r = (p.data as PresetDataMap['rig']).rig;
      return (
        <div className="preset-preview fx" aria-hidden="true">
          <span className="chip">{plural('presets.bones', r.bones.length)}</span>
          <span className="chip">{plural('presets.poses', r.poses.length)}</span>
        </div>
      );
    }
  }
}

export function PresetsPage() {
  const [params, setParams] = useSearchParams();
  const kind = (params.get('kind') as PresetKind | null) ?? null;
  const [list, setList] = useState<PresetSummary[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PresetSummary | null>(null);
  const load = useCallback(() => {
    get<{ presets: PresetSummary[] }>(`/api/presets${kind ? `?kind=${kind}` : ''}`).then((r) => setList(r.presets), (e: Error) => toast.error(e.message));
  }, [kind]);
  useEffect(load, [load]);
  const update = async (p: PresetSummary, body: Record<string, unknown>) => {
    try {
      await patch(`/api/presets/${p.id}`, body);
      invalidatePresets();
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const groups = (kind ? [kind] : PRESET_KINDS).map((k) => ({ k, items: (list ?? []).filter((p) => p.kind === k) }));
  return (
    <div className="page">
      <header className="page-header">
        <div className="grow">
          <h1>{t('presets.title')}</h1>
          <p className="subtitle">{t('presets.subtitle')}</p>
        </div>
      </header>
      <div className="chip-row" role="group" aria-label={t('presets.filter')} style={{ marginBottom: 20 }}>
        <button type="button" className="chip" aria-pressed={!kind} onClick={() => setParams({})}>
          {t('assets.filterAll')}
        </button>
        {PRESET_KINDS.map((k) => (
          <button key={k} type="button" className="chip" aria-pressed={kind === k} onClick={() => setParams({ kind: k })}>
            {t(`presets.kinds.${k}`)}
          </button>
        ))}
      </div>
      {!list && <Spinner />}
      {list &&
        groups.map(({ k, items }) => (
          <section key={k} style={{ marginBottom: 28 }}>
            <h2 className="section-title">{t(`presets.kinds.${k}`)}</h2>
            <p className="muted" style={{ fontSize: 'var(--fs-sm)', marginTop: 0 }}>
              {t(`presets.hints.${k}`)}
            </p>
            <ul className="preset-list">
              {items.map((p) => (
                <li key={p.id} className="preset-item">
                  <PresetPreview p={p} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    {renaming === p.id ? (
                      <input
                        className="input sm"
                        autoFocus
                        defaultValue={p.name}
                        aria-label={t('app.rename')}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          if (e.key === 'Escape') setRenaming(null);
                        }}
                        onBlur={(e) => {
                          setRenaming(null);
                          if (e.target.value.trim() && e.target.value !== p.name) void update(p, { name: e.target.value.trim() });
                        }}
                      />
                    ) : (
                      <strong className="truncate" style={{ display: 'block' }}>
                        {p.name}
                      </strong>
                    )}
                    <span className="muted" style={{ display: 'block', fontSize: 'var(--fs-sm)' }}>
                      {p.description}
                    </span>
                    <span className="row" style={{ gap: 6, marginTop: 4, fontSize: 'var(--fs-xs)' }}>
                      {p.builtIn ? (
                        <span className="badge">
                          <Sparkles size={11} aria-hidden="true" /> {t('presets.builtIn')}
                        </span>
                      ) : p.mine ? (
                        <span className="badge">
                          <Bookmark size={11} aria-hidden="true" /> {p.shared ? t('presets.mineShared') : t('presets.mine')}
                        </span>
                      ) : (
                        <span className="badge">
                          <Users size={11} aria-hidden="true" /> {t('presets.sharedBy', { name: p.by ?? '' })}
                        </span>
                      )}
                      <span className="muted">{t('presets.appliesTo', { list: p.appliesTo.map((x) => t(`presets.targets.${x}` as never)).join(', ') })}</span>
                    </span>
                  </div>
                  {p.mine && (
                    <div className="row" style={{ gap: 2 }}>
                      <IconButton small label={t('app.rename')} onClick={() => setRenaming(p.id)}>
                        <Pencil />
                      </IconButton>
                      <IconButton small label={p.shared ? t('presets.unshare') : t('presets.share')} pressed={!!p.shared} onClick={() => void update(p, { shared: !p.shared })}>
                        <Share2 />
                      </IconButton>
                      <IconButton small label={t('app.delete')} onClick={() => setRemoving(p)}>
                        <Trash2 />
                      </IconButton>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      {removing && (
        <ConfirmDialog
          title={t('presets.deleteTitle')}
          message={t('presets.deleteConfirm', { name: removing.name })}
          confirmLabel={t('app.delete')}
          danger
          onConfirm={async () => {
            await del(`/api/presets/${removing.id}`);
            invalidatePresets();
            load();
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
