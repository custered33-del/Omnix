import { z } from 'zod';
import {
  applyOp,
  acceptSuggestionOp,
  childrenOf,
  applyLayoutOps,
  applyThemeOp,
  commentsContainer,
  deckSlides,
  duplicateSlideOps,
  inlineToPlain,
  insertBlocksOps,
  makeNode,
  markdownToBlocks,
  newId,
  newSlideOps,
  rejectSuggestionOp,
  slideElements,
  suggestOp,
  THEME_PRESETS,
  zChartSpec,
  zColor,
  zEasing,
  zEmbedRef,
  zVectorShape,
  type BlockType,
  type Operation,
  type SceneNode,
  type SlideElementProps,
} from '@omnix/core';
import { layerBounds, type RenderHost } from '@omnix/render';
import { defineTool, ToolError, zProjectId } from '../registry.js';
import { edit, need, writeResult, zWriteResult } from './helpers.js';

/**
 * Document and slideshow tools. Text uses inline markdown (**bold**, *italic*, `code`,
 * [link](url), ~~strike~~); slides use deck pixels with the origin at the top-left.
 */

const BLOCK_TYPES = ['heading', 'paragraph', 'bullet', 'numbered', 'todo', 'quote', 'code', 'table', 'image', 'embed', 'divider'] as const;
const LAYOUTS = ['title', 'title-body', 'two-column', 'section', 'image-full', 'blank'] as const;

export const documentTools = [
  defineTool({
    name: 'doc_insert_markdown',
    title: 'Write into a document',
    description:
      'Insert Markdown into a document as editable blocks: headings, paragraphs, lists, to-dos ([ ] / [x]), quotes, code fences, tables, dividers, images (![alt](asset:<assetId>)) and live links (!embed[chart](<cellId>), !embed[canvas](<id>), !embed[slide](<id>), !embed[sequence-frame](<id>@<seconds>), !embed[asset](<assetId>)). Inserts after afterBlockId, at the start with afterBlockId null, or at the end by default (filling an empty last paragraph). A new document already starts with its name as a level-1 heading, so do not repeat it.',
    category: 'document',
    access: 'write',
    input: { projectId: zProjectId, documentId: z.string(), markdown: z.string().min(1).max(200_000), afterBlockId: z.string().nullable().optional() },
    output: zWriteResult.extend({ blockIds: z.array(z.string()) }),
    example: { input: { projectId: 'prj_8Kq2...', documentId: 'doc_1', markdown: '## Results\n\nSales grew **12%**.\n\n- North led\n- South recovered' }, output: { status: 'proposed', proposalId: 'prop_doc...', blockIds: ['blk_1', 'blk_2', 'blk_3', 'blk_4'] } },
    async handler(args, ctx) {
      let ids: string[] = [];
      const blocks = markdownToBlocks(args.markdown);
      if (!blocks.length) throw new ToolError('The markdown has no content.');
      const out = await edit(ctx, args.projectId, `Write ${blocks.length} ${blocks.length === 1 ? 'block' : 'blocks'}`, (state) => {
        const doc = need(state, args.documentId, 'document', 'document');
        if (args.afterBlockId) need(state, args.afterBlockId, 'block', 'block');
        // Writing at the end fills the empty line a document ends with (a new one starts with one), as typing would.
        const lastId = doc.children[doc.children.length - 1];
        const last = lastId ? state.nodes[lastId] : undefined;
        const blank = args.afterBlockId === undefined && last?.type === 'block' && (last as SceneNode<'block'>).props.blockType === 'paragraph' && !(last as SceneNode<'block'>).props.text.trim() && !commentsOn(state, last.id);
        const r = insertBlocksOps(state, args.documentId, blank ? (doc.children[doc.children.length - 2] ?? null) : args.afterBlockId, blocks);
        ids = r.ids;
        return blank ? [...r.ops, { kind: 'delete', id: last!.id }] : r.ops;
      });
      return writeResult(out, { blockIds: ids });
    },
  }),

  defineTool({
    name: 'doc_edit_block',
    title: 'Edit a block',
    description: 'Change a document block directly: its text (inline markdown), type (heading with level 1-3, paragraph, bullet, numbered, todo, quote, code), indent level, checked state, code language, table rows or named style. To propose a change for review instead, use doc_suggest.',
    category: 'document',
    access: 'write',
    input: {
      projectId: zProjectId,
      blockId: z.string(),
      text: z.string().max(100_000).optional(),
      blockType: z.enum(BLOCK_TYPES).optional(),
      level: z.number().int().min(0).max(6).optional(),
      checked: z.boolean().optional(),
      language: z.string().max(40).optional(),
      rows: z.array(z.array(z.string())).max(500).optional(),
      style: z.string().max(60).nullable().optional(),
    },
    output: zWriteResult,
    example: { input: { projectId: 'prj_8Kq2...', blockId: 'blk_2', text: 'Sales grew **14%** after the correction.' }, output: { status: 'committed', commitId: 'c_doc...' } },
    async handler(args, ctx) {
      const out = await edit(ctx, args.projectId, 'Edit text', (state) => {
        need(state, args.blockId, 'block', 'block');
        const set: Record<string, unknown> = {};
        for (const k of ['text', 'blockType', 'level', 'checked', 'language', 'rows', 'style'] as const) if (args[k] !== undefined) set[k] = args[k];
        if (!Object.keys(set).length) throw new ToolError('Nothing to change.');
        return [{ kind: 'update', id: args.blockId, set }];
      });
      return writeResult(out);
    },
  }),

  defineTool({
    name: 'doc_suggest',
    title: 'Suggest an edit',
    description:
      'Propose a change to a document block that people (or other AIs) accept or reject: replace its text, insert a new block after it, or delete it. Suggestions appear in the margin with a word-level diff and never change the text until accepted. Prefer this to doc_edit_block when the user should decide.',
    category: 'document',
    access: 'write',
    input: { projectId: zProjectId, blockId: z.string(), kind: z.enum(['replace', 'insert-after', 'delete']), text: z.string().max(100_000).optional(), blockType: z.enum(BLOCK_TYPES).optional(), reason: z.string().max(1000).optional().describe('Why, in one sentence (shown to the reviewer)') },
    output: zWriteResult.extend({ suggestionId: z.string() }),
    example: { input: { projectId: 'prj_8Kq2...', blockId: 'blk_2', kind: 'replace', text: 'Sales grew **12%** year over year.', reason: 'Clarifies the comparison period' }, output: { status: 'committed', commitId: 'c_sg...', suggestionId: 'sug_1...' } },
    async handler(args, ctx) {
      await ctx.requireProject(args.projectId, 'write');
      const state = await ctx.state(args.projectId);
      const block = need(state, args.blockId, 'block', 'block');
      const { op, id } = suggestOp(state, block.parentId!, { blockId: block.id, kind: args.kind, ...(args.text !== undefined ? { text: args.text } : {}), ...(args.blockType ? { blockType: args.blockType as BlockType } : {}), ...(args.reason ? { reason: args.reason } : {}) }, ctx.principal.author);
      const out = await ctx.apply(args.projectId, [op], `Suggest: ${args.kind === 'delete' ? 'delete a block' : inlineToPlain(args.text ?? '').slice(0, 50)}`, undefined, { reviewable: true });
      return writeResult(out, { suggestionId: id });
    },
  }),

  defineTool({
    name: 'doc_resolve_suggestion',
    title: 'Accept or reject a suggestion',
    description: 'Accept a suggested edit (optionally with adjusted text) so it changes the document, or reject it with a reason. Suggestions come from people and AIs alike; get_node on the document lists them.',
    category: 'document',
    access: 'write',
    input: { projectId: zProjectId, suggestionId: z.string(), accept: z.boolean(), text: z.string().max(100_000).optional().describe('accept: use this text instead'), reason: z.string().max(1000).optional().describe('reject: why') },
    output: zWriteResult,
    example: { input: { projectId: 'prj_8Kq2...', suggestionId: 'sug_1', accept: true }, output: { status: 'committed', commitId: 'c_acc...' } },
    async handler(args, ctx) {
      const out = await edit(ctx, args.projectId, args.accept ? 'Accept suggestion' : 'Reject suggestion', (state) => {
        need(state, args.suggestionId, 'suggestion', 'suggestion');
        return [args.accept ? acceptSuggestionOp(state, args.suggestionId, args.text !== undefined ? { text: args.text } : undefined) : rejectSuggestionOp(state, args.suggestionId, args.reason)];
      });
      return writeResult(out);
    },
  }),

  defineTool({
    name: 'add_comment',
    title: 'Comment',
    description:
      'Leave a comment pinned to something: a document block (optionally on a quoted phrase inside it), a slide or slide element (x, y), a layer or canvas (x, y), a clip or sequence (time in seconds), or a code file (line). Use it to ask questions or flag issues without changing the work. Reply to an existing comment with replyTo.',
    category: 'collaboration',
    access: 'write',
    input: {
      projectId: zProjectId,
      nodeId: z.string().optional().describe('What the comment is about'),
      text: z.string().min(1).max(10_000),
      quote: z.string().max(2000).optional().describe('Document blocks: the exact phrase the comment is about'),
      x: z.number().optional(),
      y: z.number().optional(),
      time: z.number().min(0).optional(),
      line: z.number().int().min(1).optional(),
      replyTo: z.string().optional().describe('Comment id to reply to (nodeId not needed)'),
    },
    output: zWriteResult.extend({ commentId: z.string() }),
    example: { input: { projectId: 'prj_8Kq2...', nodeId: 'blk_2', quote: '12%', text: 'Is this year over year or quarter over quarter?' }, output: { status: 'committed', commitId: 'c_cm...', commentId: 'cmt_1...' } },
    async handler(args, ctx) {
      await ctx.requireProject(args.projectId, 'write');
      const state = await ctx.state(args.projectId);
      const now = new Date().toISOString();
      if (args.replyTo) {
        const c = need(state, args.replyTo, 'comment', 'comment');
        const out = await ctx.apply(args.projectId, [{ kind: 'listInsert', id: c.id, prop: 'replies', items: [{ id: newId('rep'), author: ctx.principal.author, text: args.text, createdAt: now }] }], 'Reply to a comment', undefined, { reviewable: true });
        return writeResult(out, { commentId: c.id });
      }
      if (!args.nodeId) throw new ToolError('Pass nodeId (what the comment is about) or replyTo.');
      const target = state.nodes[args.nodeId];
      if (!target) throw new ToolError(`No node with id "${args.nodeId}" in this project. Call get_project (or get_node) to find the right id.`);
      const tool = ({ block: 'document', document: 'document', slide: 'slides', slideElement: 'slides', deck: 'slides', layer: 'image', canvas: 'image', clip: 'video', track: 'video', sequence: 'video', animLayer: 'animation', codeFile: 'code', cell: 'code', notebook: 'code', codeWorkspace: 'code' } as Record<string, string>)[target.type];
      if (!tool) throw new ToolError(`Comments cannot be pinned to a ${target.type}.`);
      let range: [number, number] | undefined;
      if (args.quote && target.type === 'block') {
        const plain = inlineToPlain((target as SceneNode<'block'>).props.text);
        const at = plain.indexOf(args.quote);
        if (at < 0) throw new ToolError(`"${args.quote}" is not in that block.`);
        range = [at, at + args.quote.length];
      }
      const node = makeNode('comment', {
        anchor: { tool: tool as never, nodeId: target.id, ...(args.x !== undefined ? { x: args.x } : {}), ...(args.y !== undefined ? { y: args.y } : {}), ...(args.time !== undefined ? { time: args.time } : {}), ...(args.line !== undefined ? { line: args.line } : {}), ...(range ? { range } : {}) },
        text: args.text,
        author: ctx.principal.author,
        createdAt: now,
        resolved: false,
        replies: [],
      });
      const out = await ctx.apply(args.projectId, [{ kind: 'create', parentId: commentsContainer(state).id, nodes: [node] }], 'Add comment', undefined, { reviewable: true });
      return writeResult(out, { commentId: node.id });
    },
  }),

  defineTool({
    name: 'list_comments',
    title: 'List comments',
    description:
      'Read the comment threads in a project (open ones by default): who wrote what, the replies, and where each is pinned, with the context it points at (the quoted text, the code line, the slide number, the time, or the canvas position). Use it to answer review feedback; resolve threads you have addressed with resolve_comment.',
    category: 'collaboration',
    access: 'read',
    input: { projectId: zProjectId, status: z.enum(['open', 'resolved', 'all']).default('open'), documentId: z.string().optional().describe('Only comments in this canvas, sequence, workspace, document or deck') },
    output: z.object({ comments: z.array(z.unknown()) }),
    example: { input: { projectId: 'prj_8Kq2...' }, output: { comments: [{ id: 'cmt_1', text: 'Can the logo be larger?', author: 'Seb', where: 'Slide 2', documentId: 'deck_1', replies: [] }] } },
    async handler(args, ctx) {
      await ctx.requireProject(args.projectId, 'read');
      const state = await ctx.state(args.projectId);
      const docOf = (id: string): SceneNode | undefined => {
        let cur: SceneNode | undefined = state.nodes[id];
        while (cur && !['canvas', 'sequence', 'codeWorkspace', 'document', 'deck'].includes(cur.type)) cur = cur.parentId ? state.nodes[cur.parentId] : undefined;
        return cur;
      };
      const comments = commentsContainer(state)
        .children.map((id) => state.nodes[id])
        .filter((n): n is SceneNode<'comment'> => !!n && n.type === 'comment')
        .filter((c) => args.status === 'all' || (args.status === 'open' ? !c.props.resolved : c.props.resolved))
        .map((c) => {
          const a = c.props.anchor;
          const target = state.nodes[a.nodeId];
          const doc = docOf(a.nodeId);
          if (args.documentId && doc?.id !== args.documentId) return null;
          let where = target ? String((target.props as { name?: string; path?: string }).name ?? (target.props as { path?: string }).path ?? target.type) : 'a deleted item';
          let context: string | undefined;
          if (target?.type === 'block') {
            const plain = inlineToPlain((target as SceneNode<'block'>).props.text);
            context = a.range ? plain.slice(a.range[0], a.range[1]) : plain.slice(0, 200);
            where = `paragraph in ${String((doc?.props as { name?: string } | undefined)?.name ?? 'the document')}`;
          } else if (target?.type === 'codeFile' && a.line !== undefined) {
            context = (target as SceneNode<'codeFile'>).props.content.split('\n')[a.line - 1];
            where = `${(target as SceneNode<'codeFile'>).props.path}, line ${a.line}`;
          } else if (target?.type === 'slide') {
            const deck = target.parentId ? state.nodes[target.parentId] : undefined;
            const idx = deck ? deckSlides(state, deck.id).findIndex((sl) => sl.id === target.id) + 1 : 0;
            where = `slide ${idx}${a.x !== undefined ? ` at (${Math.round(a.x)}, ${Math.round(a.y ?? 0)})` : ''}`;
          } else if (a.time !== undefined) where = `${where} at ${a.time.toFixed(2)}s${a.x !== undefined ? `, frame position (${Math.round(a.x)}, ${Math.round(a.y ?? 0)})` : ''}`;
          else if (a.x !== undefined) where = `${where} at (${Math.round(a.x)}, ${Math.round(a.y ?? 0)})`;
          // On a canvas, name the layer under the pin, so the comment can be acted on without guessing.
          const under = target?.type === 'canvas' && a.x !== undefined ? layerAt(state, target.id, a.x, a.y ?? 0) : null;
          if (under) where = `${where}, over the layer "${under.props.name}"`;
          return {
            id: c.id,
            text: c.props.text,
            author: c.props.author.name,
            authorType: c.props.author.type,
            createdAt: c.props.createdAt,
            resolved: c.props.resolved,
            where,
            ...(context !== undefined ? { context } : {}),
            anchor: a,
            ...(under ? { layerId: under.id } : {}),
            ...(doc ? { documentId: doc.id, documentType: doc.type } : {}),
            replies: c.props.replies.map((r) => ({ author: r.author.name, text: r.text, createdAt: r.createdAt })),
          };
        })
        .filter((c): c is NonNullable<typeof c> => !!c);
      const text = comments.length
        ? comments.map((c) => `- ${c.id} (${c.where}) ${c.author}: ${c.text.slice(0, 140)}${c.replies.length ? ` [${c.replies.length} repl${c.replies.length === 1 ? 'y' : 'ies'}]` : ''}${c.resolved ? ' [resolved]' : ''}`).join('\n')
        : `No ${args.status === 'all' ? '' : `${args.status} `}comments.`;
      return { text, data: { comments } };
    },
  }),

  defineTool({
    name: 'resolve_comment',
    title: 'Resolve a comment',
    description: 'Mark a comment thread resolved (or reopen it), optionally replying first to say what you changed. Like comments themselves, this applies directly in every permission mode.',
    category: 'collaboration',
    access: 'write',
    input: { projectId: zProjectId, commentId: z.string(), reply: z.string().max(10_000).optional().describe('A closing reply, for example what was changed'), reopen: z.boolean().optional() },
    output: zWriteResult,
    example: { input: { projectId: 'prj_8Kq2...', commentId: 'cmt_1', reply: 'Made the logo 40% larger on slide 2.' }, output: { status: 'committed', commitId: 'c_res...' } },
    async handler(args, ctx) {
      await ctx.requireProject(args.projectId, 'write');
      const state = await ctx.state(args.projectId);
      const c = need(state, args.commentId, 'comment', 'comment');
      const ops: Operation[] = [];
      if (args.reply) ops.push({ kind: 'listInsert', id: c.id, prop: 'replies', items: [{ id: newId('rep'), author: ctx.principal.author, text: args.reply, createdAt: new Date().toISOString() }] });
      ops.push({ kind: 'update', id: c.id, set: { resolved: !args.reopen } });
      const out = await ctx.apply(args.projectId, ops, args.reopen ? 'Reopen comment' : 'Resolve comment', undefined, { reviewable: true });
      return writeResult(out);
    },
  }),

  defineTool({
    name: 'doc_set_style',
    title: 'Change a document style',
    description: 'Change a named style for the whole document (body, h1, h2, h3, quote, code, caption or a new name): font family, size (pt), weight, color, line height, spacing before/after (pt) and italic.',
    category: 'document',
    access: 'write',
    input: {
      projectId: zProjectId,
      documentId: z.string(),
      style: z.string().min(1).max(40),
      fontFamily: z.string().max(80).optional(),
      fontSize: z.number().positive().max(200).optional(),
      fontWeight: z.number().min(100).max(900).optional(),
      color: zColor.optional(),
      lineHeight: z.number().min(0.8).max(4).optional(),
      spaceBefore: z.number().min(0).max(200).optional(),
      spaceAfter: z.number().min(0).max(200).optional(),
      italic: z.boolean().optional(),
    },
    output: zWriteResult,
    example: { input: { projectId: 'prj_8Kq2...', documentId: 'doc_1', style: 'h1', fontFamily: 'Georgia', fontSize: 32, color: '#1d3557' }, output: { status: 'proposed', proposalId: 'prop_sty...' } },
    async handler(args, ctx) {
      const out = await edit(ctx, args.projectId, `Change style ${args.style}`, (state) => {
        const doc = need(state, args.documentId, 'document', 'document');
        const base = doc.props.styles[args.style] ?? doc.props.styles.body ?? { fontFamily: 'Inter', fontSize: 11, fontWeight: 400, color: '#1d1f24', lineHeight: 1.5, spaceBefore: 0, spaceAfter: 8 };
        const next = { ...base };
        for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'color', 'lineHeight', 'spaceBefore', 'spaceAfter', 'italic'] as const) if (args[k] !== undefined) (next as Record<string, unknown>)[k] = args[k];
        return [{ kind: 'update', id: doc.id, set: { styles: { ...doc.props.styles, [args.style]: next } } }];
      });
      return writeResult(out);
    },
  }),

  /* Slides --------------------------------------------------------- */

  defineTool({
    name: 'slides_add_slide',
    title: 'Add a slide',
    description: 'Add a slide built from a layout (title, title-body, two-column, section, image-full, blank) with its placeholders filled: title, subtitle and body (inline markdown; "- " lines become bullets). Optional speaker notes. index 0 is first; default is the end.',
    category: 'slides',
    access: 'write',
    input: { projectId: zProjectId, deckId: z.string(), layout: z.enum(LAYOUTS).default('title-body'), title: z.string().max(500).optional(), subtitle: z.string().max(500).optional(), body: z.string().max(20_000).optional(), notes: z.string().max(50_000).optional(), index: z.number().int().min(0).optional() },
    output: zWriteResult.extend({ slideId: z.string(), elementIds: z.array(z.string()) }),
    example: { input: { projectId: 'prj_8Kq2...', deckId: 'dck_1', layout: 'title-body', title: 'Pricing', body: '- Starter: free\n- Pro: $12 a month', notes: 'Keep this under a minute.' }, output: { status: 'proposed', proposalId: 'prop_sl...', slideId: 'sld_4...', elementIds: ['el_t...', 'el_b...'] } },
    async handler(args, ctx) {
      let slideId = '';
      let elementIds: string[] = [];
      const out = await edit(ctx, args.projectId, `Add slide${args.title ? ` "${args.title.slice(0, 40)}"` : ''}`, (state) => {
        need(state, args.deckId, 'deck', 'slideshow');
        const r = newSlideOps(state, args.deckId, args.layout, { ...(args.index !== undefined ? { index: args.index } : {}), ...(args.title ? { name: inlineToPlain(args.title).slice(0, 60) } : {}), text: { ...(args.title !== undefined ? { title: args.title } : {}), ...(args.subtitle !== undefined ? { subtitle: args.subtitle } : {}), ...(args.body !== undefined ? { body: args.body } : {}) } });
        slideId = r.slideId;
        const create = r.op as Extract<Operation, { kind: 'create' }>;
        if (args.notes) (create.nodes[0]!.props as { notes: string }).notes = args.notes;
        elementIds = create.nodes.slice(1).map((n) => n.id);
        return [r.op];
      });
      return writeResult(out, { slideId, elementIds });
    },
  }),

  defineTool({
    name: 'slides_add_element',
    title: 'Add to a slide',
    description:
      'Add an element to a slide: text (inline markdown), image or video (asset), shape (rect, ellipse, line, polygon or path in its own width×height frame), chart (a chart spec; bar, line, area, pie or scatter) or embed (a live link to a Code Grounds chart or output, a canvas, an animation or video frame, or another slide). Position and size are deck pixels.',
    category: 'slides',
    access: 'write',
    input: {
      projectId: zProjectId,
      slideId: z.string(),
      elementType: z.enum(['text', 'image', 'video', 'shape', 'chart', 'embed']),
      x: z.number(),
      y: z.number(),
      w: z.number().positive(),
      h: z.number().min(0),
      rotation: z.number().default(0).describe('Degrees, clockwise'),
      text: z.string().max(20_000).optional(),
      fontSize: z.number().positive().max(500).optional(),
      fontFamily: z.string().max(80).optional(),
      color: zColor.optional(),
      align: z.enum(['left', 'center', 'right']).optional(),
      valign: z.enum(['top', 'middle', 'bottom']).optional(),
      bold: z.boolean().optional(),
      role: z.enum(['title', 'subtitle', 'body', 'image', 'footer']).nullable().optional(),
      assetId: z.string().optional(),
      shape: zVectorShape.omit({ id: true }).partial({ x: true, y: true }).optional(),
      chart: zChartSpec.optional(),
      embed: zEmbedRef.optional(),
    },
    output: zWriteResult.extend({ elementId: z.string() }),
    example: { input: { projectId: 'prj_8Kq2...', slideId: 'sld_3', elementType: 'chart', x: 160, y: 300, w: 1600, h: 680, chart: { type: 'bar', title: 'Pre-orders', labels: ['W1', 'W2', 'W3'], series: [{ name: 'Orders', values: [120, 260, 410] }] } }, output: { status: 'committed', commitId: 'c_el...', elementId: 'el_9...' } },
    async handler(args, ctx) {
      let elementId = '';
      const out = await edit(ctx, args.projectId, `Add ${args.elementType} to slide`, async (state) => {
        need(state, args.slideId, 'slide', 'slide');
        const p: Partial<SlideElementProps> = { elementType: args.elementType, x: args.x, y: args.y, w: args.w, h: args.h, rotation: args.rotation, role: args.role ?? null };
        switch (args.elementType) {
          case 'text':
            Object.assign(p, { text: args.text ?? '', ...(args.fontSize ? { fontSize: args.fontSize } : {}), ...(args.fontFamily ? { fontFamily: args.fontFamily } : {}), ...(args.color ? { color: args.color } : {}), ...(args.align ? { align: args.align } : {}), ...(args.valign ? { valign: args.valign } : {}), ...(args.bold !== undefined ? { bold: args.bold } : {}) });
            break;
          case 'image':
          case 'video': {
            if (!args.assetId) throw new ToolError(`An ${args.elementType} needs assetId.`);
            const a = await ctx.services.assets.get(args.assetId);
            if (!a || a.kind !== args.elementType) throw new ToolError(`Asset ${args.assetId} is not ${args.elementType === 'image' ? 'an image' : 'a video'}.`);
            p.assetId = a.id;
            break;
          }
          case 'shape':
            if (!args.shape) throw new ToolError('A shape needs shape { kind, fill, stroke, strokeWidth, ... }.');
            p.shape = { id: newId('shp'), x: 0, y: 0, ...args.shape, width: args.shape.width || args.w, height: args.shape.height || args.h };
            break;
          case 'chart':
            if (!args.chart) throw new ToolError('A chart needs a chart spec.');
            p.chart = args.chart;
            break;
          case 'embed':
            if (!args.embed) throw new ToolError('An embed needs { kind, ref }.');
            if (args.embed.kind !== 'asset' && !state.nodes[args.embed.ref]) throw new ToolError(`The linked node ${args.embed.ref} does not exist.`);
            p.embed = args.embed;
            break;
        }
        const node = makeNode('slideElement', p);
        elementId = node.id;
        return [{ kind: 'create', parentId: args.slideId, nodes: [node] }];
      });
      return writeResult(out, { elementId });
    },
  }),

  defineTool({
    name: 'slides_edit_slide',
    title: 'Change a slide',
    description: 'Change a slide: layout (moves placeholders), background color, speaker notes, transition (none, fade, push, wipe, zoom with duration and easing), hidden, or position in the deck. With duplicate: true a copy is made and the other changes apply to the copy (index places the copy); the original is left as it is.',
    category: 'slides',
    access: 'write',
    destructive: true,
    input: {
      projectId: zProjectId,
      slideId: z.string(),
      layout: z.enum(LAYOUTS).optional(),
      background: zColor.nullable().optional(),
      notes: z.string().max(50_000).optional(),
      transition: z.object({ kind: z.enum(['none', 'fade', 'push', 'wipe', 'zoom']), duration: z.number().min(0).max(10).default(0.5), easing: zEasing.default('ease-in-out') }).optional(),
      hidden: z.boolean().optional(),
      index: z.number().int().min(0).optional(),
      name: z.string().max(200).optional(),
      duplicate: z.boolean().optional(),
    },
    output: zWriteResult.extend({ slideId: z.string() }),
    example: { input: { projectId: 'prj_8Kq2...', slideId: 'sld_2', transition: { kind: 'push', duration: 0.6 }, notes: 'Pause after the chart.' }, output: { status: 'committed', commitId: 'c_sl...', slideId: 'sld_2' } },
    async handler(args, ctx) {
      let slideId = args.slideId;
      const out = await edit(ctx, args.projectId, args.duplicate ? 'Duplicate slide' : 'Change slide', (state) => {
        let slide = need(state, args.slideId, 'slide', 'slide');
        const ops: Operation[] = [];
        if (args.duplicate) {
          const d = duplicateSlideOps(state, slide.id);
          slideId = d.slideId;
          ops.push(d.op);
          // The remaining changes are made to the copy.
          state = applyOp(state, d.op).state;
          slide = need(state, d.slideId, 'slide', 'slide');
        }
        if (args.layout) ops.push(applyLayoutOps(state, slide.id, args.layout));
        const set: Record<string, unknown> = {};
        if (args.background !== undefined) set.background = args.background;
        if (args.notes !== undefined) set.notes = args.notes;
        if (args.transition) set.transition = args.transition;
        if (args.hidden !== undefined) set.hidden = args.hidden;
        if (args.name !== undefined) set.name = args.name;
        if (Object.keys(set).length) ops.push({ kind: 'update', id: slide.id, set });
        if (args.index !== undefined) ops.push({ kind: 'move', id: slide.id, parentId: slide.parentId!, index: Math.min(args.index, state.nodes[slide.parentId!]!.children.length - 1) });
        return ops;
      });
      return writeResult(out, { slideId });
    },
  }),

  defineTool({
    name: 'slides_animate',
    title: 'Animate a slide element',
    description:
      'Add a build animation to a slide element: fade-in, fly-in, zoom-in, pulse, spin, fade-out or fly-out. trigger "on-enter" plays when the slide appears; "on-click" waits for click number `click` (1 = first click; default: the next click); "with-previous" plays with the element\'s previous animation. delay and duration are seconds. clear: true removes all of the element\'s animations first.',
    category: 'slides',
    access: 'write',
    input: { projectId: zProjectId, elementId: z.string(), kind: z.enum(['fade-in', 'fly-in', 'zoom-in', 'pulse', 'spin', 'fade-out', 'fly-out']).optional(), trigger: z.enum(['on-enter', 'on-click', 'with-previous']).default('on-click'), click: z.number().int().min(1).max(200).optional(), delay: z.number().min(0).max(60).default(0), duration: z.number().min(0.05).max(60).default(0.6), easing: zEasing.default('ease-out'), clear: z.boolean().default(false) },
    output: zWriteResult.extend({ animationId: z.string().nullable() }),
    example: { input: { projectId: 'prj_8Kq2...', elementId: 'el_chart', kind: 'fade-in', trigger: 'on-click', click: 2 }, output: { status: 'proposed', proposalId: 'prop_an...', animationId: 'anim_1...' } },
    async handler(args, ctx) {
      const animationId = args.kind ? newId('anim') : null;
      const out = await edit(ctx, args.projectId, args.kind ? `Animate: ${args.kind}` : 'Clear animations', (state) => {
        const el = need(state, args.elementId, 'slideElement', 'slide element');
        const ops: Operation[] = [];
        if (args.clear && el.props.animations.length) ops.push({ kind: 'update', id: el.id, set: { animations: [] } });
        if (args.kind) ops.push({ kind: 'listInsert', id: el.id, prop: 'animations', items: [{ id: animationId!, kind: args.kind, delay: args.delay, duration: args.duration, easing: args.easing, trigger: args.trigger, ...(args.trigger === 'on-click' && args.click ? { click: args.click } : {}) }] });
        return ops;
      });
      return writeResult(out, { animationId });
    },
  }),

  defineTool({
    name: 'slides_set_theme',
    title: 'Change the slideshow theme',
    description: `Apply a theme to the whole deck: a preset (${THEME_PRESETS.map((t) => t.name).join(', ')}) or custom colors and fonts. Slides keep their own background overrides.`,
    category: 'slides',
    access: 'write',
    input: {
      projectId: zProjectId,
      deckId: z.string(),
      preset: z.enum(THEME_PRESETS.map((t) => t.name) as [string, ...string[]]).optional(),
      colors: z.object({ background: zColor, surface: zColor, text: zColor, muted: zColor, accent: zColor, accent2: zColor }).partial().optional(),
      fonts: z.object({ heading: z.string(), body: z.string(), mono: z.string() }).partial().optional(),
    },
    output: zWriteResult,
    example: { input: { projectId: 'prj_8Kq2...', deckId: 'dck_1', preset: 'Midnight', colors: { accent: '#ffb35c' } }, output: { status: 'committed', commitId: 'c_th...' } },
    async handler(args, ctx) {
      const out = await edit(ctx, args.projectId, `Theme${args.preset ? `: ${args.preset}` : ''}`, (state) => {
        const deck = need(state, args.deckId, 'deck', 'slideshow');
        const base = args.preset ? THEME_PRESETS.find((t) => t.name === args.preset)! : deck.props.theme;
        const theme = { ...structuredClone(base), colors: { ...base.colors, ...(args.colors ?? {}) }, fonts: { ...base.fonts, ...(args.fonts ?? {}) } };
        return [applyThemeOp(state, deck.id, theme)];
      });
      return writeResult(out);
    },
  }),

  defineTool({
    name: 'slides_outline',
    title: 'Read a slideshow',
    description: 'Every slide in order with its layout, notes, hidden state and elements (type, role, text, box, animations) so you can plan edits.',
    category: 'slides',
    access: 'read',
    input: { projectId: zProjectId, deckId: z.string() },
    output: z.object({ name: z.string(), width: z.number(), height: z.number(), slides: z.array(z.object({ id: z.string(), name: z.string(), layout: z.string(), hidden: z.boolean(), notes: z.string(), elements: z.array(z.record(z.string(), z.unknown())) })) }),
    example: { input: { projectId: 'prj_8Kq2...', deckId: 'dck_1' } },
    async handler(args, ctx) {
      await ctx.requireProject(args.projectId, 'read');
      const state = await ctx.state(args.projectId);
      const deck = need(state, args.deckId, 'deck', 'slideshow');
      const slides = deckSlides(state, deck.id).map((s) => ({
        id: s.id,
        name: s.props.name,
        layout: s.props.layout,
        hidden: s.props.hidden,
        notes: s.props.notes,
        elements: slideElements(state, s.id).map((e) => ({ id: e.id, type: e.props.elementType, role: e.props.role, ...(e.props.text ? { text: e.props.text } : {}), box: [Math.round(e.props.x), Math.round(e.props.y), Math.round(e.props.w), Math.round(e.props.h)], ...(e.props.chart ? { chart: e.props.chart.title ?? e.props.chart.type } : {}), ...(e.props.embed ? { embed: e.props.embed } : {}), ...(e.props.animations.length ? { animations: e.props.animations.map((a) => `${a.kind} ${a.trigger}${a.click ? ` #${a.click}` : ''}`) } : {}) })),
      }));
      return { text: slides.map((s, i) => `${i + 1}. ${s.name} [${s.layout}]${s.hidden ? ' (hidden)' : ''} — ${s.elements.map((e) => e.text ? inlineToPlain(String(e.text)).slice(0, 40) : e.type).join(' | ')}`).join('\n') || 'No slides.', data: { name: deck.props.name, width: deck.props.width, height: deck.props.height, slides } };
    },
  }),
];

/** Layer bounds need no pixels except a raster's natural size, which layers placed by tools always set. */
const NO_PIXELS = { image: () => null, createCanvas: () => { throw new Error('not drawing'); } } as unknown as RenderHost;

/** The topmost visible layer with content at a canvas point (groups searched inside), or null. */
export function layerAt(state: import('@omnix/core').ProjectState, canvasId: string, x: number, y: number): SceneNode<'layer'> | null {
  const search = (parentId: string): SceneNode<'layer'> | null => {
    const layers = childrenOf(state, parentId).filter((n): n is SceneNode<'layer'> => n.type === 'layer' && (n as SceneNode<'layer'>).props.visible);
    for (const l of [...layers].reverse()) {
      if (l.props.layerType === 'group') {
        const inner = search(l.id);
        if (inner) return inner;
        continue;
      }
      // Fills and adjustments cover the whole canvas; they are never what a pin points at.
      if (!['raster', 'vector', 'text'].includes(l.props.layerType)) continue;
      const b = layerBounds(NO_PIXELS, state, l.id);
      if (b.width > 0 && b.height > 0 && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) return l;
    }
    return null;
  };
  return search(canvasId);
}

/** Whether any comment is pinned to this node. */
function commentsOn(state: import('@omnix/core').ProjectState, nodeId: string): boolean {
  const box = commentsContainer(state);
  return !!box && box.children.some((id) => (state.nodes[id] as SceneNode<'comment'> | undefined)?.props.anchor.nodeId === nodeId);
}
