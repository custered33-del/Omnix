import { Fragment, type ReactElement } from 'react';
import { inlineToHtml, markdownToBlocks, type BlockInput } from '@omnix/core';

/** Inline markdown rendered through the core's escaping renderer (links are sanitized there). */
export function Inline({ text }: { text: string }) {
  return <span dangerouslySetInnerHTML={{ __html: inlineToHtml(text) }} />;
}

/** Render markdown with the same parser documents and exports use. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = markdownToBlocks(source);
  const out: ReactElement[] = [];
  let list: { ordered: boolean; items: BlockInput[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    out.push(
      <Tag key={`l${out.length}`}>
        {list.items.map((b, i) => (
          <li key={i}>
            {b.blockType === 'todo' && <input type="checkbox" checked={!!b.checked} readOnly aria-label={b.checked ? 'Done' : 'Not done'} style={{ marginRight: 6 }} />}
            <Inline text={b.text} />
          </li>
        ))}
      </Tag>,
    );
    list = null;
  };
  blocks.forEach((b, i) => {
    const isList = b.blockType === 'bullet' || b.blockType === 'numbered' || b.blockType === 'todo';
    if (isList) {
      const ordered = b.blockType === 'numbered';
      if (list && list.ordered !== ordered) flush();
      list = list ?? { ordered, items: [] };
      list.items.push(b);
      return;
    }
    flush();
    switch (b.blockType) {
      case 'heading': {
        const level = Math.min(6, Math.max(1, b.level ?? 1));
        const H = `h${level}` as 'h1';
        out.push(
          <H key={i}>
            <Inline text={b.text} />
          </H>,
        );
        break;
      }
      case 'quote':
        out.push(
          <blockquote key={i}>
            <Inline text={b.text} />
          </blockquote>,
        );
        break;
      case 'code':
        out.push(
          <pre key={i}>
            <code>{b.text}</code>
          </pre>,
        );
        break;
      case 'divider':
        out.push(<hr key={i} />);
        break;
      case 'table':
        out.push(
          <table key={i} className="data-table">
            <tbody>
              {(b.rows ?? []).map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (ri === 0 ? <th key={ci}><Inline text={c} /></th> : <td key={ci}><Inline text={c} /></td>))}
                </tr>
              ))}
            </tbody>
          </table>,
        );
        break;
      default:
        out.push(
          <p key={i}>
            <Inline text={b.text} />
          </p>,
        );
    }
  });
  flush();
  return <div className={`markdown ${className ?? ''}`}>{out.map((e, i) => <Fragment key={i}>{e}</Fragment>)}</div>;
}
