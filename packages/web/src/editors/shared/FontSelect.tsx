import { t } from '../../i18n/index.js';

export const FONT_FAMILIES = ['Inter', 'Georgia', 'Times New Roman', 'Arial', 'Helvetica', 'Courier New', 'Verdana', 'Trebuchet MS', 'system-ui', 'serif', 'sans-serif', 'monospace'];

export function FontSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const fams = FONT_FAMILIES.includes(value) ? FONT_FAMILIES : [value, ...FONT_FAMILIES];
  return (
    <select className="select sm" style={{ width: 150 }} value={value} onChange={(e) => onChange(e.target.value)} aria-label={t('image.font')}>
      {fams.map((f) => (
        <option key={f} value={f} style={{ fontFamily: f }}>
          {f}
        </option>
      ))}
    </select>
  );
}
