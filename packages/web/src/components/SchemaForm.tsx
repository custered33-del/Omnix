import { useEffect, useId, useState, type ReactNode } from 'react';
import { get, type AssetSummary } from '../lib/api.js';
import { t } from '../i18n/index.js';

/**
 * Forms built from JSON Schema: the settings of a batch operation, the arguments of a plugin
 * tool. Every field is labelled, hints are announced as descriptions, and choices come from the
 * schema (enums), the library (…AssetId) or the caller (ids of things in the project).
 */

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: (string | number)[];
  anyOf?: { const?: string | number; type?: string }[];
  const?: string | number;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  description?: string;
  maxLength?: number;
  pattern?: string;
  items?: JsonSchema;
}

/** Human labels for settings; anything else is shown as its name split into words. */
export const PARAM_LABELS: Record<string, string> = {
  lutAssetId: 'LUT',
  referenceAssetId: 'Reference picture',
  maxHeight: 'Largest height',
  keyColor: 'Screen color',
  lufs: 'Loudness target (LUFS)',
  apply: 'Apply right away instead of leaving each change to review',
  enlarge: 'Enlarge smaller pictures',
  text: 'Text',
  canvasId: 'Canvas',
  documentId: 'Document',
  deckId: 'Slideshow',
  sequenceId: 'Video',
  workspaceId: 'Code workspace',
};

export function words(name: string): string {
  return PARAM_LABELS[name] ?? name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

export function defaultsOf(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(schema.properties ?? {})) if (p.default !== undefined) out[k] = p.default;
  return out;
}

/** A labelled form field whose hint is announced as a description, not as part of the name. */
export function Field({ label, hint, children }: { label: string; hint?: string | undefined; children: (a: { id: string; 'aria-describedby'?: string }) => ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children({ id, ...(hint ? { 'aria-describedby': hintId } : {}) })}
      {hint && (
        <span id={hintId} className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
          {hint}
        </span>
      )}
    </div>
  );
}

export function ParamField({ name, schema, required, value, onChange, choices }: { name: string; schema: JsonSchema; required: boolean; value: unknown; onChange: (v: unknown) => void; choices?: { value: string; label: string }[] }) {
  const label = `${words(name)}${required ? '' : ` (${t('batch.optional')})`}`;
  const hint = schema.description && !PARAM_LABELS[name] ? schema.description : undefined;
  const options = schema.enum ?? schema.anyOf?.map((a) => a.const).filter((c): c is string | number => c !== undefined);
  if (name.endsWith('AssetId')) return <AssetField label={label} kind={name === 'lutAssetId' ? 'lut' : 'image'} value={value as string | undefined} onChange={onChange} />;
  // Things in the project (a canvas, a document) the caller can offer by name.
  if (choices) {
    return (
      <Field label={label} hint={hint}>
        {(a) => (
          <select {...a} className="select" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
            <option value="">{t('batch.chooseOne')}</option>
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        )}
      </Field>
    );
  }
  if (schema.type === 'array' && schema.items?.type === 'string') {
    const list = Array.isArray(value) ? (value as string[]) : [];
    if (schema.items.pattern?.startsWith('^#')) {
      // A list of colors: one picker each, plus add and remove.
      return (
        <fieldset className="field" style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend className="label">{label}</legend>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {list.map((c, i) => (
              <span key={i} className="row" style={{ gap: 2 }}>
                <input type="color" aria-label={`${words(name)} ${i + 1}`} value={c} onChange={(e) => onChange(list.map((x, j) => (j === i ? e.target.value : x)))} />
                <button type="button" className="icon-btn xs" aria-label={`${t('app.remove')} ${i + 1}`} onClick={() => onChange(list.filter((_, j) => j !== i))}>
                  ×
                </button>
              </span>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => onChange([...list, '#888888'])}>
              + {t('batch.addColor')}
            </button>
          </div>
        </fieldset>
      );
    }
    return (
      <Field label={label} hint={hint ?? t('batch.commaSeparated')}>
        {(a) => <input {...a} className="input" value={list.join(', ')} onChange={(e) => onChange(e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} />}
      </Field>
    );
  }
  if (options?.length) {
    return (
      <Field label={label} hint={hint}>
        {(a) => (
          <select {...a} className="select" value={value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : typeof options[0] === 'number' ? Number(e.target.value) : e.target.value)}>
            {!required && <option value="">{t('batch.same')}</option>}
            {options.map((o) => (
              <option key={String(o)} value={String(o)}>
                {String(o)}
              </option>
            ))}
          </select>
        )}
      </Field>
    );
  }
  if (schema.type === 'boolean') {
    return (
      <label className="row" style={{ gap: 8, fontSize: 'var(--fs-sm)' }}>
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        {words(name)}
      </label>
    );
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    return (
      <Field label={label} hint={hint}>
        {(a) => (
          <input
            {...a}
            className="input"
            type="number"
            min={schema.minimum}
            max={schema.maximum}
            step={schema.type === 'integer' ? 1 : (schema.maximum ?? 100) - (schema.minimum ?? 0) <= 4 ? 0.05 : 1}
            value={value === undefined ? '' : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          />
        )}
      </Field>
    );
  }
  if (schema.type === 'string' && schema.pattern?.startsWith('^#')) {
    return <Field label={label}>{(a) => <input {...a} type="color" value={(value as string) ?? '#ffffff'} onChange={(e) => onChange(e.target.value)} />}</Field>;
  }
  return <Field label={label} hint={hint}>{(a) => (name === 'text' ? <textarea {...a} className="input" rows={2} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} /> : <input {...a} className="input" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || undefined)} />)}</Field>;
}

/** Pick a library file (a LUT or a reference picture) for a setting. */
function AssetField({ label, kind, value, onChange }: { label: string; kind: string; value: string | undefined; onChange: (v: string | undefined) => void }) {
  const [list, setList] = useState<AssetSummary[] | null>(null);
  useEffect(() => {
    get<{ assets: AssetSummary[] }>(`/api/assets?kind=${kind}&limit=200`).then((r) => setList(r.assets), () => setList([]));
  }, [kind]);
  return (
    <Field label={label}>
      {(f) => (
        <select {...f} className="select" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">{list === null ? '…' : list.length ? t('batch.chooseFile') : t('batch.noFiles', { kind })}</option>
          {list?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

