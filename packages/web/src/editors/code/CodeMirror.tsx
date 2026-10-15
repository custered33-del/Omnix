import { useEffect, useRef } from 'react';
import { Annotation, EditorState, Compartment, RangeSet, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, placeholder as cmPlaceholder, gutter, GutterMarker, Decoration, WidgetType, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle, foldGutter, foldKeymap } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { tags } from '@lezer/highlight';

/** Marks edits that came from outside the editor (so they are not echoed back as local changes). */
const External = Annotation.define<boolean>();

export type EditorLanguage = 'python' | 'javascript' | 'typescript' | 'json' | 'markdown' | 'css' | 'html' | 'text';

export function languageForPath(p: string): EditorLanguage {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  return ({ py: 'python', js: 'javascript', mjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown', css: 'css', html: 'html', htm: 'html' } as Record<string, EditorLanguage>)[ext] ?? 'text';
}

function languageExtension(lang: EditorLanguage): Extension {
  switch (lang) {
    case 'python':
      return python();
    case 'javascript':
      return javascript({ jsx: true });
    case 'typescript':
      return javascript({ typescript: true, jsx: true });
    case 'json':
      return json();
    case 'markdown':
      return markdown();
    case 'css':
      return css();
    case 'html':
      return html();
    default:
      return [];
  }
}

/** Syntax colors come from CSS variables so light, dark and high-contrast themes all apply. */
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.modifier], color: 'var(--code-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--code-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--code-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--code-function)' },
  { tag: [tags.definition(tags.variableName), tags.className, tags.typeName], color: 'var(--code-type)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--code-property)' },
  { tag: [tags.heading], fontWeight: '700', color: 'var(--code-keyword)' },
  { tag: [tags.emphasis], fontStyle: 'italic' },
  { tag: [tags.strong], fontWeight: '700' },
  { tag: [tags.link, tags.url], color: 'var(--code-string)', textDecoration: 'underline' },
  { tag: [tags.tagName], color: 'var(--code-keyword)' },
  { tag: [tags.invalid], color: 'var(--danger)' },
]);

const theme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--bg)' },
  '.cm-content': { fontFamily: 'var(--mono)', caretColor: 'var(--text)', padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--muted)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent) 10%, transparent)', color: 'var(--text-2)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--text)' },
  '.cm-placeholder': { color: 'var(--muted)' },
});

/** Comment threads and collaborators' cursors shown on lines (1-based). */
export interface LineMarks {
  comments: { id: string; line: number; n: number; resolved: boolean }[];
  cursors: { id: string; line: number; name: string; color: string }[];
}

const setMarks = StateEffect.define<LineMarks>();

class CommentMarker extends GutterMarker {
  constructor(readonly items: LineMarks['comments']) {
    super();
  }
  override eq(other: CommentMarker) {
    return other.items.map((c) => `${c.id}${c.n}${c.resolved}`).join() === this.items.map((c) => `${c.id}${c.n}${c.resolved}`).join();
  }
  override toDOM() {
    const el = document.createElement('span');
    const open = this.items.filter((c) => !c.resolved);
    el.className = `cm-comment-marker${open.length ? '' : ' resolved'}`;
    el.textContent = String(this.items[0]!.n) + (this.items.length > 1 ? '+' : '');
    el.title = `${this.items.length} comment${this.items.length > 1 ? 's' : ''}`;
    return el;
  }
}

class AddCommentMarker extends GutterMarker {
  override toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-comment-add';
    el.textContent = '+';
    return el;
  }
}
const addMarker = new AddCommentMarker();

class NameTag extends WidgetType {
  constructor(
    readonly name: string,
    readonly color: string,
  ) {
    super();
  }
  override eq(other: NameTag) {
    return other.name === this.name && other.color === this.color;
  }
  override toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-remote-tag';
    el.textContent = this.name;
    el.style.background = this.color;
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
}

interface MarkState {
  marks: LineMarks;
  gutter: RangeSet<GutterMarker>;
  lines: DecorationSet;
}

function buildMarks(state: EditorState, marks: LineMarks): MarkState {
  const max = state.doc.lines;
  const byLine = new Map<number, LineMarks['comments']>();
  for (const c of marks.comments) {
    const l = Math.min(max, Math.max(1, c.line));
    byLine.set(l, [...(byLine.get(l) ?? []), c]);
  }
  const gutterRanges: Range<GutterMarker>[] = [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([l, items]) => new CommentMarker(items).range(state.doc.line(l).from));
  const deco: Range<Decoration>[] = [];
  for (const c of [...marks.cursors].sort((a, b) => a.line - b.line)) {
    if (c.line < 1 || c.line > max) continue;
    const line = state.doc.line(c.line);
    deco.push(Decoration.line({ attributes: { class: 'cm-remote-line', style: `--remote: ${c.color}` } }).range(line.from));
    deco.push(Decoration.widget({ widget: new NameTag(c.name, c.color), side: 1 }).range(line.to));
  }
  return { marks, gutter: RangeSet.of(gutterRanges, true), lines: Decoration.set(deco, true) };
}

const marksField = StateField.define<MarkState>({
  create: (state) => buildMarks(state, { comments: [], cursors: [] }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) return buildMarks(tr.state, e.value);
    return tr.docChanged ? { ...value, gutter: value.gutter.map(tr.changes), lines: value.lines.map(tr.changes) } : value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.lines),
});

export interface CodeMirrorProps {
  value: string;
  language: EditorLanguage;
  onChange?: (value: string) => void;
  onRun?: () => void;
  onRunAndAdvance?: () => void;
  readOnly?: boolean;
  /** Compact mode for notebook cells (no gutters, grows with content). */
  compact?: boolean;
  label: string;
  placeholder?: string;
  autoFocus?: boolean;
  onFocus?: () => void;
  /** Comments and collaborators' cursors on lines (full editor only). */
  marks?: LineMarks;
  /** The comment gutter was clicked (on a thread, or on an empty line to start one). */
  onLineComment?: (line: number, commentId: string | null, rect: DOMRect) => void;
  /** Clicking a line starts a comment there instead of placing the cursor. */
  commentMode?: boolean;
  /** The line the cursor is on changed (1-based). */
  onCursorLine?: (line: number) => void;
  /** Scroll to and select this line; bump seq to repeat. */
  reveal?: { line: number; seq: number } | null;
  /** Where a revealed line ended up on screen. */
  onRevealed?: (line: number, rect: DOMRect) => void;
}

/**
 * CodeMirror 6 editor. Local typing is reported through onChange; when `value` changes from
 * outside (another person or Claude), the minimal edit is applied so the cursor stays put.
 */
export function CodeMirror(props: CodeMirrorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef(props);
  cb.current = props;
  const langComp = useRef(new Compartment());
  const roComp = useRef(new Compartment());
  const lastLine = useRef(0);

  useEffect(() => {
    const runKeys = keymap.of([
      { key: 'Mod-Enter', run: () => (cb.current.onRun?.(), !!cb.current.onRun) },
      { key: 'Shift-Enter', run: () => (cb.current.onRunAndAdvance ? (cb.current.onRunAndAdvance(), true) : false) },
    ]);
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        runKeys,
        marksField,
        ...(props.compact
          ? []
          : [
              gutter({
                class: 'cm-comment-gutter',
                markers: (v) => v.state.field(marksField).gutter,
                initialSpacer: () => addMarker,
                lineMarkerChange: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(setMarks))),
                domEventHandlers: {
                  mousedown(v, block, e) {
                    if (!cb.current.onLineComment) return false;
                    const line = v.state.doc.lineAt(block.from).number;
                    const items = v.state.field(marksField).marks.comments.filter((c) => Math.min(v.state.doc.lines, Math.max(1, c.line)) === line);
                    cb.current.onLineComment(line, items[0]?.id ?? null, (e.target as HTMLElement).getBoundingClientRect());
                    e.preventDefault();
                    return true;
                  },
                },
              }),
              lineNumbers(),
              highlightActiveLineGutter(),
              foldGutter(),
            ]),
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        syntaxHighlighting(highlight),
        theme,
        EditorView.lineWrapping,
        EditorState.tabSize.of(props.language === 'python' ? 4 : 2),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
        langComp.current.of(languageExtension(props.language)),
        roComp.current.of(EditorState.readOnly.of(!!props.readOnly)),
        ...(props.placeholder ? [cmPlaceholder(props.placeholder)] : []),
        EditorView.contentAttributes.of({ 'aria-label': props.label }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && u.transactions.some((tr) => !tr.annotation(External))) cb.current.onChange?.(u.state.doc.toString());
          if (u.focusChanged && u.view.hasFocus) cb.current.onFocus?.();
          if (u.selectionSet || u.docChanged) {
            const line = u.state.doc.lineAt(u.state.selection.main.head).number;
            if (line !== lastLine.current) {
              lastLine.current = line;
              cb.current.onCursorLine?.(line);
            }
          }
        }),
        EditorView.domEventHandlers({
          mousedown(e, v) {
            if (!cb.current.commentMode || !cb.current.onLineComment || e.button !== 0) return false;
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos === null) return false;
            const line = v.state.doc.lineAt(pos);
            const top = v.lineBlockAt(line.from).top + v.documentTop;
            const r = v.contentDOM.getBoundingClientRect();
            cb.current.onLineComment(line.number, null, new DOMRect(r.left, top, r.width, v.defaultLineHeight));
            e.preventDefault();
            return true;
          },
        }),
      ],
    });
    view.current = new EditorView({ state, parent: host.current! });
    if (props.autoFocus) view.current.focus();
    return () => view.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: langComp.current.reconfigure(languageExtension(props.language)) });
  }, [props.language]);
  useEffect(() => {
    view.current?.dispatch({ effects: roComp.current.reconfigure(EditorState.readOnly.of(!!props.readOnly)) });
  }, [props.readOnly]);

  useEffect(() => {
    if (props.marks) view.current?.dispatch({ effects: setMarks.of(props.marks) });
  }, [props.marks]);
  useEffect(() => {
    const v = view.current;
    if (!v || !props.reveal) return;
    const line = v.state.doc.line(Math.min(v.state.doc.lines, Math.max(1, props.reveal.line)));
    v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    v.focus();
    // Measure after CodeMirror has scrolled and laid out.
    v.requestMeasure({
      read: (view) => view.coordsAtPos(line.from),
      write: (c) => {
        if (c) cb.current.onRevealed?.(line.number, new DOMRect(c.left, c.top, 0, c.bottom - c.top));
      },
    });
  }, [props.reveal?.seq]);

  // Apply outside changes as a single minimal replacement.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur === props.value) return;
    let start = 0;
    while (start < cur.length && start < props.value.length && cur[start] === props.value[start]) start++;
    let endA = cur.length;
    let endB = props.value.length;
    while (endA > start && endB > start && cur[endA - 1] === props.value[endB - 1]) {
      endA--;
      endB--;
    }
    v.dispatch({ changes: { from: start, to: endA, insert: props.value.slice(start, endB) }, annotations: External.of(true) });
  }, [props.value]);

  return <div ref={host} className={props.compact ? 'cm-compact' : 'cm-full'} style={props.compact ? undefined : { height: '100%' }} />;
}
