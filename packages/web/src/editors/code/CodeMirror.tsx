import { useEffect, useRef } from 'react';
import { Annotation, EditorState, Compartment, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, placeholder as cmPlaceholder } from '@codemirror/view';
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

  useEffect(() => {
    const runKeys = keymap.of([
      { key: 'Mod-Enter', run: () => (cb.current.onRun?.(), !!cb.current.onRun) },
      { key: 'Shift-Enter', run: () => (cb.current.onRunAndAdvance ? (cb.current.onRunAndAdvance(), true) : false) },
    ]);
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        runKeys,
        ...(props.compact ? [] : [lineNumbers(), highlightActiveLineGutter(), foldGutter()]),
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
