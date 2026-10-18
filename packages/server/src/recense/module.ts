import { z } from 'zod';
import express from 'express';
import {
  autoEditOps,
  beatEffectOps,
  clipEnd,
  clipsOf,
  detectBeats,
  EDIT_FX_KINDS,
  EDIT_STYLE_NAMES,
  EDIT_STYLES,
  requireNodeOfType,
  setBeatsOp,
  tracksOf,
  type EditFxKind,
  type EditSource,
  type EditStyle,
  type Operation,
  type ProjectState,
  type SceneNode,
} from '@omnix/core';
import { useModule } from '../app.js';
import type { Services } from '../services.js';
import { h, requireUser } from '../http/middleware.js';
import { ProjectError } from '../projects/service.js';
import { decodeAudioMono } from '../util/media.js';
import { defineTool, ToolError, zProjectId, type ToolDef } from '../mcp/registry.js';
import { registerToolProvider } from '../mcp/tools/index.js';
import { writeResult, zWriteResult } from '../mcp/tools/helpers.js';

/**
 * Recense: edits (fast, beat-synced videos). The server finds the beats of the music, because that
 * needs ffmpeg; cutting and effects are core builders, so the app and the AI tools make the same edits.
 */

const RATE = 11025;
const beatCache = new Map<string, { bpm: number; beats: number[] }>();

/** The clip whose music sets the beat: the one asked for, else the first clip on an audio track. */
function musicClip(state: ProjectState, sequenceId: string, clipId?: string): SceneNode<'clip'> | null {
  if (clipId) return requireNodeOfType(state, clipId, 'clip');
  const tracks = tracksOf(state, sequenceId);
  for (const t of tracks.filter((x) => x.props.trackType === 'audio')) for (const c of clipsOf(state, t.id)) if (c.props.assetId) return c;
  for (const t of tracks.filter((x) => x.props.trackType === 'video')) for (const c of clipsOf(state, t.id)) if (c.props.assetId) return c;
  return null;
}

export async function findBeats(services: Services, state: ProjectState, sequenceId: string, clipId?: string): Promise<{ bpm: number; beats: number[]; clip: string }> {
  requireNodeOfType(state, sequenceId, 'sequence');
  const clip = musicClip(state, sequenceId, clipId);
  if (!clip?.props.assetId) throw new Error('Add a song first: drop music on the Music track, then find the beats.');
  const asset = await services.assets.get(clip.props.assetId);
  if (!asset || asset.hasAudio === false) throw new Error(`"${clip.props.name}" has no sound to find beats in.`);
  const key = `${asset.id}:${clip.props.in}:${clip.props.out}`;
  let found = beatCache.get(key);
  if (!found) {
    const file = await services.blobs.localPath(asset.id);
    const full = await decodeAudioMono(services.config.ffmpegPath, file, RATE);
    const a = Math.max(0, Math.floor(clip.props.in * RATE));
    const b = Math.min(full.length, Math.ceil(clip.props.out * RATE));
    const r = detectBeats(full.subarray(a, b), RATE);
    found = { bpm: r.bpm, beats: r.beats };
    beatCache.set(key, found);
    if (beatCache.size > 50) beatCache.delete(beatCache.keys().next().value!);
  }
  // Source time to timeline time (a sped-up song has faster beats).
  const p = clip.props;
  const beats = found.beats.map((s) => Math.round((p.start + s / p.speed) * 1000) / 1000).filter((t) => t <= clipEnd(p) + 1e-6);
  return { bpm: Math.round(found.bpm * p.speed * 10) / 10, beats, clip: clip.props.name };
}

/** The shots for an auto edit: the given assets, or the pictures and videos already in the edit. */
async function editSources(services: Services, state: ProjectState, sequenceId: string, assetIds?: string[]): Promise<{ sources: EditSource[]; sizes: Record<string, { width: number; height: number }> }> {
  const ids: string[] = [];
  if (assetIds?.length) ids.push(...assetIds);
  else
    for (const t of tracksOf(state, sequenceId).filter((x) => x.props.trackType === 'video' && x.props.name !== 'Overlays'))
      for (const c of clipsOf(state, t.id)) if (c.props.assetId && !ids.includes(c.props.assetId)) ids.push(c.props.assetId);
  const sources: EditSource[] = [];
  const sizes: Record<string, { width: number; height: number }> = {};
  for (const id of ids) {
    const a = await services.assets.get(id);
    if (!a || (a.kind !== 'video' && a.kind !== 'image')) continue;
    sources.push({ assetId: a.id, name: a.name, duration: a.kind === 'video' ? (a.duration ?? 0) : 0 });
    if (a.width && a.height) sizes[a.id] = { width: a.width, height: a.height };
  }
  if (!sources.length) throw new Error('Add some videos or pictures to the Clips track first.');
  return { sources, sizes };
}

/** A whole edit: the beats (found if needed), the shots cut to them and the style's effects. */
export async function autoEdit(services: Services, state: ProjectState, sequenceId: string, style: EditStyle, assetIds?: string[]): Promise<{ ops: Operation[]; cuts: number; effects: number; bpm: number | null }> {
  const seq = requireNodeOfType(state, sequenceId, 'sequence');
  const ops: Operation[] = [];
  let beats = seq.props.beats ?? [];
  let bpm = seq.props.bpm ?? null;
  if (beats.length < 2) {
    const r = await findBeats(services, state, sequenceId);
    beats = r.beats;
    bpm = r.bpm;
    ops.push(setBeatsOp(seq, r));
  }
  const { sources, sizes } = await editSources(services, state, sequenceId, assetIds);
  const r = autoEditOps(state, sequenceId, style, { sources, beats, sizes });
  ops.push(...r.ops);
  const end = beats[beats.length - 1] ?? 0;
  if (end > seq.props.duration) ops.push({ kind: 'update', id: seq.id, set: { duration: Math.ceil(end) } });
  return { ops: ops, cuts: r.cuts, effects: r.effects, bpm };
}

const zStyle = z.enum(EDIT_STYLE_NAMES as [EditStyle, ...EditStyle[]]);
const zFx = z.enum(EDIT_FX_KINDS as unknown as [EditFxKind, ...EditFxKind[]]);
const STYLE_HELP = EDIT_STYLE_NAMES.map((s) => `${s} (${EDIT_STYLES[s].fx.map((f) => f.effect).join(', ')}${EDIT_STYLES[s].transition ? `, ${EDIT_STYLES[s].transition} cuts` : ''})`).join('; ');

function recenseTools(services: Services): ToolDef[] {
  const asTool = (e: unknown): never => {
    if (e instanceof ToolError) throw e;
    throw new ToolError(e instanceof Error ? e.message : String(e));
  };
  return [
    defineTool({
      name: 'recense_find_beats',
      title: 'Find the beats',
      description: 'Find the tempo and beats of the music in an edit (a Recense sequence, or any video sequence) and save them on the timeline, so cuts and effects can land on them. Uses the given clip, or the first clip on an audio track.',
      category: 'recense',
      access: 'write',
      input: { projectId: zProjectId, sequenceId: z.string(), clipId: z.string().optional().describe('The music clip (default: first clip on an audio track)') },
      output: zWriteResult.extend({ bpm: z.number(), beats: z.array(z.number()) }),
      example: { input: { projectId: 'prj_8Kq2...', sequenceId: 'seq_main' }, output: { status: 'committed', commitId: 'c_b...', bpm: 128, beats: [0.47, 0.94, 1.41] } },
      async handler(args, ctx) {
        await ctx.requireProject(args.projectId, 'write');
        const state = await ctx.state(args.projectId);
        const r = await findBeats(services, state, args.sequenceId, args.clipId).catch(asTool);
        const seq = requireNodeOfType(state, args.sequenceId, 'sequence');
        const out = await ctx.apply(args.projectId, [setBeatsOp(seq, r)], `Find beats of "${r.clip}"`);
        return { ...writeResult(out, { bpm: r.bpm, beats: r.beats }), text: `${r.beats.length} beats at ${r.bpm} BPM in "${r.clip}". First: ${r.beats.slice(0, 8).join(', ')}…` };
      },
    }),
    defineTool({
      name: 'recense_beat_effect',
      title: 'Put an effect on the beats',
      description: `Make an effect hit on the beats (found with recense_find_beats): ${EDIT_FX_KINDS.join(', ')}. It goes on its own effect track ("Shake on beat") above the clips, so it hits everything below. every=2 hits every other beat; offset shifts which beat starts. Running it again for the same effect replaces its hits.`,
      category: 'recense',
      access: 'write',
      input: {
        projectId: zProjectId,
        sequenceId: z.string(),
        effect: zFx,
        every: z.number().int().min(1).max(32).default(1),
        offset: z.number().int().min(0).max(31).default(0),
        from: z.number().min(0).optional(),
        to: z.number().min(0).optional(),
        length: z.number().min(0.03).max(10).optional().describe('Seconds per hit (default suits the effect)'),
        amount: z.number().min(0).max(1).optional().describe('Strength 0..1'),
      },
      output: zWriteResult.extend({ hits: z.number() }),
      example: { input: { projectId: 'prj_8Kq2...', sequenceId: 'seq_main', effect: 'zoomPunch', every: 2 }, output: { status: 'committed', commitId: 'c_f...', hits: 16 } },
      async handler(args, ctx) {
        await ctx.requireProject(args.projectId, 'write');
        const state = await ctx.state(args.projectId);
        const seq = requireNodeOfType(state, args.sequenceId, 'sequence');
        if (!seq.props.beats?.length) throw new ToolError('No beats yet. Call recense_find_beats first.');
        const r = beatEffectOps(state, args.sequenceId, { effect: args.effect, beats: seq.props.beats, every: args.every, offset: args.offset, ...(args.from !== undefined ? { from: args.from } : {}), ...(args.to !== undefined ? { to: args.to } : {}), ...(args.length !== undefined ? { length: args.length } : {}), ...(args.amount !== undefined ? { amount: args.amount } : {}) });
        const out = await ctx.apply(args.projectId, r.ops, `${args.effect} on the beat`);
        return writeResult(out, { hits: r.hits });
      },
    }),
    defineTool({
      name: 'recense_auto_edit',
      title: 'Make an edit',
      description: `Make a whole edit in one go: find the beats if needed, cut the shots (the given assets, or the videos and pictures already in the edit) to the music, filling the frame, and add a style's effects. Styles: ${STYLE_HELP}. It replaces the clips on the main video track and the style's effect tracks; everything can be undone and tweaked after.`,
      category: 'recense',
      access: 'write',
      destructive: true,
      input: { projectId: zProjectId, sequenceId: z.string(), style: zStyle.default('hype'), assetIds: z.array(z.string()).max(200).optional().describe('Shots, in order (default: what is in the edit)') },
      output: zWriteResult.extend({ cuts: z.number(), effects: z.number(), bpm: z.number().nullable() }),
      example: { input: { projectId: 'prj_8Kq2...', sequenceId: 'seq_main', style: 'hype' }, output: { status: 'committed', commitId: 'c_e...', cuts: 24, effects: 40, bpm: 128 } },
      async handler(args, ctx) {
        await ctx.requireProject(args.projectId, 'write');
        const state = await ctx.state(args.projectId);
        const r = await autoEdit(services, state, args.sequenceId, args.style, args.assetIds).catch(asTool);
        const out = await ctx.apply(args.projectId, r.ops, `${EDIT_STYLES[args.style].label} edit`);
        return writeResult(out, { cuts: r.cuts, effects: r.effects, bpm: r.bpm });
      },
    }),
  ] as unknown as ToolDef[];
}

useModule(({ services, router }) => {
  registerToolProvider(services, recenseTools);
  const bad = (e: unknown): never => {
    if (e instanceof ProjectError) throw e;
    throw new ProjectError(e instanceof Error ? e.message : String(e), 400);
  };
  const commit = async (projectId: string, user: { id: string; name: string }, ops: Operation[], label: string) =>
    (await services.projects.commit(projectId, ops.length === 1 ? ops[0]! : { kind: 'batch', ops }, { type: 'human', id: user.id, name: user.name }, { label, via: 'ui' })).id;
  const r = express.Router();

  r.post(
    '/projects/:id/recense/beats',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      const body = z.object({ sequenceId: z.string(), clipId: z.string().optional() }).parse(req.body);
      await services.projects.requireAccess(projectId, user.id, 'write');
      const state = await services.projects.state(projectId);
      const found = await findBeats(services, state, body.sequenceId, body.clipId).catch(bad);
      const seq = requireNodeOfType(state, body.sequenceId, 'sequence');
      const commitId = await commit(projectId, user, [setBeatsOp(seq, found)], 'Find beats');
      res.json({ commitId, bpm: found.bpm, beats: found.beats.length });
    }),
  );

  r.post(
    '/projects/:id/recense/auto',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      const body = z.object({ sequenceId: z.string(), style: zStyle }).parse(req.body);
      await services.projects.requireAccess(projectId, user.id, 'write');
      const state = await services.projects.state(projectId);
      const out = await autoEdit(services, state, body.sequenceId, body.style).catch(bad);
      const commitId = await commit(projectId, user, out.ops, `${EDIT_STYLES[body.style].label} edit`);
      res.json({ commitId, cuts: out.cuts, effects: out.effects, bpm: out.bpm });
    }),
  );

  router.use(r);
});
