import { memo, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { GripVertical, Plus, Trash2, ImagePlus } from 'lucide-react';
import type { SceneNode, TextStyle } from '@omnix/core';
import { inlineToHtml } from '@omnix/core';
import { assetUrl } from '../../lib/api.js';
import { EmbedView } from '../../components/EmbedView.js';
import { AiMarker } from '../../components/AiMarker.js';
import { CodeMirror } from '../code/CodeMirror.js';
import { caretOffset, caretOnEdgeLine, domToInline, setCaret, splitAtCaret } from './inline.js';
import { indent, LIST_BLOCKS, mergeNext, mergeWithPrevious, moveBlock, pasteMarkdown, shortcutFor, splitBlock, suggestEdit, suggestInsert, turnInto, type DocCtx } from './docOps.js';

export interface BlockEnv {
  ctx: DocCtx;
  canEdit: boolean;
  /** Register the editable element so other blocks can move focus into it. */
  register(id: string, el: HTMLElement | null): void;
  focusSibling(id: string, dir: -1 | 1, where: 'start' | 'end'): void;
  openSlash(id: string, query: string, rect: DOMRect): void;
  slashOpen: boolean;
  slashKey(e: React.KeyboardEvent): boolean;
  closeSlash(): void;
  onSelectionChange(): void;
  onFocusBlock(id: string): void;
  onBlockMenu(id: string, anchor: HTMLElement): void;
  onInsertBelow(id: string, anchor: HTMLElement): void;
  dragStart(id: string): void;
  dragOver(id: string, where: 'before' | 'after' | null): void;
  drop(): void;
  dropTarget: { id: string; where: 'before' | 'after' } | null;
}

export function styleVars(s: TextStyle | undefined): CSSProperties {
  if (!s) return {};
  return {
    fontFamily: `"${s.fontFamily}", ${s.fontFamily === 'JetBrains Mono' ? 'monospace' : 'Inter, system-ui, sans-serif'}`,
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
    color: s.color,
    lineHeight: s.lineHeight,
    marginTop: s.spaceBefore,
    marginBottom: s.spaceAfter,
    fontStyle: s.italic ? 'italic' : undefined,
  };
}

/** One document block. Text-like blocks are contentEditable rich text backed by inline markdown. */
export const DocBlock = memo(function DocBlock({ block, env, style, number, displayText, suggestionPending, deleted }: { block: SceneNode<'block'>; env: BlockEnv; style: TextStyle | undefined; number: number; displayText: string; suggestionPending: boolean; deleted: boolean }) {
  const p = block.props;
  const isText = p.blockType !== 'code' && p.blockType !== 'table' && p.blockType !== 'image' && p.blockType !== 'embed' && p.blockType !== 'divider';
  const drop = env.dropTarget?.id === block.id ? env.dropTarget.where : null;
  return (
    <div
      className={`blk blk-${p.blockType}${p.blockType === 'heading' ? ` blk-h${p.level ?? 1}` : ''}${drop ? ` drop-${drop}` : ''}${deleted ? ' blk-deleted' : ''}`}
      data-block={block.id}
      style={{ ...styleVars(style), ...(LIST_BLOCKS.has(p.blockType) ? { paddingLeft: (p.level ?? 0) * 24 } : {}) }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('application/x-omnix-block')) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        env.dragOver(block.id, e.clientY < r.top + r.height / 2 ? 'before' : 'after');
      }}
      onDrop={(e) => {
        e.preventDefault();
        env.drop();
      }}
    >
      {env.canEdit && (
        <div className="blk-gutter" contentEditable={false}>
          <button className="icon-btn xs" aria-label="Insert below" onClick={(e) => env.onInsertBelow(block.id, e.currentTarget)} tabIndex={-1}>
            <Plus />
          </button>
          <button
            className="icon-btn xs blk-handle"
            aria-label="Block options (drag to move)"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-omnix-block', block.id);
              e.dataTransfer.effectAllowed = 'move';
              env.dragStart(block.id);
            }}
            onDragEnd={() => env.dragOver('', null)}
            onClick={(e) => env.onBlockMenu(block.id, e.currentTarget)}
            tabIndex={-1}
          >
            <GripVertical />
          </button>
        </div>
      )}
      <AiMarker nodeId={block.id} className="blk-ai" />
      {p.blockType === 'bullet' && <span className="blk-marker" aria-hidden="true">{['•', '◦', '▪', '•', '◦'][p.level ?? 0]}</span>}
      {p.blockType === 'numbered' && <span className="blk-marker" aria-hidden="true">{number}.</span>}
      {p.blockType === 'todo' && (
        <input
          type="checkbox"
          className="blk-check"
          checked={!!p.checked}
          disabled={!env.canEdit}
          aria-label={p.checked ? 'Done' : 'Not done'}
          onChange={(e) => env.ctx.store.getState().commit({ kind: 'update', id: block.id, set: { checked: e.target.checked } }, e.target.checked ? 'Check item' : 'Uncheck item')}
        />
      )}
      {isText && <EditableText block={block} env={env} displayText={displayText} suggestionPending={suggestionPending} />}
      {p.blockType === 'divider' && <hr className="blk-hr" />}
      {p.blockType === 'code' && <CodeBlock block={block} env={env} />}
      {p.blockType === 'table' && <TableBlock block={block} env={env} />}
      {p.blockType === 'image' && <ImageBlock block={block} env={env} />}
      {p.blockType === 'embed' && p.embed && (
        <div className="blk-embed" tabIndex={0} onFocus={() => env.onFocusBlock(block.id)}>
          <EmbedView embed={p.embed} />
        </div>
      )}
    </div>
  );
});

function EditableText({ block, env, displayText, suggestionPending }: { block: SceneNode<'block'>; env: BlockEnv; displayText: string; suggestionPending: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const p = block.props;
  const { ctx } = env;
  // Reflect outside changes (other people, Claude, undo) without disturbing local typing.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (domToInline(el) === displayText) return;
    const focused = document.activeElement === el;
    const off = focused ? caretOffset(el) : null;
    el.innerHTML = inlineToHtml(displayText);
    if (focused && off !== null) setCaret(el, Math.min(off, el.textContent?.length ?? 0));
  }, [displayText]);
  useLayoutEffect(() => {
    env.register(block.id, ref.current);
    return () => env.register(block.id, null);
  }, [block.id]);

  const commitText = (md: string) => {
    if (ctx.suggesting) suggestEdit(ctx, block.id, md);
    else ctx.text.edit(block.id, 'text', md, 'Edit text');
  };

  const onInput = () => {
    const el = ref.current!;
    const md = domToInline(el);
    const plain = el.textContent ?? '';
    // Markdown shortcuts at the start of a paragraph.
    if (p.blockType === 'paragraph' && !ctx.suggesting) {
      const sc = shortcutFor(plain);
      if (sc) {
        const rest = md.replace(/^(\\?#{1,3}|\\?[-*+]|1[.)]|\\?\[\\?\]|\\?\[ \\?\]|>)\s/, '');
        ctx.text.discard(block.id);
        ctx.store.getState().commit({ kind: 'update', id: block.id, set: { ...(sc.to.blockType === 'heading' ? { level: sc.to.level } : {}), blockType: sc.to.blockType, text: rest, ...(sc.to.blockType === 'todo' ? { checked: false } : {}) } }, `Turn into ${sc.to.blockType}`);
        ctx.focus(block.id, 'start');
        return;
      }
    }
    if (plain.startsWith('/') && !plain.includes(' ')) {
      const sel = window.getSelection();
      const rect = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : el.getBoundingClientRect();
      env.openSlash(block.id, plain.slice(1), rect.width || rect.height ? rect : el.getBoundingClientRect());
    } else if (env.slashOpen) env.closeSlash();
    commitText(md);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = ref.current!;
    if (env.slashOpen && env.slashKey(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (ctx.suggesting) return suggestInsert(ctx, block.id);
      const { before, after } = splitAtCaret(el);
      splitBlock(ctx, block.id, before, after);
      return;
    }
    if (e.key === 'Backspace' && !mod) {
      const sel = window.getSelection();
      if (sel?.isCollapsed && caretOffset(el) === 0 && !ctx.suggesting) {
        e.preventDefault();
        if (p.blockType !== 'paragraph') return turnInto(ctx, block.id, { blockType: 'paragraph' });
        mergeWithPrevious(ctx, block.id, domToInline(el));
      }
      return;
    }
    if (e.key === 'Delete' && !mod) {
      const sel = window.getSelection();
      if (sel?.isCollapsed && caretOffset(el) === (el.textContent?.length ?? 0) && !ctx.suggesting) {
        if (mergeNext(ctx, block.id, domToInline(el))) e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowUp' && !e.shiftKey && caretOnEdgeLine(el, 'top')) {
      e.preventDefault();
      env.focusSibling(block.id, -1, 'end');
      return;
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && caretOnEdgeLine(el, 'bottom')) {
      e.preventDefault();
      env.focusSibling(block.id, 1, 'start');
      return;
    }
    if (e.key === 'Tab' && LIST_BLOCKS.has(p.blockType)) {
      e.preventDefault();
      indent(ctx, block.id, e.shiftKey ? -1 : 1);
      return;
    }
    if (e.altKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      moveBlock(ctx, block.id, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (mod && e.altKey && /^[0-3]$/.test(e.key)) {
      e.preventDefault();
      turnInto(ctx, block.id, e.key === '0' ? { blockType: 'paragraph' } : { blockType: 'heading', level: Number(e.key) });
      return;
    }
    if (mod && e.shiftKey && (e.key === '7' || e.key === '8' || e.key === '&' || e.key === '*')) {
      e.preventDefault();
      turnInto(ctx, block.id, { blockType: e.key === '7' || e.key === '&' ? 'numbered' : 'bullet' });
      return;
    }
    if (mod && !e.shiftKey && ['b', 'i'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      document.execCommand(e.key.toLowerCase() === 'b' ? 'bold' : 'italic');
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      document.execCommand('strikeThrough');
      return;
    }
    if (mod && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      wrapSelectionInCode();
      return;
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text/plain');
    e.preventDefault();
    if (!text) return;
    if (/\n/.test(text.trim()) || /^!embed\[|^!\[[^\]]*\]\(asset:/.test(text.trim())) {
      if (!ctx.suggesting) pasteMarkdown(ctx, block.id, text);
      return;
    }
    document.execCommand('insertText', false, text.replace(/\s+/g, ' '));
  };

  const placeholder = p.blockType === 'heading' ? `Heading ${p.level ?? 1}` : p.blockType === 'paragraph' ? "Type '/' for blocks, or just write" : p.blockType === 'quote' ? 'Quote' : 'List item';
  const label = p.blockType === 'heading' ? `Heading level ${p.level ?? 1}` : p.blockType === 'paragraph' ? 'Paragraph' : p.blockType === 'quote' ? 'Quote' : p.blockType === 'todo' ? 'To-do item' : 'List item';
  return (
    <div
      ref={ref}
      className={`blk-text${suggestionPending ? ' has-suggestion' : ''}`}
      contentEditable={env.canEdit}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      data-placeholder={placeholder}
      spellCheck
      onInput={onInput}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onFocus={() => env.onFocusBlock(block.id)}
      onBlur={() => ctx.text.flush(block.id)}
      onMouseUp={env.onSelectionChange}
      onKeyUp={env.onSelectionChange}
    />
  );
}

function wrapSelectionInCode(): void {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString();
  document.execCommand('insertHTML', false, `<code>${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</code>`);
}

function CodeBlock({ block, env }: { block: SceneNode<'block'>; env: BlockEnv }) {
  const p = block.props;
  const langs = ['text', 'python', 'javascript', 'typescript', 'json', 'markdown', 'css', 'html'] as const;
  return (
    <div className="blk-code" onFocus={() => env.onFocusBlock(block.id)}>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <select className="select sm" style={{ width: 130 }} aria-label="Code language" value={(langs as readonly string[]).includes(p.language ?? '') ? p.language : 'text'} disabled={!env.canEdit} onChange={(e) => env.ctx.store.getState().commit({ kind: 'update', id: block.id, set: { language: e.target.value } }, 'Change code language')}>
          {langs.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <CodeMirror compact value={p.text} language={(langs as readonly string[]).includes(p.language ?? '') ? (p.language as (typeof langs)[number]) : 'text'} readOnly={!env.canEdit} label="Code block" onChange={(v) => env.ctx.text.edit(block.id, 'text', v, 'Edit code block')} />
    </div>
  );
}

function TableBlock({ block, env }: { block: SceneNode<'block'>; env: BlockEnv }) {
  const rows = block.props.rows?.length ? block.props.rows : [['', ''], ['', '']];
  const s = env.ctx.store.getState();
  const set = (next: string[][], label: string) => s.commit({ kind: 'update', id: block.id, set: { rows: next } }, label);
  const cols = Math.max(...rows.map((r) => r.length));
  const cellRefs = useRef<(HTMLElement | null)[]>([]);
  return (
    <div className="blk-table" onFocus={() => env.onFocusBlock(block.id)}>
      <table className="data-table doc-table">
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {Array.from({ length: cols }, (_, ci) => {
                const Tag = ri === 0 ? 'th' : 'td';
                return (
                  <Tag key={ci}>
                    <TableCell
                      value={r[ci] ?? ''}
                      canEdit={env.canEdit}
                      label={`Row ${ri + 1}, column ${ci + 1}`}
                      cellRef={(el) => (cellRefs.current[ri * cols + ci] = el)}
                      onChange={(v) => {
                        const next = rows.map((row) => [...row]);
                        while (next[ri]!.length < cols) next[ri]!.push('');
                        next[ri]![ci] = v;
                        env.ctx.text.edit(block.id, 'rows', next, 'Edit table');
                      }}
                      onTab={(back) => {
                        const k = ri * cols + ci + (back ? -1 : 1);
                        if (k >= rows.length * cols && !back) {
                          env.ctx.text.flush(block.id);
                          set([...rows.map((row) => [...row]), Array(cols).fill('')], 'Add table row');
                          requestAnimationFrame(() => cellRefs.current[k]?.focus());
                        } else cellRefs.current[Math.max(0, k)]?.focus();
                      }}
                    />
                  </Tag>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {env.canEdit && (
        <div className="row blk-table-actions" style={{ gap: 4 }}>
          <button className="btn btn-sm btn-ghost" onClick={() => (env.ctx.text.flush(block.id), set([...rows.map((r) => [...r]), Array(cols).fill('')], 'Add table row'))}>
            <Plus /> Row
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => (env.ctx.text.flush(block.id), set(rows.map((r) => [...r, '']), 'Add table column'))}>
            <Plus /> Column
          </button>
          {rows.length > 1 && (
            <button className="btn btn-sm btn-ghost" onClick={() => (env.ctx.text.flush(block.id), set(rows.slice(0, -1), 'Remove table row'))}>
              <Trash2 /> Last row
            </button>
          )}
          {cols > 1 && (
            <button className="btn btn-sm btn-ghost" onClick={() => (env.ctx.text.flush(block.id), set(rows.map((r) => r.slice(0, cols - 1)), 'Remove table column'))}>
              <Trash2 /> Last column
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TableCell({ value, canEdit, label, onChange, onTab, cellRef }: { value: string; canEdit: boolean; label: string; onChange: (v: string) => void; onTab: (back: boolean) => void; cellRef: (el: HTMLElement | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    if (domToInline(el) !== value) el.innerHTML = inlineToHtml(value);
  }, [value]);
  useLayoutEffect(() => cellRef(ref.current), []);
  return (
    <div
      ref={ref}
      className="cell-edit"
      contentEditable={canEdit}
      suppressContentEditableWarning
      role="textbox"
      aria-label={label}
      onInput={() => onChange(domToInline(ref.current!))}
      onKeyDown={(e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          onTab(e.shiftKey);
        }
        if (e.key === 'Enter') e.preventDefault();
      }}
    />
  );
}

function ImageBlock({ block, env }: { block: SceneNode<'block'>; env: BlockEnv }) {
  const p = block.props;
  const [caption, setCaption] = useState(p.caption ?? '');
  useLayoutEffect(() => setCaption(p.caption ?? ''), [p.caption]);
  return (
    <figure className="blk-image" style={{ margin: 0 }} onFocus={() => env.onFocusBlock(block.id)}>
      {p.assetId ? (
        <img src={assetUrl(p.assetId)} alt={p.caption || 'Image'} />
      ) : (
        <div className="embed-missing">
          <ImagePlus /> No image chosen
        </div>
      )}
      <input
        className="blk-caption"
        value={caption}
        placeholder={env.canEdit ? 'Add a caption (also used as alt text)' : ''}
        aria-label="Image caption"
        readOnly={!env.canEdit}
        onChange={(e) => setCaption(e.target.value)}
        onBlur={() => caption !== (p.caption ?? '') && env.ctx.store.getState().commit({ kind: 'update', id: block.id, set: { caption } }, 'Edit caption')}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </figure>
  );
}

