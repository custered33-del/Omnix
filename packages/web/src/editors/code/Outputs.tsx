import type { CellOutput } from '@omnix/core';
import { assetUrl } from '../../lib/api.js';
import { ChartView } from '../../components/ChartView.js';

/** Render code outputs: text streams, results, errors, images, charts (with table view) and tables. */
export function Outputs({ outputs }: { outputs: readonly CellOutput[] }) {
  if (!outputs.length) return null;
  return (
    <div className="cell-outputs">
      {outputs.map((o, i) => (
        <Output key={i} o={o} />
      ))}
    </div>
  );
}

function Output({ o }: { o: CellOutput }) {
  switch (o.kind) {
    case 'stdout':
    case 'result':
      return <pre className="cell-output-text">{o.text}</pre>;
    case 'stderr':
      return <pre className="cell-output-text err">{o.text}</pre>;
    case 'error':
      return (
        <pre className="cell-output-text err" role="alert">
          <strong>
            {o.name}: {o.message}
          </strong>
          {o.traceback ? `\n${o.traceback}` : ''}
        </pre>
      );
    case 'image':
      return <img className="cell-output-image" src={assetUrl(o.assetId)} alt="Code output" />;
    case 'chart':
      return <ChartView spec={o.spec} />;
    case 'table':
      return (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                {o.columns.map((c, i) => (
                  <th key={i} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {o.rows.slice(0, 500).map((r, ri) => (
                <tr key={ri}>
                  {r.map((v, ci) => (
                    <td key={ci} className={typeof v === 'number' ? 'num' : undefined}>
                      {v === null ? '—' : typeof v === 'number' ? v.toLocaleString() : v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {o.rows.length > 500 && <p className="muted" style={{ padding: 6, fontSize: 'var(--fs-xs)' }}>Showing 500 of {o.rows.length} rows.</p>}
        </div>
      );
  }
}
