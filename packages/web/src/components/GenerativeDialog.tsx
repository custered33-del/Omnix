import { useEffect, useState } from 'react';
import { Sparkles, Expand } from 'lucide-react';
import type { SceneNode } from '@omnix/core';
import { useProject, useProjectStore } from '../state/project.js';
import { post } from '../lib/api.js';
import { Dialog, NumberField, Select, Spinner } from '../ui/primitives.js';
import { toast } from '../ui/toast.js';
import { t } from '../i18n/index.js';
import { aiCapabilities, type AiCapabilities } from './CommandBar.js';

const RATIOS: { id: string; label: string; w: number; h: number }[] = [
  { id: '16:9', label: '16:9 (wide)', w: 16, h: 9 },
  { id: '9:16', label: '9:16 (story)', w: 9, h: 16 },
  { id: '1:1', label: '1:1 (square)', w: 1, h: 1 },
  { id: '4:5', label: '4:5 (portrait post)', w: 4, h: 5 },
  { id: '3:1', label: '3:1 (banner)', w: 3, h: 1 },
];

/** Margins that grow a canvas to an aspect ratio, keeping the picture centred. */
export function marginsForRatio(width: number, height: number, w: number, h: number): { top: number; right: number; bottom: number; left: number } {
  const target = w / h;
  if (width / height < target) {
    const extra = Math.round(height * target) - width;
    return { top: 0, bottom: 0, left: Math.floor(extra / 2), right: Math.ceil(extra / 2) };
  }
  const extra = Math.round(width / target) - height;
  return { left: 0, right: 0, top: Math.floor(extra / 2), bottom: Math.ceil(extra / 2) };
}

/**
 * Generative fill (an area from a prompt) and extend (outpainting) for the image editor. The result
 * is a new layer masked to the generated area, so the person sees exactly what was made.
 */
export function GenerativeDialog({ mode, canvasId, replaceLayerId, initialPrompt, onClose }: { mode: 'fill' | 'extend'; canvasId: string; replaceLayerId?: string; initialPrompt?: string; onClose: () => void }) {
  const store = useProjectStore();
  const canvas = useProject((s) => s.state?.nodes[canvasId]) as SceneNode<'canvas'> | undefined;
  const aiConsent = useProject((s) => !!s.meta?.aiConsent);
  const [caps, setCaps] = useState<AiCapabilities | null>(null);
  const [provider, setProvider] = useState<string>('builtin');
  const [prompt, setPrompt] = useState(initialPrompt ?? '');
  const [ratio, setRatio] = useState<string>('custom');
  const [margins, setMargins] = useState({ top: 0, right: 0, bottom: 0, left: 0 });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void aiCapabilities().then((c) => {
      setCaps(c);
      const outside = c.imageProviders.find((p) => p.generative);
      setProvider(outside && aiConsent ? outside.id : 'builtin');
    }, () => {});
  }, [aiConsent]);
  if (!canvas) return null;
  const cp = canvas.props;
  const chosen = caps?.imageProviders.find((p) => p.id === provider);
  const needsConsent = !!chosen && chosen.id !== 'builtin' && !aiConsent;
  const run = async () => {
    setBusy(true);
    const projectId = store.getState().projectId;
    try {
      if (mode === 'fill') {
        const r = await post<{ layerId: string }>(`/api/projects/${projectId}/generative/fill`, { canvasId, prompt, provider, ...(replaceLayerId ? { replaceLayerId } : {}) });
        store.getState().select([r.layerId]);
      } else {
        const r = await post<{ width: number; height: number }>(`/api/projects/${projectId}/generative/extend`, { canvasId, prompt, provider, ...margins });
        toast.success(t('generative.extended', { w: r.width, h: r.height }));
      }
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const total = margins.top + margins.right + margins.bottom + margins.left;
  return (
    <Dialog
      title={mode === 'fill' ? t('generative.fillTitle') : t('generative.extendTitle')}
      description={mode === 'fill' ? t('generative.fillHint') : t('generative.extendHint')}
      icon={mode === 'fill' ? <Sparkles /> : <Expand />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('app.cancel')}
          </button>
          <button className="btn btn-ai" disabled={busy || needsConsent || (mode === 'fill' && !cp.selection && !replaceLayerId) || (mode === 'extend' && !total)} onClick={() => void run()}>
            {busy ? <Spinner /> : <Sparkles />} {t('generative.generate')}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <div className="col">
          <label className="label" htmlFor="gen-prompt">
            {t('generative.prompt')}
          </label>
          <input id="gen-prompt" className="input" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={mode === 'fill' ? t('generative.fillPlaceholder') : t('generative.extendPlaceholder')} autoFocus onKeyDown={(e) => e.key === 'Enter' && !busy && void run()} />
        </div>
        {caps && caps.imageProviders.length > 1 && <Select label={t('generative.provider')} value={provider} options={caps.imageProviders.map((p) => ({ value: p.id, label: p.label }))} onChange={setProvider} />}
        {chosen && !chosen.generative && <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>{t('generative.builtinNote')}</p>}
        {needsConsent && <p className="danger-ink" style={{ fontSize: 'var(--fs-sm)' }}>{t('generative.needsConsent')}</p>}
        {mode === 'fill' && !cp.selection && !replaceLayerId && <p className="danger-ink" style={{ fontSize: 'var(--fs-sm)' }}>{t('generative.selectFirst')}</p>}
        {mode === 'extend' && (
          <>
            <Select
              label={t('generative.shape')}
              value={ratio}
              options={[{ value: 'custom', label: t('generative.customMargins') }, ...RATIOS.map((r) => ({ value: r.id, label: r.label }))]}
              onChange={(v) => {
                setRatio(v);
                const r = RATIOS.find((x) => x.id === v);
                if (r) setMargins(marginsForRatio(cp.width, cp.height, r.w, r.h));
              }}
            />
            <div className="grid-2">
              {(['top', 'right', 'bottom', 'left'] as const).map((k) => (
                <NumberField
                  key={k}
                  label={t(`generative.${k}`)}
                  value={margins[k]}
                  min={0}
                  max={4096}
                  unit="px"
                  slider={false}
                  onCommit={(v) => {
                    setRatio('custom');
                    setMargins({ ...margins, [k]: Math.round(v) });
                  }}
                />
              ))}
            </div>
            <p className="muted tabular" style={{ fontSize: 'var(--fs-sm)' }}>
              {cp.width}×{cp.height} → {cp.width + margins.left + margins.right}×{cp.height + margins.top + margins.bottom}
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}
