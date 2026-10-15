import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { Bold, Italic, Strikethrough, Code2, Link2, List, ListOrdered, ListChecks, Quote, Table2, ImagePlus, Minus, MessageSquarePlus, ListTree, Type, Pencil, Eye, Plus, Sparkles, Heading1, Heading2, Heading3, Pilcrow, Link as LinkIcon, Presentation, Palette } from 'lucide-react';
import type { BlockProps, BlockType, EmbedRef, SceneNode, TextStyle } from '@omnix/core';
import { DEFAULT_DOC_STYLES, defaultStyleFor, documentBlocks, documentOutline, documentPlainText, documentSuggestions, inlineToPlain, listNumber, wordCount } from '@omnix/core';
import { useFocusRequest, useProject, useProjectStore } from '../../state/project.js';
import { makeTextCommitter } from '../../state/textCommitter.js';
import { useCommands } from '../../state/commands.js';
import { useDialogs } from '../../state/dialogs.js';
import { post } from '../../lib/api.js';
import { toast } from '../../ui/toast.js';
import { ColorField, Dialog, IconButton, Menu, MenuButton, NumberField, Select, type MenuItemDef } from '../../ui/primitives.js';
import { AssetPicker } from '../../components/AssetPicker.js';
import { EmbedPicker } from '../../components/EmbedView.js';
import { addComment, CommentThread, commentsFor, currentAuthor, NewComment } from '../../components/Comments.js';
import { FontSelect } from '../shared/FontSelect.js';
import { plural, t } from '../../i18n/index.js';
import { DocBlock, type BlockEnv } from './DocBlock.js';
import { SuggestionCard } from './SuggestionCard.js';
import { insertAfter, mySuggestion, suggestDelete, TEXT_BLOCKS, turnInto, type DocCtx, type TurnInto } from './docOps.js';
import { domToInline, selectionRange, setCaret } from './inline.js';
import '../../styles/editors.css';
import '../../styles/documents.css';
import { PresetMenu } from '../../components/PresetMenu.js';

const PAGE_WIDTH = { a4: 794, letter: 816 } as const;

const isList = (b?: BlockProps) => !!b && (b.blockType === 'bullet' || b.blockType === 'numbered' || b.blockType === 'todo');

/** Consecutive list items sit close together (exports use the same rule). */
function listSpacing(s: TextStyle | undefined, b: BlockProps, prev?: BlockProps, next?: BlockProps): TextStyle | undefined {
  if (!s || !isList(b)) return s;
  return { ...s, spaceBefore: isList(prev) ? 0 : s.spaceBefore, spaceAfter: isList(next) ? Math.min(s.spaceAfter, 4) : s.spaceAfter };
}

interface SlashItem {
  label: string;
  hint: string;
  icon: ReactElement;
  keywords: string;
  run: (blockId: string) => void;
}

export function DocumentEditor({ documentId }: { documentId: string }) {
  const store = useProjectStore();
  const state = useProject((s) => s.state)!;
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  const doc = state.nodes[documentId] as SceneNode<'document'> | undefined;
  const [suggesting, setSuggesting] = useState(false);
  const [panel, setPanel] = useState<'outline' | 'styles' | null>('outline');
  const [focused, setFocused] = useState<string | null>(null);
  const [slash, setSlash] = useState<{ blockId: string; query: string; rect: DOMRect; index: number } | null>(null);
  const [selBar, setSelBar] = useState<{ rect: DOMRect; blockId: string; range: [number, number] } | null>(null);
  const [commentDraft, setCommentDraft] = useState<{ blockId: string; range: [number, number] | null; quote: string } | null>(null);
  const [activeComment, setActiveComment] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; items: MenuItemDef[] } | null>(null);
  const [picker, setPicker] = useState<null | { kind: 'image' | 'embed'; after: string | null; replace?: boolean }>(null);
  const [linkFor, setLinkFor] = useState<{ range: Range } | null>(null);
  const [drag, setDrag] = useState<{ id: string; target: { id: string; where: 'before' | 'after' } | null } | null>(null);
  const els = useRef(new Map<string, HTMLElement>());
  const pendingFocus = useRef<{ id: string; where: 'start' | 'end' | number } | null>(null);
  const text = useMemo(() => makeTextCommitter(store, 600), [store]);
  useEffect(() => () => text.flushAll(), [text]);

  const ctx: DocCtx = useMemo(
    () => ({
      store,
      docId: documentId,
      text,
      suggesting,
      focus: (id, where = 'end') => {
        pendingFocus.current = { id, where };
        requestAnimationFrame(applyFocus);
      },
    }),
    [store, documentId, text, suggesting],
  );

  const applyFocus = useCallback(() => {
    const f = pendingFocus.current;
    if (!f) return;
    const el = els.current.get(f.id);
    if (!el) return;
    pendingFocus.current = null;
    el.focus();
    setCaret(el, f.where === 'start' ? 0 : f.where === 'end' ? (el.textContent?.length ?? 0) : f.where);
  }, []);
  useLayoutEffect(applyFocus);

  const me = currentAuthor().id;
  const blocks = doc ? documentBlocks(state, documentId) : [];
  const suggestions = doc ? documentSuggestions(state, documentId, 'open') : [];
  const blockIds = useMemo(() => new Set([documentId, ...blocks.map((b) => b.id)]), [blocks.map((b) => b.id).join(','), documentId]);
  const comments = commentsFor(state, blockIds);
  const commentMode = useProject((s) => s.commentMode);
  const presence = useProject((s) => s.presence);
  // Collaborators' current paragraphs (shown as a colored bar and name beside the block).
  const othersIn = new Map<string, { name: string; color: string; id: string }[]>();
  for (const p of Object.values(presence)) {
    const b = p.location?.tool === 'document' && p.location.nodeId === documentId ? p.location.blockId : undefined;
    if (b) othersIn.set(b, [...(othersIn.get(b) ?? []), { name: p.author.name, color: p.color, id: p.clientId }]);
  }
  const openCommentsOn = (blockId: string) => comments.filter((c) => c.props.anchor.nodeId === blockId && !c.props.resolved);
  const showComment = (id: string) => {
    setActiveComment(id);
    requestAnimationFrame(() => document.getElementById(`doc-comment-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };
  // Jump to a paragraph or comment (from the comments panel, search or a link).
  useFocusRequest(documentId, (r) => {
    const target = r.nodeId && r.nodeId !== documentId ? r.nodeId : null;
    if (target) requestAnimationFrame(() => els.current.get(target)?.scrollIntoView({ block: 'center' }));
    if (r.commentId) showComment(r.commentId);
  });

  const styles = doc?.props.styles ?? DEFAULT_DOC_STYLES;
  const styleOf = (b: BlockProps): TextStyle | undefined => styles[defaultStyleFor(b)] ?? styles.body;

  /* ---------------- selection toolbar ---------------- */
  const onSelectionChange = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return setSelBar(null);
    const r = sel.getRangeAt(0);
    const host = (r.commonAncestorContainer instanceof Element ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement)?.closest('.blk-text') as HTMLElement | null;
    const blockId = host?.closest('[data-block]')?.getAttribute('data-block');
    if (!host || !blockId) return setSelBar(null);
    const range = selectionRange(host);
    if (!range) return setSelBar(null);
    setSelBar({ rect: r.getBoundingClientRect(), blockId, range });
  }, []);
  // Follow every selection change (mouse, double-click, keyboard) so the toolbar appears reliably.
  useEffect(() => {
    let raf = 0;
    const onDoc = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(onSelectionChange);
    };
    document.addEventListener('selectionchange', onDoc);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('selectionchange', onDoc);
    };
  }, [onSelectionChange]);

  const format = (cmd: 'bold' | 'italic' | 'strikeThrough' | 'code') => {
    if (cmd === 'code') {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const txt = sel.toString().replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
      document.execCommand('insertHTML', false, `<code>${txt}</code>`);
    } else document.execCommand(cmd);
  };

  /* ---------------- slash menu ---------------- */
  const turn = (id: string, to: TurnInto) => {
    const el = els.current.get(id);
    if (el) el.textContent = '';
    text.discard(id);
    store.getState().commit({ kind: 'update', id, set: { text: '', blockType: to.blockType, ...(to.level ? { level: to.level } : {}), ...(to.blockType === 'todo' ? { checked: false } : {}) } }, `Turn into ${to.blockType}`);
    ctx.focus(id, 'start');
  };
  const insertKind = (after: string | null, kind: 'table' | 'code' | 'divider' | 'image' | 'embed', replace = false) => {
    if (kind === 'image' || kind === 'embed') return setPicker({ kind, after, replace });
    const props: Partial<BlockProps> = kind === 'table' ? { blockType: 'table', text: '', rows: [['Column 1', 'Column 2', 'Column 3'], ['', '', ''], ['', '', '']] } : kind === 'code' ? { blockType: 'code', text: '', language: 'python' } : { blockType: 'divider', text: '' };
    const ids = insertAfter(ctx, after, kind === 'divider' ? [props, { blockType: 'paragraph', text: '' }] : [props], `Insert ${kind}`, { replace });
    if (kind === 'divider') ctx.focus(ids[1]!, 'start');
  };
  const slashItems: SlashItem[] = [
    { label: 'Text', hint: 'Plain paragraph', icon: <Pilcrow size={16} />, keywords: 'paragraph text body', run: (id) => turn(id, { blockType: 'paragraph' }) },
    { label: 'Heading 1', hint: 'Big section heading', icon: <Heading1 size={16} />, keywords: 'h1 title heading', run: (id) => turn(id, { blockType: 'heading', level: 1 }) },
    { label: 'Heading 2', hint: 'Medium heading', icon: <Heading2 size={16} />, keywords: 'h2 heading subtitle', run: (id) => turn(id, { blockType: 'heading', level: 2 }) },
    { label: 'Heading 3', hint: 'Small heading', icon: <Heading3 size={16} />, keywords: 'h3 heading', run: (id) => turn(id, { blockType: 'heading', level: 3 }) },
    { label: 'Bulleted list', hint: 'Simple list', icon: <List size={16} />, keywords: 'bullet list ul', run: (id) => turn(id, { blockType: 'bullet' }) },
    { label: 'Numbered list', hint: 'Ordered steps', icon: <ListOrdered size={16} />, keywords: 'numbered list ol ordered', run: (id) => turn(id, { blockType: 'numbered' }) },
    { label: 'To-do list', hint: 'Checkboxes', icon: <ListChecks size={16} />, keywords: 'todo task check', run: (id) => turn(id, { blockType: 'todo' }) },
    { label: 'Quote', hint: 'Pull quote', icon: <Quote size={16} />, keywords: 'quote blockquote', run: (id) => turn(id, { blockType: 'quote' }) },
    { label: 'Table', hint: 'Rows and columns', icon: <Table2 size={16} />, keywords: 'table grid', run: (id) => insertKind(id, 'table', true) },
    { label: 'Code block', hint: 'Code with highlighting', icon: <Code2 size={16} />, keywords: 'code snippet', run: (id) => insertKind(id, 'code', true) },
    { label: 'Image', hint: 'From your library', icon: <ImagePlus size={16} />, keywords: 'image picture photo', run: (id) => insertKind(id, 'image', true) },
    { label: 'Live link', hint: 'Chart, output, image, frame or slide that stays up to date', icon: <LinkIcon size={16} />, keywords: 'embed live link chart output code', run: (id) => insertKind(id, 'embed', true) },
    { label: 'Divider', hint: 'Horizontal rule', icon: <Minus size={16} />, keywords: 'divider rule line hr', run: (id) => insertKind(id, 'divider', true) },
  ];
  const slashFiltered = slash ? slashItems.filter((i) => `${i.label} ${i.keywords}`.toLowerCase().includes(slash.query.toLowerCase())) : [];

  /* ---------------- block environment ---------------- */
  const env: BlockEnv = {
    ctx,
    canEdit,
    register: (id, el) => {
      if (el) els.current.set(id, el);
      else els.current.delete(id);
    },
    focusSibling: (id, dir, where) => {
      const order = [...els.current.keys()].sort((a, b) => {
        const ea = els.current.get(a)!;
        const eb = els.current.get(b)!;
        return ea.compareDocumentPosition(eb) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
      const i = order.indexOf(id);
      const next = order[i + dir];
      if (next) ctx.focus(next, where);
    },
    openSlash: (id, query, rect) => setSlash((cur) => ({ blockId: id, query, rect, index: cur?.blockId === id ? Math.min(cur.index, 20) : 0 })),
    slashOpen: !!slash,
    slashKey: (e) => {
      if (!slash) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSlash({ ...slash, index: (slash.index + (e.key === 'ArrowDown' ? 1 : -1) + slashFiltered.length) % Math.max(1, slashFiltered.length) });
        return true;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = slashFiltered[slash.index];
        setSlash(null);
        if (item) item.run(slash.blockId);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlash(null);
        return true;
      }
      return false;
    },
    closeSlash: () => setSlash(null),
    onSelectionChange,
    onFocusBlock: (id) => {
      setFocused(id);
      store.getState().reportLocation({ tool: 'document', nodeId: documentId, blockId: id });
    },
    onBlockMenu: (id, anchor) => setMenu({ anchor, items: blockMenu(id) }),
    onInsertBelow: (id, anchor) =>
      setMenu({
        anchor,
        items: [
          { label: 'Insert below', heading: true },
          { label: 'Paragraph', onSelect: () => ctx.focus(insertAfter(ctx, id, [{ blockType: 'paragraph', text: '' }])[0]!, 'start') },
          { label: 'Heading', onSelect: () => ctx.focus(insertAfter(ctx, id, [{ blockType: 'heading', level: 2, text: '' }])[0]!, 'start') },
          { label: 'Bulleted list', onSelect: () => ctx.focus(insertAfter(ctx, id, [{ blockType: 'bullet', text: '' }])[0]!, 'start') },
          { label: 'Table', onSelect: () => insertKind(id, 'table') },
          { label: 'Code block', onSelect: () => insertKind(id, 'code') },
          { label: 'Image', onSelect: () => insertKind(id, 'image') },
          { label: 'Live link', onSelect: () => insertKind(id, 'embed') },
          { label: 'Divider', onSelect: () => insertKind(id, 'divider') },
        ],
      }),
    dragStart: (id) => setDrag({ id, target: null }),
    dragOver: (id, where) => setDrag((d) => (d ? { ...d, target: where && id ? { id, where } : null } : d)),
    drop: () => {
      if (drag?.target && drag.target.id !== drag.id) {
        const order = doc!.children.filter((x) => x !== drag.id);
        const ti = order.indexOf(drag.target.id);
        store.getState().commit({ kind: 'move', id: drag.id, parentId: documentId, index: drag.target.where === 'before' ? ti : ti + 1 }, 'Move block');
      }
      setDrag(null);
    },
    dropTarget: drag?.target ?? null,
  };

  const blockMenu = (id: string): MenuItemDef[] => {
    const b = state.nodes[id] as SceneNode<'block'>;
    const isText = TEXT_BLOCKS.has(b.props.blockType);
    const styleNames = Object.keys(styles);
    return [
      ...(isText
        ? [
            { label: 'Turn into', heading: true },
            ...(
              [
                ['Text', { blockType: 'paragraph' }],
                ['Heading 1', { blockType: 'heading', level: 1 }],
                ['Heading 2', { blockType: 'heading', level: 2 }],
                ['Heading 3', { blockType: 'heading', level: 3 }],
                ['Bulleted list', { blockType: 'bullet' }],
                ['Numbered list', { blockType: 'numbered' }],
                ['To-do list', { blockType: 'todo' }],
                ['Quote', { blockType: 'quote' }],
                ['Code block', { blockType: 'code' }],
              ] as [string, TurnInto][]
            ).map(([label, to]) => ({ label, onSelect: () => turnInto(ctx, id, to) })),
            { separator: true, label: '' },
            { label: 'Style', heading: true },
            { label: `Default (${defaultStyleFor({ ...b.props, style: null })})`, onSelect: () => store.getState().commit({ kind: 'update', id, set: {}, unset: ['style'] }, 'Use default style') },
            ...styleNames.map((n) => ({ label: n === b.props.style ? `${n} ✓` : n, onSelect: () => store.getState().commit({ kind: 'update', id, set: { style: n } }, `Style ${n}`) })),
            { separator: true, label: '' },
          ]
        : []),
      { label: 'Comment', onSelect: () => setCommentDraft({ blockId: id, range: null, quote: inlineToPlain(b.props.text).slice(0, 140) }) },
      { label: 'Duplicate', onSelect: () => insertAfter(ctx, id, [structuredClone(b.props)], 'Duplicate block') },
      { label: 'Move up', shortcut: 'Alt+Shift+↑', onSelect: () => store.getState().commit({ kind: 'move', id, parentId: documentId, index: Math.max(0, doc!.children.indexOf(id) - 1) }, 'Move block') },
      { label: 'Move down', shortcut: 'Alt+Shift+↓', onSelect: () => store.getState().commit({ kind: 'move', id, parentId: documentId, index: doc!.children.indexOf(id) + 1 }, 'Move block') },
      { separator: true, label: '' },
      suggesting ? { label: 'Suggest deleting', danger: true, onSelect: () => suggestDelete(ctx, id) } : { label: t('app.delete'), danger: true, onSelect: () => store.getState().commit({ kind: 'delete', id }, 'Delete block') },
    ];
  };

  const openStyle = useDialogs((d) => d.openStyle);
  const makeSlides = async () => {
    try {
      const r = await post<{ deckId: string; slides: number }>(`/api/projects/${store.getState().projectId}/slides-from-document`, { documentId });
      toast.success(plural('crossTool.slidesMade', r.slides));
      for (let i = 0; i < 60 && !store.getState().state?.nodes[r.deckId]; i++) await new Promise((res) => setTimeout(res, 50));
      if (store.getState().state?.nodes[r.deckId]) store.getState().setActiveDoc(r.deckId);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  useCommands(
    'document',
    [
      { id: 'doc.makeSlides', label: t('crossTool.makeSlides'), section: t('tools.documentLong'), keywords: 'deck presentation', run: () => void makeSlides() },
      { id: 'doc.suggest', label: suggesting ? 'Switch to editing' : 'Switch to suggesting', section: t('tools.documentLong'), run: () => setSuggesting(!suggesting) },
      { id: 'doc.outline', label: 'Show outline', section: t('tools.documentLong'), run: () => setPanel('outline') },
      { id: 'doc.styles', label: 'Edit styles', section: t('tools.documentLong'), run: () => setPanel('styles') },
      { id: 'doc.link', label: 'Insert live link', section: t('tools.documentLong'), run: () => insertKind(focused, 'embed') },
    ],
    [suggesting, focused],
  );

  if (!doc) return null;
  const plain = documentPlainText(state, documentId);
  const words = wordCount(plain);
  const focusedBlock = focused ? (state.nodes[focused] as SceneNode<'block'> | undefined) : undefined;
  const currentKind = focusedBlock ? (focusedBlock.props.blockType === 'heading' ? `h${focusedBlock.props.level ?? 1}` : focusedBlock.props.blockType) : 'paragraph';

  return (
    <div className="doc-editor">
      <div className="doc-toolbar" role="toolbar" aria-label="Formatting">
        <select
          className="select sm"
          style={{ width: 150 }}
          aria-label="Paragraph style"
          value={['paragraph', 'h1', 'h2', 'h3', 'quote', 'bullet', 'numbered', 'todo', 'code'].includes(currentKind) ? currentKind : 'paragraph'}
          disabled={!canEdit || !focusedBlock || !TEXT_BLOCKS.has(focusedBlock.props.blockType)}
          onChange={(e) => {
            const v = e.target.value;
            if (!focused) return;
            turnInto(ctx, focused, v.startsWith('h') ? { blockType: 'heading', level: Number(v.slice(1)) } : { blockType: v as BlockType });
          }}
        >
          <option value="paragraph">Normal text</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
          <option value="quote">Quote</option>
          <option value="bullet">Bulleted list</option>
          <option value="numbered">Numbered list</option>
          <option value="todo">To-do list</option>
          <option value="code">Code block</option>
        </select>
        <div className="row" style={{ gap: 0 }}>
          <IconButton small label="Bold" shortcut="Ctrl+B" onClick={() => format('bold')} disabled={!canEdit}>
            <Bold />
          </IconButton>
          <IconButton small label="Italic" shortcut="Ctrl+I" onClick={() => format('italic')} disabled={!canEdit}>
            <Italic />
          </IconButton>
          <IconButton small label="Strikethrough" shortcut="Ctrl+Shift+X" onClick={() => format('strikeThrough')} disabled={!canEdit}>
            <Strikethrough />
          </IconButton>
          <IconButton small label="Inline code" shortcut="Ctrl+E" onClick={() => format('code')} disabled={!canEdit}>
            <Code2 />
          </IconButton>
          <IconButton small label="Link" onClick={() => openLink()} disabled={!canEdit}>
            <Link2 />
          </IconButton>
        </div>
        <MenuButton
          className="btn btn-sm"
          label="Insert"
          items={() => [
            { label: 'Table', icon: <Table2 />, onSelect: () => insertKind(focused ?? blocks[blocks.length - 1]?.id ?? null, 'table') },
            { label: 'Image', icon: <ImagePlus />, onSelect: () => insertKind(focused ?? blocks[blocks.length - 1]?.id ?? null, 'image') },
            { label: 'Code block', icon: <Code2 />, onSelect: () => insertKind(focused ?? blocks[blocks.length - 1]?.id ?? null, 'code') },
            { label: 'Live link', icon: <LinkIcon />, onSelect: () => insertKind(focused ?? blocks[blocks.length - 1]?.id ?? null, 'embed') },
            { label: 'Divider', icon: <Minus />, onSelect: () => insertKind(focused ?? blocks[blocks.length - 1]?.id ?? null, 'divider') },
          ]}
        >
          <Plus /> Insert
        </MenuButton>
        <span className="spacer" />
        {canEdit && (
          <button className="btn btn-sm btn-ghost" onClick={() => void makeSlides()} title={t('crossTool.makeSlidesHint')}>
            <Presentation size={14} /> {t('crossTool.makeSlides')}
          </button>
        )}
        <IconButton small label={t('style.title')} onClick={() => openStyle(documentId)} disabled={!canEdit}>
          <Palette />
        </IconButton>
        <div className="segmented" role="group" aria-label="Mode">
          <button aria-pressed={!suggesting} onClick={() => setSuggesting(false)} disabled={!canEdit}>
            <Pencil size={14} /> Editing
          </button>
          <button aria-pressed={suggesting} onClick={() => setSuggesting(true)} disabled={!canEdit}>
            <Eye size={14} /> Suggesting
          </button>
        </div>
        <IconButton small label="Outline" pressed={panel === 'outline'} onClick={() => setPanel(panel === 'outline' ? null : 'outline')}>
          <ListTree />
        </IconButton>
        <IconButton small label="Styles" pressed={panel === 'styles'} onClick={() => setPanel(panel === 'styles' ? null : 'styles')}>
          <Type />
        </IconButton>
        <span className="muted tabular" style={{ fontSize: 'var(--fs-sm)' }} aria-live="polite">
          {words.toLocaleString()} {words === 1 ? 'word' : 'words'}
        </span>
      </div>
      <div className="doc-body">
        {panel === 'outline' && (
          <nav className="doc-outline" aria-label="Outline">
            <h3>Outline</h3>
            {documentOutline(state, documentId).map((o) => (
              <button key={o.id} className="outline-item" style={{ paddingLeft: 8 + (o.level - 1) * 14 }} onClick={() => (els.current.get(o.id)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), ctx.focus(o.id, 'end'))}>
                {o.text || 'Untitled heading'}
              </button>
            ))}
            {documentOutline(state, documentId).length === 0 && <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Headings appear here.</p>}
          </nav>
        )}
        <div className="doc-scroll">
          {suggesting && (
            <div className="doc-banner" role="status">
              <Eye size={14} /> Suggesting: your edits are proposals until someone accepts them.
            </div>
          )}
          <article
            className={`doc-page${commentMode ? ' commenting' : ''}`}
            style={{ maxWidth: PAGE_WIDTH[doc.props.pageSize] }}
            aria-label={doc.props.name}
            onPointerDownCapture={(e) => {
              // Comment mode: clicking a paragraph pins a comment to it.
              if (!commentMode || !canEdit || e.button !== 0) return;
              const id = (e.target as HTMLElement).closest('[data-block]')?.getAttribute('data-block');
              const b = id ? (state.nodes[id] as SceneNode<'block'> | undefined) : undefined;
              if (!b) return;
              e.preventDefault();
              e.stopPropagation();
              setCommentDraft({ blockId: b.id, range: null, quote: inlineToPlain(b.props.text).slice(0, 120) });
            }}
          >
            {blocks.map((b, i) => {
              const mine = suggesting ? mySuggestion(state, documentId, b.id) : undefined;
              const own = suggestions.filter((s) => s.props.blockId === b.id);
              const here = othersIn.get(b.id);
              const open = openCommentsOn(b.id);
              return (
                <div key={b.id} className={`blk-wrap${here ? ' has-others' : ''}`} style={here ? ({ '--remote': here[0]!.color } as CSSProperties) : undefined}>
                  {here && (
                    <span className="blk-presence" aria-label={here.map((h) => t('comments.editing', { name: h.name })).join(', ')}>
                      {here.map((h) => (
                        <span key={h.id} style={{ background: h.color }}>
                          {h.name}
                        </span>
                      ))}
                    </span>
                  )}
                  {open.length > 0 && (
                    <button type="button" className="blk-comments" aria-label={plural('comments.count', open.length)} onClick={() => showComment(open[0]!.id)}>
                      {open.length}
                    </button>
                  )}
                  <DocBlock
                    block={b}
                    env={env}
                    style={listSpacing(styleOf(b.props), b.props, blocks[i - 1]?.props, blocks[i + 1]?.props)}
                    number={b.props.blockType === 'numbered' ? listNumber(blocks.map((x) => x.props), i) : 0}
                    displayText={mine ? mine.props.text : b.props.text}
                    suggestionPending={own.some((s) => s.props.kind === 'replace')}
                    deleted={own.some((s) => s.props.kind === 'delete')}
                  />
                  {own.map((s) =>
                    s.props.kind === 'insert-after' && suggesting && s.props.author.id === me ? (
                      <InsertSuggestion key={s.id} suggestion={s} env={env} />
                    ) : (
                      <SuggestionCard key={s.id} ctx={ctx} suggestion={s} block={b} canEdit={canEdit} />
                    ),
                  )}
                </div>
              );
            })}
            {canEdit && (
              <button className="doc-append" onClick={() => ctx.focus(insertAfter(ctx, blocks[blocks.length - 1]?.id ?? null, [{ blockType: 'paragraph', text: '' }])[0]!, 'start')} aria-label="Add a paragraph at the end">
                <Plus size={14} /> Click to add a paragraph
              </button>
            )}
          </article>
        </div>
        <aside className="doc-margin" aria-label={t('project.comments')}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <h3 style={{ fontSize: 'var(--fs-sm)' }}>
              {t('project.comments')} {comments.filter((c) => !c.props.resolved).length > 0 && <span className="badge">{comments.filter((c) => !c.props.resolved).length}</span>}
            </h3>
            {suggestions.length > 0 && (
              <span className="badge ai" title="Open suggestions">
                <Sparkles size={12} /> {suggestions.length} {suggestions.length === 1 ? 'suggestion' : 'suggestions'}
              </span>
            )}
          </div>
          {commentDraft && (
            <NewComment
              quote={commentDraft.quote}
              onCancel={() => setCommentDraft(null)}
              onSubmit={(body) => {
                const id = addComment(store, { tool: 'document', nodeId: commentDraft.blockId, ...(commentDraft.range ? { range: commentDraft.range } : {}) }, body);
                setCommentDraft(null);
                if (id) setActiveComment(id);
              }}
            />
          )}
          {comments.map((c) => {
            const b = state.nodes[c.props.anchor.nodeId] as SceneNode<'block'> | undefined;
            const plainText = b ? inlineToPlain(b.props.text) : '';
            const quote = c.props.anchor.range ? plainText.slice(c.props.anchor.range[0], c.props.anchor.range[1]) : plainText.slice(0, 120);
            return (
              <div key={c.id} id={`doc-comment-${c.id}`}>
              <CommentThread
                store={store}
                comment={c}
                quote={quote || undefined}
                active={activeComment === c.id}
                onFocus={() => {
                  setActiveComment(c.id);
                  els.current.get(c.props.anchor.nodeId)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                }}
              />
              </div>
            );
          })}
          {comments.length === 0 && !commentDraft && <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Select text and choose Comment, or use a block's menu.</p>}
        </aside>
        {panel === 'styles' && <StylesPanel doc={doc} canEdit={canEdit} />}
      </div>

      {slash && slashFiltered.length > 0 && (
        <div className="slash-menu" role="listbox" aria-label="Insert block" style={{ left: slash.rect.left, top: slash.rect.bottom + 6 }}>
          {slashFiltered.map((item, i) => (
            <button
              key={item.label}
              role="option"
              aria-selected={i === slash.index}
              className="slash-item"
              onMouseDown={(e) => {
                e.preventDefault();
                setSlash(null);
                item.run(slash.blockId);
              }}
            >
              {item.icon}
              <span className="col" style={{ gap: 0 }}>
                <span>{item.label}</span>
                <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                  {item.hint}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      {selBar && canEdit && (
        <div className="sel-toolbar" role="toolbar" aria-label="Selection" style={{ left: Math.max(8, selBar.rect.left + selBar.rect.width / 2 - 130), top: Math.max(56, selBar.rect.top - 44) }} onMouseDown={(e) => e.preventDefault()}>
          <IconButton small label="Bold" onClick={() => format('bold')}>
            <Bold />
          </IconButton>
          <IconButton small label="Italic" onClick={() => format('italic')}>
            <Italic />
          </IconButton>
          <IconButton small label="Strikethrough" onClick={() => format('strikeThrough')}>
            <Strikethrough />
          </IconButton>
          <IconButton small label="Inline code" onClick={() => format('code')}>
            <Code2 />
          </IconButton>
          <IconButton small label="Link" onClick={() => openLink()}>
            <Link2 />
          </IconButton>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => {
              const b = state.nodes[selBar.blockId] as SceneNode<'block'>;
              setCommentDraft({ blockId: selBar.blockId, range: selBar.range, quote: inlineToPlain(b.props.text).slice(selBar.range[0], selBar.range[1]) });
              setSelBar(null);
            }}
          >
            <MessageSquarePlus /> Comment
          </button>
        </div>
      )}
      {menu && <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} label="Block" />}
      {picker?.kind === 'image' && (
        <AssetPicker
          kinds={['image']}
          projectId={store.getState().projectId}
          onPick={([a]) => a && insertAfter(ctx, picker.after, [{ blockType: 'image', text: '', assetId: a.id, caption: a.name.replace(/\.[^.]+$/, '') }], 'Insert image', { replace: !!picker.replace })}
          onClose={() => setPicker(null)}
        />
      )}
      {picker?.kind === 'embed' && <EmbedPicker onPick={(e: EmbedRef) => insertAfter(ctx, picker.after, [{ blockType: 'embed', text: '', embed: e }], 'Insert live link', { replace: !!picker.replace })} onClose={() => setPicker(null)} />}
      {linkFor && <LinkDialog onClose={() => setLinkFor(null)} onApply={(url) => applyLink(linkFor.range, url)} />}
    </div>
  );

  function openLink() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    setLinkFor({ range: sel.getRangeAt(0).cloneRange() });
  }
  function applyLink(range: Range, url: string) {
    const sel = window.getSelection();
    const host = (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest('.blk-text') as HTMLElement | null;
    host?.focus();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const safe = /^(https?:|mailto:|#|\/)/i.test(url) ? url : `https://${url}`;
    document.execCommand('createLink', false, safe);
    setLinkFor(null);
  }
}

function InsertSuggestion({ suggestion, env }: { suggestion: SceneNode<'suggestion'>; env: BlockEnv }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    env.register(suggestion.id, ref.current);
    return () => env.register(suggestion.id, null);
  }, [suggestion.id]);
  useLayoutEffect(() => {
    const el = ref.current!;
    if (domToInline(el) !== suggestion.props.text && document.activeElement !== el) el.textContent = inlineToPlain(suggestion.props.text);
  }, [suggestion.props.text]);
  return (
    <div className="blk blk-insert-suggestion">
      <div
        ref={ref}
        className="blk-text"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label="Suggested new paragraph"
        data-placeholder="Write the paragraph you suggest adding…"
        onInput={() => env.ctx.text.edit(suggestion.id, 'text', domToInline(ref.current!), 'Edit suggestion')}
        onBlur={() => env.ctx.text.flush(suggestion.id)}
        onKeyDown={(e) => {
          if (e.key === 'Backspace' && !(ref.current!.textContent ?? '')) {
            e.preventDefault();
            env.ctx.text.discard(suggestion.id);
            env.ctx.store.getState().commit({ kind: 'delete', id: suggestion.id }, 'Withdraw suggestion');
          }
          if (e.key === 'Enter') e.preventDefault();
        }}
      />
    </div>
  );
}

function LinkDialog({ onClose, onApply }: { onClose: () => void; onApply: (url: string) => void }) {
  const [url, setUrl] = useState('https://');
  return (
    <Dialog
      title="Add link"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('app.cancel')}
          </button>
          <button className="btn btn-primary" onClick={() => onApply(url)} disabled={url.length < 4}>
            {t('app.apply')}
          </button>
        </>
      }
    >
      <input className="input" data-autofocus value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Link address" onKeyDown={(e) => e.key === 'Enter' && onApply(url)} />
    </Dialog>
  );
}

const STYLE_LABELS: Record<string, string> = { title: 'Title', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', body: 'Body', quote: 'Quote', code: 'Code', caption: 'Caption' };

/** Reusable named text styles: edit once, every block using the style updates. */
function StylesPanel({ doc, canEdit }: { doc: SceneNode<'document'>; canEdit: boolean }) {
  const store = useProjectStore();
  const [selected, setSelected] = useState('body');
  const styles = doc.props.styles;
  const s = styles[selected] ?? styles.body!;
  const set = (patch: Partial<TextStyle>) => store.getState().commit({ kind: 'update', id: doc.id, set: { styles: { ...styles, [selected]: { ...s, ...patch } } } }, `Edit style ${STYLE_LABELS[selected] ?? selected}`);
  return (
    <aside className="doc-styles" aria-label="Styles">
      <h3 className="row">
        <span className="grow">Styles</span>
        <PresetMenu kind="doc-styles" targetId={doc.id} sourceId={doc.id} canEdit={canEdit} className="btn btn-sm btn-ghost" />
      </h3>
      <fieldset className="props-fieldset col" style={{ gap: 10 }} disabled={!canEdit}>
        <Select label="Style" value={selected} options={Object.keys(styles).map((k) => ({ value: k, label: STYLE_LABELS[k] ?? k }))} onChange={setSelected} />
        <div className="field">
          <span className="label">{t('image.font')}</span>
          <FontSelect value={s.fontFamily} onChange={(v) => set({ fontFamily: v })} />
        </div>
        <NumberField compact slider={false} label="Size" value={s.fontSize} min={6} max={120} unit="px" onCommit={(v) => set({ fontSize: v })} />
        <NumberField compact slider={false} label="Weight" value={s.fontWeight} min={100} max={900} step={50} onCommit={(v) => set({ fontWeight: v })} />
        <ColorField label="Color" value={s.color} onChange={(v) => set({ color: v })} />
        <NumberField compact label="Line height" value={s.lineHeight} min={0.8} max={3} step={0.05} onCommit={(v) => set({ lineHeight: v })} />
        <NumberField compact slider={false} label="Space before" value={s.spaceBefore} min={0} max={120} unit="px" onCommit={(v) => set({ spaceBefore: v })} />
        <NumberField compact slider={false} label="Space after" value={s.spaceAfter} min={0} max={120} unit="px" onCommit={(v) => set({ spaceAfter: v })} />
        <label className="row" style={{ gap: 6, fontSize: 'var(--fs-sm)' }}>
          <input type="checkbox" checked={!!s.italic} onChange={(e) => set({ italic: e.target.checked })} /> Italic
        </label>
        <hr className="divider" />
        <Select
          label="Page size"
          value={doc.props.pageSize}
          options={[
            { value: 'a4', label: 'A4' },
            { value: 'letter', label: 'US Letter' },
          ]}
          onChange={(v) => store.getState().commit({ kind: 'update', id: doc.id, set: { pageSize: v } }, 'Change page size')}
        />
        <button className="btn btn-sm btn-ghost" onClick={() => store.getState().commit({ kind: 'update', id: doc.id, set: { styles: structuredClone(DEFAULT_DOC_STYLES) } }, 'Reset styles')}>
          Reset all styles
        </button>
      </fieldset>
    </aside>
  );
}
