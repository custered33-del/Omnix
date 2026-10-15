import { z } from 'zod';
import express from 'express';
import {
  applyOp,
  childrenOf,
  clipsOf,
  deckSlides,
  documentBlocks,
  inlineToPlain,
  makeNode,
  newSlideOps,
  primaryDocumentNodes,
  tracksOf,
  walk,
  zSelection,
  type Author,
  type Operation,
  type ProjectState,
  type SceneNode,
} from '@omnix/core';
import type { Services } from '../services.js';
import { useModule } from '../app.js';
import { h, requireUser } from '../http/middleware.js';
import { ProjectError } from '../projects/service.js';
import { defineTool, ToolError, zProjectId, type ToolDef } from '../mcp/registry.js';
import { registerToolProvider } from '../mcp/tools/index.js';
import { writeResult, zWriteResult } from '../mcp/tools/helpers.js';
import type { User } from '../auth/users.js';
import type { JobContext } from '../jobs/queue.js';
import { anthropicOf } from './anthropic.js';
import { runCommand } from './commands.js';
import { COMMAND_EXAMPLES, planCommand } from './nl/parser.js';
import { generativeExtendOps, generativeFillOps, imageProvider, imageProviders } from './generative.js';
import { runVideoFill, type VideoFillInput } from './videoFill.js';
import { loadReference, STYLE_ASPECTS, styleMatch, type StyleAspect } from './style.js';

/**
 * AI-native features exposed to people (REST, from the editors) and to Claude (MCP):
 * natural-language commands (48), generative fill and extend (46), style reference (47), and
 * cross-tool helpers (50): search across every tool and turn a document into slides.
 */

const zRegion = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(), shape: z.enum(['rect', 'ellipse']).default('rect') });
const zReference = z.object({ assetId: z.string().optional(), nodeId: z.string().optional() }).refine((r) => !!r.assetId || !!r.nodeId, 'Give a reference assetId or nodeId');
const zAspects = z.array(z.enum(STYLE_ASPECTS as [StyleAspect, ...StyleAspect[]]));

interface VideoFillJob extends VideoFillInput {
  /** How to land the result: commit (a person, or Claude in autonomous mode) or propose (Claude in approve mode). */
  apply: { author: Author; mode: 'commit' | 'propose'; via: 'ui' | 'mcp' | 'agent'; jobId?: string };
}

async function videoFillJob(services: Services, jc: JobContext<VideoFillJob>): Promise<unknown> {
  const input = jc.job.input;
  const state = await services.projects.state(input.projectId);
  const r = await runVideoFill(services, state, input, jc.job.ownerId, (f, m) => jc.progress(f, m), jc.signal);
  const label = `Generative fill on video${input.prompt ? `: ${input.prompt.slice(0, 50)}` : ''}`;
  const a = input.apply;
  if (a.mode === 'propose') {
    const p = await services.projects.propose(input.projectId, r.ops, { author: a.author, label, via: a.via, ...(a.jobId ? { jobId: a.jobId } : {}) });
    return { assetId: r.assetId, frames: r.frames, proposalId: p.id };
  }
  const c = await services.projects.commit(input.projectId, r.ops.length === 1 ? r.ops[0]! : { kind: 'batch', ops: r.ops }, a.author, { label, via: a.via, jobId: a.jobId ?? jc.job.id });
  return { assetId: r.assetId, frames: r.frames, commitId: c.id };
}

/** Cross-tool search: text in layers, clips, titles, blocks, slides, code, notes and comments. */
export function searchProject(state: ProjectState, query: string, limit = 50): { nodeId: string; type: string; tool: string | null; documentId: string | null; label: string; snippet: string }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: ReturnType<typeof searchProject> = [];
  const docOf = (id: string): { id: string; tool: string } | null => {
    let cur: SceneNode | undefined = state.nodes[id];
    while (cur) {
      if (cur.type === 'canvas') return { id: cur.id, tool: 'image' };
      if (cur.type === 'sequence') return { id: cur.id, tool: (cur as SceneNode<'sequence'>).props.purpose };
      if (cur.type === 'codeWorkspace') return { id: cur.id, tool: 'code' };
      if (cur.type === 'document') return { id: cur.id, tool: 'document' };
      if (cur.type === 'deck') return { id: cur.id, tool: 'slides' };
      cur = cur.parentId ? state.nodes[cur.parentId] : undefined;
    }
    return null;
  };
  const snippet = (text: string) => {
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return text.slice(0, 120);
    const a = Math.max(0, i - 50);
    return `${a > 0 ? '…' : ''}${text.slice(a, i + q.length + 70).replace(/\s+/g, ' ')}${i + q.length + 70 < text.length ? '…' : ''}`;
  };
  walk(state, state.rootId, (n) => {
    if (hits.length >= limit) return false;
    const p = n.props as Record<string, unknown>;
    const texts: string[] = [];
    for (const k of ['name', 'text', 'path', 'content', 'source', 'notes', 'caption']) if (typeof p[k] === 'string') texts.push(k === 'text' && n.type !== 'codeFile' ? inlineToPlain(p[k] as string) : (p[k] as string));
    if (n.type === 'clip' && (n as SceneNode<'clip'>).props.title) texts.push((n as SceneNode<'clip'>).props.title!.text);
    if (n.type === 'block' && (n as SceneNode<'block'>).props.rows) texts.push(((n as SceneNode<'block'>).props.rows ?? []).flat().join(' '));
    const hit = texts.find((t) => t.toLowerCase().includes(q));
    if (!hit) return;
    const d = docOf(n.id);
    hits.push({ nodeId: n.id, type: n.type, tool: d?.tool ?? null, documentId: d?.id ?? null, label: String(p.name ?? p.path ?? n.type), snippet: snippet(hit) });
  });
  return hits;
}

/** Slides from a document: one slide per heading, with the text under it as bullet points. */
export function slidesFromDocumentOps(state: ProjectState, documentId: string, deckId: string | null, maxSlides = 20): { ops: Operation[]; deckId: string; slides: number } {
  const doc = state.nodes[documentId] as SceneNode<'document'> | undefined;
  if (!doc || doc.type !== 'document') throw new Error('Choose a document.');
  const blocks = documentBlocks(state, documentId);
  const sections: { title: string; points: string[] }[] = [];
  let cur: { title: string; points: string[] } | null = null;
  const topLevel = Math.min(...blocks.filter((b) => b.props.blockType === 'heading').map((b) => b.props.level ?? 1), 9);
  for (const b of blocks) {
    const text = inlineToPlain(b.props.text).trim();
    if (b.props.blockType === 'heading' && (b.props.level ?? 1) <= Math.max(topLevel, 2)) {
      cur = { title: text, points: [] };
      sections.push(cur);
    } else if (text && ['paragraph', 'bullet', 'numbered', 'quote', 'todo', 'heading'].includes(b.props.blockType)) {
      if (!cur) {
        cur = { title: doc.props.name, points: [] };
        sections.push(cur);
      }
      // Long paragraphs become their first sentence; slides want short points.
      const point = b.props.blockType === 'paragraph' && text.length > 140 ? (text.match(/^.+?[.!?](?:\s|$)/)?.[0] ?? text.slice(0, 137) + '…').trim() : text;
      if (cur.points.length < 6) cur.points.push(point);
    }
  }
  // The title slide already carries the document's name.
  const useful = sections.filter((x, i) => !(i === 0 && !x.points.length && x.title.toLowerCase() === doc.props.name.toLowerCase()));
  sections.splice(0, sections.length, ...useful);
  if (!sections.length) throw new Error('The document has no headings or text to turn into slides.');
  // A one-line introduction under the document's own title becomes the title slide's subtitle.
  let intro: string | null = null;
  if (!deckId && sections.length > 1 && sections[0]!.title.toLowerCase() === doc.props.name.toLowerCase() && sections[0]!.points.length === 1) intro = sections.shift()!.points[0]!;
  const ops: Operation[] = [];
  let working = state;
  let targetDeck = deckId;
  if (!targetDeck) {
    const nodes = primaryDocumentNodes('slides', `${doc.props.name} (slides)`);
    nodes[0]!.parentId = state.rootId;
    ops.push({ kind: 'create', parentId: state.rootId, nodes });
    targetDeck = nodes[0]!.id;
    // Use the starter title slide for the document title.
    const titleEl = nodes.find((n) => n.type === 'slideElement' && (n as SceneNode<'slideElement'>).props.role === 'title');
    if (titleEl) (titleEl as SceneNode<'slideElement'>).props.text = doc.props.name;
    const sub = nodes.find((n) => n.type === 'slideElement' && (n as SceneNode<'slideElement'>).props.role === 'subtitle');
    if (sub) (sub as SceneNode<'slideElement'>).props.text = intro ?? (sections[0]?.title === doc.props.name ? '' : `${sections.length} sections`);
    working = applyOp(working, ops[0]!).state;
  } else if (!state.nodes[targetDeck] || state.nodes[targetDeck]!.type !== 'deck') throw new Error('Choose a slideshow.');
  let index = deckSlides(working, targetDeck).length;
  for (const s of sections.slice(0, maxSlides)) {
    const r = newSlideOps(working, targetDeck, s.points.length ? 'title-body' : 'section', { index, name: s.title.slice(0, 60), text: { title: s.title, body: s.points.map((p) => `- ${p}`).join('\n'), subtitle: '' } });
    ops.push(r.op);
    index++;
    working = applyOp(working, r.op).state;
  }
  // Every slide added, counting the title slide a new deck starts with.
  return { ops, deckId: targetDeck, slides: Math.min(sections.length, maxSlides) + (deckId ? 0 : 1) };
}

/** Change a video's frame size, filling around each shot with a blurred, darker copy of it. */
export async function reframeOps(services: Services, state: ProjectState, sequenceId: string, width: number, height: number, fill: 'blur' | 'none'): Promise<{ ops: Operation[]; fillClips: number }> {
  const seq = state.nodes[sequenceId] as SceneNode<'sequence'> | undefined;
  if (!seq || seq.type !== 'sequence' || seq.props.purpose !== 'video') throw new Error('sequenceId is not a video sequence.');
  const ops: Operation[] = [{ kind: 'update', id: seq.id, set: { width, height } }];
  let n = 0;
  if (fill === 'blur') {
    const video = tracksOf(state, seq.id).filter((t) => t.props.trackType === 'video');
    const fillTrack = makeNode('track', { name: 'Frame fill', trackType: 'video' });
    const lastVideo = video[video.length - 1];
    const fillOps: Operation[] = [];
    for (const t of video)
      for (const c of clipsOf(state, t.id)) {
        if (!c.props.assetId) continue;
        const a = await services.assets.get(c.props.assetId);
        if (!a?.width || !a.height) continue;
        const contain = Math.min(width / a.width, height / a.height);
        const cover = Math.max(width / a.width, height / a.height);
        if (cover / contain < 1.01) continue;
        const copy = makeNode('clip', { ...structuredClone(c.props), name: `${c.props.name} (fill)`, scale: (cover / contain) * 1.06, x: 0, y: 0, volume: -60, keyframes: {}, effects: [{ id: `fx_fill${n}`, effect: 'gaussianBlur', params: { radius: 28 }, enabled: true }, { id: `fx_dim${n}`, effect: 'colorGrade', params: { exposure: -0.6, contrast: 0, saturation: -15, temperature: 0, tint: 0, intensity: 1 }, enabled: true }], title: null, generation: null });
        fillOps.push({ kind: 'create', parentId: fillTrack.id, nodes: [copy] });
        n++;
      }
    if (n) ops.push({ kind: 'create', parentId: seq.id, index: lastVideo ? seq.children.indexOf(lastVideo.id) + 1 : seq.children.length, nodes: [fillTrack] }, ...fillOps);
  }
  return { ops, fillClips: n };
}

function aiTools(services: Services): ToolDef[] {
  const asTool = (e: unknown): never => {
    if (e instanceof ToolError) throw e;
    throw new ToolError(e instanceof Error ? e.message : String(e));
  };
  return [
    defineTool({
      name: 'run_command',
      title: 'Run a natural-language command',
      description: `Turn a plain-language edit into operations with Omnix's command parser, for example "make the sky warmer and move the title to the lower third". The steps follow the connection's permission mode like any change. Phrases the parser does not understand are returned so you can do them with the specific tools. Examples: ${Object.values(COMMAND_EXAMPLES).flat().slice(0, 8).join('; ')}.`,
      category: 'ai',
      access: 'write',
      destructive: true,
      input: { projectId: zProjectId, text: z.string().min(1).max(2000), documentId: z.string().optional().describe('The image, sequence, deck or document to edit (default: the first one).'), slideId: z.string().optional(), selection: z.array(z.string()).max(50).optional() },
      output: zWriteResult.extend({ steps: z.array(z.string()), unmatched: z.array(z.object({ clause: z.string(), reason: z.string() })) }),
      example: { input: { projectId: 'prj_8Kq2...', documentId: 'cnv_1', text: 'Make the sky warmer and move the title to the lower third' }, output: { status: 'proposed', proposalId: 'prop_1c...', steps: ['Warmer: the sky', 'Move the title to the lower third'], unmatched: [] } },
      async handler(args, ctx) {
        await ctx.requireProject(args.projectId, 'write');
        const state = await ctx.state(args.projectId);
        const documentId = args.documentId ?? childrenOf(state, state.rootId).find((n) => ['canvas', 'sequence', 'deck', 'document'].includes(n.type))?.id;
        if (!documentId) throw new ToolError('The project has no image, video, animation, slideshow or document.');
        const plan = await planCommand(args.text, state, { services, projectId: args.projectId, documentId, selection: args.selection ?? [], slideId: args.slideId ?? null, time: null, ownerId: ctx.principal.user.id }).catch(asTool);
        if (!plan.steps.length) return { text: `Nothing applied. ${plan.unmatched.map((u) => u.reason).join(' ')}`, data: { status: 'none', steps: [], unmatched: plan.unmatched } };
        const out = await ctx.apply(args.projectId, plan.steps.flatMap((s) => s.ops), plan.steps.length === 1 ? plan.steps[0]!.label : `“${args.text.slice(0, 60)}”`, `Steps: ${plan.steps.map((s) => s.label).join('; ')}`);
        return writeResult(out, { steps: plan.steps.map((s) => s.label), unmatched: plan.unmatched }, plan.unmatched.length ? `Not understood: ${plan.unmatched.map((u) => `"${u.clause}" (${u.reason})`).join('; ')}` : undefined);
      },
    }),
    defineTool({
      name: 'image_generative_fill',
      title: 'Generative fill (image)',
      description:
        'Fill an area of the image from a prompt: remove an object, replace a sky, patch a gap. The result is a new layer masked to the area, so the generated region stays visible and editable. With no image model configured, Omnix synthesizes the area from its surroundings (best for removing things); a color in the prompt tints it.',
      category: 'ai',
      access: 'write',
      input: { projectId: zProjectId, canvasId: z.string(), prompt: z.string().max(2000).default(''), selection: zSelection.optional().describe('Area to fill (default: the current selection).'), provider: z.string().optional().describe('Image provider id (see get_ai_capabilities).') },
      output: zWriteResult.extend({ layerId: z.string(), provider: z.string(), maskAssetId: z.string() }),
      example: { input: { projectId: 'prj_8Kq2...', canvasId: 'cnv_1', prompt: 'clear evening sky', selection: { kind: 'rect', x: 0, y: 0, width: 1920, height: 400 } }, output: { status: 'proposed', proposalId: 'prop_4d...', layerId: 'lyr_gen...', provider: 'builtin', maskAssetId: 'a9f...' } },
      async handler(args, ctx) {
        await ctx.requireProject(args.projectId, 'write');
        const state = await ctx.state(args.projectId);
        const canvas = state.nodes[args.canvasId] as SceneNode<'canvas'> | undefined;
        if (!canvas || canvas.type !== 'canvas') throw new ToolError('canvasId is not an image canvas.');
        const sel = args.selection ?? canvas.props.selection;
        if (!sel) throw new ToolError('Select the area first, or pass selection.');
        const r = await generativeFillOps(services, state, canvas.id, sel, args.prompt, { providerId: args.provider ?? null, projectId: args.projectId, ownerId: ctx.principal.user.id }).catch(asTool);
        const out = await ctx.apply(args.projectId, r.ops, args.prompt ? `Generative fill: ${args.prompt.slice(0, 50)}` : 'Generative fill');
        return writeResult(out, { layerId: r.layerId, provider: r.provider, maskAssetId: r.maskAssetId });
      },
    }),
    defineTool({
      name: 'image_generative_extend',
      title: 'Generative extend (image)',
      description: 'Grow the canvas and fill the new margins so the picture continues past its edges (outpainting), for example to turn a square photo into a wide banner. Existing layers keep their place; the new area is a masked layer you can see and adjust.',
      category: 'ai',
      access: 'write',
      input: { projectId: zProjectId, canvasId: z.string(), top: z.number().int().min(0).max(4096).default(0), right: z.number().int().min(0).max(4096).default(0), bottom: z.number().int().min(0).max(4096).default(0), left: z.number().int().min(0).max(4096).default(0), prompt: z.string().max(2000).default(''), provider: z.string().optional() },
      output: zWriteResult.extend({ layerId: z.string(), width: z.number(), height: z.number() }),
      example: { input: { projectId: 'prj_8Kq2...', canvasId: 'cnv_1', left: 420, right: 420, prompt: 'more of the beach' }, output: { status: 'committed', commitId: 'c_8e...', layerId: 'lyr_ext...', width: 1920, height: 1080 } },
      async handler(args, ctx) {
        await ctx.requireProject(args.projectId, 'write');
        const state = await ctx.state(args.projectId);
        const canvas = state.nodes[args.canvasId];
        if (!canvas || canvas.type !== 'canvas') throw new ToolError('canvasId is not an image canvas.');
        const r = await generativeExtendOps(services, state, canvas.id, { top: args.top, right: args.right, bottom: args.bottom, left: args.left }, args.prompt, { providerId: args.provider ?? null, projectId: args.projectId, ownerId: ctx.principal.user.id }).catch(asTool);
        const out = await ctx.apply(args.projectId, r.ops, `Generative extend to ${r.width}×${r.height}`);
        return writeResult(out, { layerId: r.layerId, width: r.width, height: r.height });
      },
    }),
    defineTool({
      name: 'video_generative_fill',
      title: 'Generative fill (video region)',
      description:
        'Fill a region of a video clip across its frames (remove a logo, watermark or passer-by) from a prompt. Region is in sequence pixels as seen on the stage. Runs as a background job; the clip then plays the new render, and the original media and the region are kept with the clip. Check progress with get_job.',
      category: 'ai',
      access: 'write',
      input: { projectId: zProjectId, clipId: z.string(), region: zRegion, prompt: z.string().max(2000).default(''), provider: z.string().optional() },
      output: z.object({ jobId: z.string() }),
      example: { input: { projectId: 'prj_8Kq2...', clipId: 'clp_2', region: { x: 1620, y: 40, width: 240, height: 90, shape: 'rect' }, prompt: 'remove the watermark' }, output: { jobId: 'job_9c...' } },
      async handler(args, ctx) {
        const meta = await ctx.requireProject(args.projectId, 'write');
        if (ctx.principal.mode === 'view') throw new ToolError('This connection is view-only.');
        const state = await ctx.state(args.projectId);
        const clip = state.nodes[args.clipId];
        if (!clip || clip.type !== 'clip' || !(clip as SceneNode<'clip'>).props.assetId) throw new ToolError('clipId is not a video clip.');
        const job = await services.jobs.enqueue<VideoFillJob>('video-fill', { projectId: args.projectId, clipId: args.clipId, region: args.region, prompt: args.prompt, providerId: args.provider ?? null, apply: { author: ctx.principal.author, mode: ctx.principal.mode === 'autonomous' ? 'commit' : 'propose', via: ctx.via, ...(ctx.jobId ? { jobId: ctx.jobId } : {}) } }, { title: `Generative fill on "${(clip as SceneNode<'clip'>).props.name}"`, ownerId: ctx.principal.user.id, projectId: meta.id });
        return { text: `Started job ${job.id}. The result lands as ${ctx.principal.mode === 'autonomous' ? 'a change' : 'a proposal'} when it finishes; check with get_job.`, data: { jobId: job.id } };
      },
    }),
    defineTool({
      name: 'video_extend_frame',
      title: 'Extend the video frame',
      description: 'Change a sequence to a new frame size (for example 16:9 to 9:16) and fill the space around each shot with a blurred, darkened copy of the same shot, a common way to extend footage without black bars. The fill clips sit on their own track and can be adjusted or removed.',
      category: 'video',
      access: 'write',
      input: { projectId: zProjectId, sequenceId: z.string(), width: z.number().int().min(16).max(8192), height: z.number().int().min(16).max(8192), fill: z.enum(['blur', 'none']).default('blur') },
      output: zWriteResult.extend({ fillClips: z.number() }),
      example: { input: { projectId: 'prj_8Kq2...', sequenceId: 'seq_main', width: 1080, height: 1920 }, output: { status: 'proposed', proposalId: 'prop_2f...', fillClips: 6 } },
      async handler(args, ctx) {
        await ctx.requireProject(args.projectId, 'write');
        const state = await ctx.state(args.projectId);
        let r;
        try {
          r = await reframeOps(services, state, args.sequenceId, args.width, args.height, args.fill);
        } catch (e) {
          asTool(e);
        }
        const { ops, fillClips: n } = r!;
        const out = await ctx.apply(args.projectId, ops, `Extend the frame to ${args.width}×${args.height}`);
        return writeResult(out, { fillClips: n });
      },
    }),
    defineTool({
      name: 'style_match',
      title: 'Match a style reference',
      description:
        'Apply the look of a reference (an image or video asset, or a canvas, layer, clip, sequence, slideshow, slide or document in the project) to a target in any editor. Aspects: color, tone, texture (grain), typography (fonts) and motion (easing, transitions, timing). Results are ordinary editable settings: a look adjustment layer or color grade, a grain filter, theme or text styles, easing.',
      category: 'ai',
      access: 'write',
      input: { projectId: zProjectId, nodeId: z.string().describe('What to restyle: a canvas, layer, clip, sequence, deck, slide or document'), reference: zReference, aspects: zAspects.optional().describe('Default: everything that applies.'), strength: z.number().min(0).max(1).default(0.8) },
      output: zWriteResult.extend({ applied: z.array(z.string()), skipped: z.array(z.string()) }),
      example: { input: { projectId: 'prj_8Kq2...', nodeId: 'seq_main', reference: { assetId: 'a7c...' }, aspects: ['color', 'tone'], strength: 0.7 }, output: { status: 'proposed', proposalId: 'prop_5b...', applied: ['color and tone (a color grade with the reference look)'], skipped: [] } },
      async handler(args, ctx) {
        await ctx.requireProject(args.projectId, 'write');
        const state = await ctx.state(args.projectId);
        const ref = await loadReference(services, state, args.reference).catch(asTool);
        const r = await styleMatch(services, state, { targetId: args.nodeId, reference: ref, aspects: args.aspects ?? [], strength: args.strength, projectId: args.projectId, ownerId: ctx.principal.user.id }).catch(asTool);
        if (!r.ops.length) return { text: `Nothing to apply. ${r.skipped.join('. ')}`, data: { status: 'none', applied: [], skipped: r.skipped } };
        const out = await ctx.apply(args.projectId, r.ops, `Match style of ${ref.label}`);
        return writeResult(out, { applied: r.applied, skipped: r.skipped });
      },
    }),
    defineTool({
      name: 'find_in_project',
      title: 'Search the whole project',
      description: 'Find text anywhere in a project, across all six tools: layer names and text, clip names and titles, document blocks, slide text and notes, code files and cells, session notes and comments. Use it to connect work across tools (for example find the tagline in the document to reuse in a title).',
      category: 'project',
      access: 'read',
      input: { projectId: zProjectId, query: z.string().min(1).max(200), limit: z.number().int().min(1).max(200).default(50) },
      output: z.object({ hits: z.array(z.object({ nodeId: z.string(), type: z.string(), tool: z.string().nullable(), documentId: z.string().nullable(), label: z.string(), snippet: z.string() })) }),
      example: { input: { projectId: 'prj_8Kq2...', query: 'launch date' }, output: { hits: [{ nodeId: 'blk_4', type: 'block', tool: 'document', documentId: 'doc_brief', label: 'block', snippet: '…the launch date is 14 March…' }] } },
      async handler(args, ctx) {
        await ctx.requireProject(args.projectId, 'read');
        const hits = searchProject(await ctx.state(args.projectId), args.query, args.limit);
        return { text: hits.length ? hits.map((h) => `${h.tool ?? 'project'} ${h.type} ${h.nodeId}: ${h.snippet}`).join('\n') : 'No matches.', data: { hits } };
      },
    }),
    defineTool({
      name: 'slides_from_document',
      title: 'Make slides from a document',
      description: 'Turn a document into slides: one slide per heading with the text under it as short bullet points. Adds to an existing slideshow (deckId) or creates a new one.',
      category: 'slides',
      access: 'write',
      input: { projectId: zProjectId, documentId: z.string(), deckId: z.string().optional(), maxSlides: z.number().int().min(1).max(60).default(20) },
      output: zWriteResult.extend({ deckId: z.string(), slides: z.number() }),
      example: { input: { projectId: 'prj_8Kq2...', documentId: 'doc_brief' }, output: { status: 'proposed', proposalId: 'prop_7a...', deckId: 'dck_new...', slides: 6 } },
      async handler(args, ctx) {
        await ctx.requireProject(args.projectId, 'write');
        const state = await ctx.state(args.projectId);
        let r;
        try {
          r = slidesFromDocumentOps(state, args.documentId, args.deckId ?? null, args.maxSlides);
        } catch (e) {
          asTool(e);
        }
        const out = await ctx.apply(args.projectId, r!.ops, `Slides from "${(state.nodes[args.documentId] as SceneNode<'document'>).props.name}"`);
        return writeResult(out, { deckId: r!.deckId, slides: r!.slides });
      },
    }),
    defineTool({
      name: 'get_job',
      title: 'Check a background job',
      description: 'Status, progress and result of a background job (exports, captions, video fill, agent runs).',
      category: 'project',
      access: 'read',
      input: { jobId: z.string() },
      output: z.object({ id: z.string(), kind: z.string(), status: z.string(), progress: z.number(), message: z.string(), result: z.unknown(), error: z.string().nullable() }),
      example: { input: { jobId: 'job_9c...' }, output: { id: 'job_9c...', kind: 'video-fill', status: 'running', progress: 0.4, message: 'Filling frame 120 of 300', result: null, error: null } },
      async handler(args, ctx) {
        const j = services.jobs.get(args.jobId);
        if (!j || j.ownerId !== ctx.principal.user.id) throw new ToolError('Job not found.');
        const data = { id: j.id, kind: j.kind, status: j.status, progress: j.progress, message: j.message, result: j.result, error: j.error };
        return { text: `${j.title}: ${j.status}${j.status === 'running' ? ` (${Math.round(j.progress * 100)}%, ${j.message})` : ''}${j.error ? `: ${j.error}` : ''}`, data };
      },
    }),
    defineTool({
      name: 'get_ai_capabilities',
      title: 'What AI features are available',
      description: 'Which image providers can do generative fill and extend here, whether the built-in agent runner is configured, and example natural-language commands per editor.',
      category: 'ai',
      access: 'read',
      input: {},
      output: z.object({ imageProviders: z.array(z.object({ id: z.string(), label: z.string(), generative: z.boolean() })), agentRunner: z.boolean(), commandExamples: z.record(z.string(), z.array(z.string())) }),
      example: { input: {}, output: { imageProviders: [{ id: 'builtin', label: 'Built-in (fills from the surroundings)', generative: false }], agentRunner: false, commandExamples: { image: ['Make the sky warmer'] } } },
      async handler() {
        const data = { imageProviders: imageProviders(services).map((p) => ({ id: p.id, label: p.label, generative: p.generative })), agentRunner: !!anthropicOf(services), commandExamples: COMMAND_EXAMPLES };
        return { text: `Image providers: ${data.imageProviders.map((p) => p.label).join(', ')}. Built-in agent runner: ${data.agentRunner ? 'available' : 'not configured'}.`, data };
      },
    }),
  ] as unknown as ToolDef[];
}

/** People's own actions from the editors commit directly (they can undo); outside AI models need the project's consent. */
async function humanEdit(services: Services, user: User, projectId: string, ops: Operation[], label: string): Promise<string> {
  const op: Operation = ops.length === 1 ? ops[0]! : { kind: 'batch', ops };
  const c = await services.projects.commit(projectId, op, { type: 'human', id: user.id, name: user.name }, { label, via: 'ui' });
  return c.id;
}

async function requireProviderConsent(services: Services, projectId: string, providerId: string | null | undefined): Promise<void> {
  const p = imageProvider(services, providerId);
  if (p.id === 'builtin') return;
  const meta = await services.projects.getMeta(projectId);
  if (!meta.aiConsent) throw new ProjectError(`Generating with ${p.label} sends this part of the image to an AI model. Turn on "Allow AI" for this project first, or use the built-in fill.`, 403);
}

useModule(({ services, router }) => {
  registerToolProvider(services, aiTools);
  services.jobs.register<VideoFillJob, unknown>('video-fill', (jc) => videoFillJob(services, jc));
  const bad = (e: unknown): never => {
    if (e instanceof ProjectError) throw e;
    throw new ProjectError(e instanceof Error ? e.message : String(e), 400);
  };
  const r = express.Router();

  r.get(
    '/ai/capabilities',
    h(async (req, res) => {
      requireUser(req);
      res.json({ claude: !!anthropicOf(services), imageProviders: imageProviders(services).map((p) => ({ id: p.id, label: p.label, generative: p.generative })), commandExamples: COMMAND_EXAMPLES, styleAspects: STYLE_ASPECTS });
    }),
  );

  r.post(
    '/projects/:id/commands',
    h(async (req, res) => {
      const user = requireUser(req);
      const body = z.object({ text: z.string().min(1).max(2000), documentId: z.string().nullable().optional(), selection: z.array(z.string()).max(200).optional(), slideId: z.string().nullable().optional(), time: z.number().nullable().optional(), allowClaude: z.boolean().optional() }).parse(req.body);
      res.json(await runCommand(services, user, { projectId: String(req.params.id), ...body }).catch(bad));
    }),
  );

  r.post(
    '/projects/:id/generative/fill',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      const body = z.object({ canvasId: z.string(), prompt: z.string().max(2000).default(''), selection: zSelection.optional(), provider: z.string().nullable().optional(), replaceLayerId: z.string().optional() }).parse(req.body);
      await services.projects.requireAccess(projectId, user.id, 'write');
      await requireProviderConsent(services, projectId, body.provider);
      const state = await services.projects.state(projectId);
      const canvas = state.nodes[body.canvasId] as SceneNode<'canvas'> | undefined;
      if (!canvas || canvas.type !== 'canvas') throw new ProjectError('Not an image canvas', 400);
      // Regenerate: same area as an earlier generated layer, which the new result replaces in place.
      const old = body.replaceLayerId ? (state.nodes[body.replaceLayerId] as SceneNode<'layer'> | undefined) : undefined;
      if (body.replaceLayerId && !old?.props.generation?.maskAssetId) throw new ProjectError('That layer was not generated', 400);
      let base = state;
      if (old) base = applyOp(state, { kind: 'update', id: old.id, set: { visible: false } }).state;
      const sel = body.selection ?? (old ? { kind: 'mask' as const, assetId: old.props.generation!.maskAssetId! } : canvas.props.selection);
      if (!sel) throw new ProjectError('Select the area to fill first.', 400);
      const r2 = await generativeFillOps(services, base, canvas.id, sel, body.prompt, { providerId: body.provider ?? null, projectId, ownerId: user.id }).catch(bad);
      const ops: Operation[] = old
        ? [{ kind: 'delete', id: old.id }, ...r2.ops.map((o) => (o.kind === 'create' ? { ...o, parentId: old.parentId!, index: state.nodes[old.parentId!]!.children.indexOf(old.id) } : o))]
        : [...r2.ops, { kind: 'update', id: canvas.id, set: { selection: null } }];
      const commitId = await humanEdit(services, user, projectId, ops, body.prompt ? `Generative fill: ${body.prompt.slice(0, 50)}` : 'Generative fill');
      res.json({ commitId, layerId: r2.layerId, provider: r2.provider });
    }),
  );

  r.post(
    '/projects/:id/generative/extend',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      const body = z.object({ canvasId: z.string(), top: z.number().int().min(0).max(4096).default(0), right: z.number().int().min(0).max(4096).default(0), bottom: z.number().int().min(0).max(4096).default(0), left: z.number().int().min(0).max(4096).default(0), prompt: z.string().max(2000).default(''), provider: z.string().nullable().optional() }).parse(req.body);
      await services.projects.requireAccess(projectId, user.id, 'write');
      await requireProviderConsent(services, projectId, body.provider);
      const state = await services.projects.state(projectId);
      if (state.nodes[body.canvasId]?.type !== 'canvas') throw new ProjectError('Not an image canvas', 400);
      const r2 = await generativeExtendOps(services, state, body.canvasId, { top: body.top, right: body.right, bottom: body.bottom, left: body.left }, body.prompt, { providerId: body.provider ?? null, projectId, ownerId: user.id }).catch(bad);
      const commitId = await humanEdit(services, user, projectId, r2.ops, `Generative extend to ${r2.width}×${r2.height}`);
      res.json({ commitId, layerId: r2.layerId, width: r2.width, height: r2.height });
    }),
  );

  r.post(
    '/projects/:id/generative/video-fill',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      const body = z.object({ clipId: z.string(), region: zRegion, prompt: z.string().max(2000).default(''), provider: z.string().nullable().optional() }).parse(req.body);
      await services.projects.requireAccess(projectId, user.id, 'write');
      await requireProviderConsent(services, projectId, body.provider);
      const state = await services.projects.state(projectId);
      const clip = state.nodes[body.clipId] as SceneNode<'clip'> | undefined;
      if (!clip || clip.type !== 'clip' || !clip.props.assetId) throw new ProjectError('Choose a video clip', 400);
      const job = await services.jobs.enqueue<VideoFillJob>('video-fill', { projectId, clipId: body.clipId, region: body.region, prompt: body.prompt, providerId: body.provider ?? null, apply: { author: { type: 'human', id: user.id, name: user.name }, mode: 'commit', via: 'ui' } }, { title: `Generative fill on "${clip.props.name}"`, ownerId: user.id, projectId });
      res.status(202).json({ jobId: job.id });
    }),
  );

  r.post(
    '/projects/:id/style-match',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      const body = z.object({ targetId: z.string(), reference: zReference, aspects: zAspects.optional(), strength: z.number().min(0).max(1).default(0.8) }).parse(req.body);
      await services.projects.requireAccess(projectId, user.id, 'write');
      const state = await services.projects.state(projectId);
      const ref = await loadReference(services, state, body.reference).catch(bad);
      const r2 = await styleMatch(services, state, { targetId: body.targetId, reference: ref, aspects: body.aspects ?? [], strength: body.strength, projectId, ownerId: user.id }).catch(bad);
      const commitId = r2.ops.length ? await humanEdit(services, user, projectId, r2.ops, `Match style of ${ref.label}`) : null;
      res.json({ commitId, applied: r2.applied, skipped: r2.skipped });
    }),
  );

  r.post(
    '/projects/:id/slides-from-document',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      const body = z.object({ documentId: z.string(), deckId: z.string().nullable().optional(), maxSlides: z.number().int().min(1).max(60).default(20) }).parse(req.body);
      await services.projects.requireAccess(projectId, user.id, 'write');
      const state = await services.projects.state(projectId);
      let r2;
      try {
        r2 = slidesFromDocumentOps(state, body.documentId, body.deckId ?? null, body.maxSlides);
      } catch (e) {
        bad(e);
      }
      const commitId = await humanEdit(services, user, projectId, r2!.ops, `Slides from "${(state.nodes[body.documentId] as SceneNode<'document'>).props.name}"`);
      res.json({ commitId, deckId: r2!.deckId, slides: r2!.slides });
    }),
  );

  r.post(
    '/projects/:id/video/reframe',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      const body = z.object({ sequenceId: z.string(), width: z.number().int().min(16).max(8192), height: z.number().int().min(16).max(8192), fill: z.enum(['blur', 'none']).default('blur') }).parse(req.body);
      await services.projects.requireAccess(projectId, user.id, 'write');
      const state = await services.projects.state(projectId);
      const r2 = await reframeOps(services, state, body.sequenceId, body.width, body.height, body.fill).catch(bad);
      const commitId = await humanEdit(services, user, projectId, r2.ops, `Reframe to ${body.width}×${body.height}`);
      res.json({ commitId, fillClips: r2.fillClips });
    }),
  );

  r.get(
    '/projects/:id/search',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      await services.projects.requireAccess(projectId, user.id, 'read');
      res.json({ hits: searchProject(await services.projects.state(projectId), String(req.query.q ?? ''), 100) });
    }),
  );

  router.use(r);
});

