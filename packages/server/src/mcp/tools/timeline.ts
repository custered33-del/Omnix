import { z } from 'zod';
import {
  clipEnd,
  clipsOf,
  makeNode,
  moveClipOp,
  newId,
  rippleDeleteOp,
  setSpeedOp,
  splitClipOp,
  tracksOf,
  trimOp,
  upsertKeyframe,
  zColor,
  zEasing,
  zFilterKind,
  zVectorShape,
  type AnimatableProp,
  type ClipProps,
  type Keyframe,
  type Operation,
  type ProjectState,
  type SceneNode,
  type TrackType,
} from '@omnix/core';
import { COLOR_GRADE_DEFAULTS, FILTER_DEFAULTS } from '@omnix/imaging';
import { defineTool, ToolError, zProjectId } from '../registry.js';
import { edit, need, writeResult, zWriteResult } from './helpers.js';
import { captionClipOps, captionSegments } from '../../captions/core.js';
import type { SpeechProvider } from '../../captions/stt.js';

/**
 * Video and animation timeline tools. Both editors share one engine: sequences hold tracks,
 * tracks hold clips (video, audio, titles) or animation layers. Times are seconds; clip x/y
 * are offsets from the frame centre.
 */

const TRACK_NAMES: Record<TrackType, string> = { video: 'Video', audio: 'Audio', title: 'Titles', effect: 'Effects', animation: 'Animation' };

/** Sequence length grows to fit new content. */
function grow(state: ProjectState, seqId: string, end: number): Operation[] {
  const seq = state.nodes[seqId] as SceneNode<'sequence'>;
  return end > seq.props.duration + 1e-6 ? [{ kind: 'update', id: seqId, set: { duration: Math.ceil(end * 10) / 10 } }] : [];
}

function sequenceOfTrack(state: ProjectState, trackId: string): SceneNode<'sequence'> {
  const t = need(state, trackId, 'track', 'track');
  return state.nodes[t.parentId!] as SceneNode<'sequence'>;
}

const zKeyProp = z.enum(['x', 'y', 'scale', 'rotation', 'opacity', 'volume', 'blur']);

export const timelineTools = [
  defineTool({
    name: 'video_add_clip',
    title: 'Put media on the timeline',
    description:
      'Place a video, audio or image asset on a track. Without trackId the first track of the right kind is used (one is created if needed). Without start the clip goes after the last clip on that track. in/out pick the part of the source to use (seconds). The sequence grows to fit.',
    category: 'video',
    access: 'write',
    input: {
      projectId: zProjectId,
      sequenceId: z.string(),
      assetId: z.string(),
      trackId: z.string().optional(),
      start: z.number().min(0).optional(),
      in: z.number().min(0).optional(),
      out: z.number().positive().optional(),
      name: z.string().max(200).optional(),
    },
    output: zWriteResult.extend({ clipId: z.string(), trackId: z.string(), start: z.number(), end: z.number() }),
    example: { input: { projectId: 'prj_8Kq2...', sequenceId: 'seq_main', assetId: '3f9a...', start: 0, in: 2, out: 8 }, output: { status: 'committed', commitId: 'c_7a...', clipId: 'clp_1...', trackId: 'trk_v1', start: 0, end: 6 } },
    async handler(args, ctx) {
      const a = await ctx.services.assets.get(args.assetId);
      if (!a || !['video', 'audio', 'image'].includes(a.kind)) throw new ToolError(`Asset ${args.assetId} is not a video, audio or image file.`);
      let clipId = '';
      let trackId = '';
      let start = 0;
      let end = 0;
      const out = await edit(ctx, args.projectId, `Add ${a.name}`, (state) => {
        const seq = need(state, args.sequenceId, 'sequence', 'sequence');
        const ops: Operation[] = [];
        const kind: TrackType = a.kind === 'audio' ? 'audio' : 'video';
        let track = args.trackId ? need(state, args.trackId, 'track', 'track') : tracksOf(state, seq.id).find((t) => t.props.trackType === kind);
        if (!track) {
          track = makeNode('track', { name: `${TRACK_NAMES[kind]} 1`, trackType: kind });
          ops.push({ kind: 'create', parentId: seq.id, ...(kind === 'audio' ? {} : { index: 0 }), nodes: [track] });
        }
        trackId = track.id;
        const still = a.kind === 'image';
        const srcDur = still ? 0 : (a.duration ?? 5);
        const inP = args.in ?? 0;
        const outP = args.out ?? (still ? inP + 5 : srcDur);
        if (!still && outP > srcDur + 1e-3) throw new ToolError(`out (${outP}s) is past the end of the media (${srcDur}s).`);
        if (outP <= inP) throw new ToolError('out must be after in.');
        start = args.start ?? (state.nodes[track.id] ? clipsOf(state, track.id).reduce((m, c) => Math.max(m, clipEnd(c.props)), 0) : 0);
        const clip = makeNode('clip', { name: args.name ?? a.name.replace(/\.[^.]+$/, ''), assetId: a.id, start, in: inP, out: outP, sourceDuration: srcDur } satisfies Partial<ClipProps>);
        clipId = clip.id;
        end = start + (outP - inP);
        ops.push({ kind: 'create', parentId: track.id, nodes: [clip] }, ...grow(state, seq.id, end));
        return ops;
      });
      return writeResult(out, { clipId, trackId, start, end });
    },
  }),

  defineTool({
    name: 'video_add_title',
    title: 'Add a title or caption',
    description: 'Add text on screen for a time range: a title (large, centred, fades in and out) or a caption (bottom of the frame, with a backing box). Goes on the top title track.',
    category: 'video',
    access: 'write',
    input: {
      projectId: zProjectId,
      sequenceId: z.string(),
      text: z.string().min(1).max(2000),
      start: z.number().min(0),
      duration: z.number().positive().max(3600).default(4),
      caption: z.boolean().default(false),
      fontFamily: z.string().optional(),
      fontSize: z.number().positive().max(1000).optional(),
      color: zColor.optional(),
      background: zColor.nullable().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    },
    output: zWriteResult.extend({ clipId: z.string() }),
    example: { input: { projectId: 'prj_8Kq2...', sequenceId: 'seq_main', text: 'Coming this spring', start: 24, duration: 4 }, output: { status: 'proposed', proposalId: 'prop_4a...', clipId: 'clp_title...' } },
    async handler(args, ctx) {
      let clipId = '';
      const out = await edit(ctx, args.projectId, args.caption ? 'Add caption' : `Add title "${args.text.slice(0, 40)}"`, (state) => {
        const seq = need(state, args.sequenceId, 'sequence', 'sequence');
        const ops: Operation[] = [];
        let track = tracksOf(state, seq.id).find((t) => t.props.trackType === 'title' && (args.caption ? t.props.name === 'Captions' : t.props.name !== 'Captions')) ?? tracksOf(state, seq.id).find((t) => t.props.trackType === 'title');
        if (!track) {
          track = makeNode('track', { name: args.caption ? 'Captions' : 'Titles', trackType: 'title' });
          ops.push({ kind: 'create', parentId: seq.id, index: 0, nodes: [track] });
        }
        const clip = makeNode('clip', {
          name: args.text.slice(0, 40),
          start: args.start,
          in: 0,
          out: args.duration,
          ...(args.x !== undefined ? { x: args.x } : {}),
          ...(args.y !== undefined ? { y: args.y } : {}),
          title: {
            text: args.text,
            fontFamily: args.fontFamily ?? 'Inter',
            fontSize: args.fontSize ?? (args.caption ? 44 : 96),
            fontWeight: args.caption ? 600 : 750,
            color: args.color ?? '#ffffff',
            background: args.background === undefined ? (args.caption ? '#00000099' : null) : args.background,
            align: 'center',
            caption: args.caption,
          },
          transitionIn: args.caption ? null : { kind: 'crossfade', duration: 0.4, easing: 'ease-out' },
          transitionOut: args.caption ? null : { kind: 'crossfade', duration: 0.4, easing: 'ease-in' },
        });
        clipId = clip.id;
        ops.push({ kind: 'create', parentId: track.id, nodes: [clip] }, ...grow(state, seq.id, args.start + args.duration));
        return ops;
      });
      return writeResult(out, { clipId });
    },
  }),

  defineTool({
    name: 'video_edit_clip',
    title: 'Split, trim, move or delete a clip',
    description:
      'Timeline edits on one clip. split: cut at a sequence time into two clips. trim: move the in or out edge by delta seconds (positive shortens the in edge, lengthens the out edge). move: change start time and optionally track. delete: remove it; with ripple the later clips on that track close the gap.',
    category: 'video',
    access: 'write',
    destructive: true,
    input: {
      projectId: zProjectId,
      clipId: z.string(),
      action: z.enum(['split', 'trim', 'move', 'delete']),
      time: z.number().min(0).optional().describe('split: sequence time'),
      edge: z.enum(['in', 'out']).optional().describe('trim: which edge'),
      delta: z.number().optional().describe('trim: seconds'),
      start: z.number().min(0).optional().describe('move: new start'),
      trackId: z.string().optional().describe('move: new track'),
      ripple: z.boolean().default(false).describe('delete: close the gap'),
    },
    output: zWriteResult.extend({ newClipId: z.string().optional() }),
    example: { input: { projectId: 'prj_8Kq2...', clipId: 'clp_1', action: 'split', time: 4.5 }, output: { status: 'committed', commitId: 'c_8b...', newClipId: 'clp_2...' } },
    async handler(args, ctx) {
      let newClipId: string | undefined;
      const out = await edit(ctx, args.projectId, `${args.action[0]!.toUpperCase()}${args.action.slice(1)} clip`, (state) => {
        const clip = need(state, args.clipId, 'clip', 'clip');
        switch (args.action) {
          case 'split': {
            if (args.time === undefined) throw new ToolError('split needs time.');
            newClipId = newId('clp');
            return [splitClipOp(state, clip.id, args.time, newClipId)];
          }
          case 'trim':
            if (!args.edge || args.delta === undefined) throw new ToolError('trim needs edge and delta.');
            return [trimOp(state, clip.id, args.edge, args.delta)];
          case 'move': {
            if (args.start === undefined) throw new ToolError('move needs start.');
            const seq = sequenceOfTrack(state, args.trackId ?? clip.parentId!);
            return [moveClipOp(state, clip.id, args.start, args.trackId), ...grow(state, seq.id, args.start + (clipEnd(clip.props) - clip.props.start))];
          }
          default:
            return [args.ripple ? rippleDeleteOp(state, clip.id) : { kind: 'delete', id: clip.id }];
        }
      });
      return writeResult(out, newClipId ? { newClipId } : {});
    },
  }),

  defineTool({
    name: 'video_set_speed',
    title: 'Change clip speed',
    description: 'Play a clip faster or slower (0.1 to 16, 1 = normal), optionally in reverse. With ripple, later clips move to make room. For gradual speed changes pass ramp: points of normalized clip time 0..1 and speed.',
    category: 'video',
    access: 'write',
    input: { projectId: zProjectId, clipId: z.string(), speed: z.number().min(0.1).max(16), reverse: z.boolean().optional(), ripple: z.boolean().default(true), ramp: z.array(z.object({ t: z.number().min(0).max(1), speed: z.number().min(0.1).max(16) })).max(32).nullable().optional() },
    output: zWriteResult,
    example: { input: { projectId: 'prj_8Kq2...', clipId: 'clp_1', speed: 0.5 }, output: { status: 'proposed', proposalId: 'prop_9c...' } },
    async handler(args, ctx) {
      const out = await edit(ctx, args.projectId, `Speed ${args.speed}×${args.reverse ? ', reversed' : ''}`, (state) => {
        need(state, args.clipId, 'clip', 'clip');
        const ops: Operation[] = [setSpeedOp(state, args.clipId, args.speed, { ...(args.reverse !== undefined ? { reverse: args.reverse } : {}), ripple: args.ripple })];
        if (args.ramp !== undefined) ops.push({ kind: 'update', id: args.clipId, set: { speedRamp: args.ramp && args.ramp.length ? [...args.ramp].sort((a, b) => a.t - b.t) : null } });
        return ops;
      });
      return writeResult(out);
    },
  }),

  defineTool({
    name: 'video_set_keyframe',
    title: 'Animate a property',
    description:
      'Set a keyframe on a clip or animation layer: property x, y, scale, rotation, opacity, volume (dB, audio) or blur at a time relative to the clip or layer start. Between keyframes values move with the easing of the earlier keyframe. Pass remove: true to delete the keyframe at that time.',
    category: 'video',
    access: 'write',
    input: { projectId: zProjectId, nodeId: z.string().describe('Clip or animation layer'), property: zKeyProp, time: z.number().min(0), value: z.number().optional(), easing: zEasing.default('ease-in-out'), remove: z.boolean().default(false) },
    output: zWriteResult.extend({ keyframes: z.number() }),
    example: { input: { projectId: 'prj_8Kq2...', nodeId: 'clp_logo', property: 'scale', time: 0, value: 0.8, easing: 'ease-out' }, output: { status: 'committed', commitId: 'c_2c...', keyframes: 2 } },
    async handler(args, ctx) {
      let count = 0;
      const out = await edit(ctx, args.projectId, args.remove ? `Remove ${args.property} keyframe` : `Keyframe ${args.property} at ${args.time}s`, (state) => {
        const n = need(state, args.nodeId, ['clip', 'animLayer'], 'clip or animation layer');
        const keys = { ...((n.props as { keyframes?: Partial<Record<AnimatableProp, Keyframe[]>> }).keyframes ?? {}) };
        let list = keys[args.property] ?? [];
        if (args.remove) list = list.filter((k) => Math.abs(k.time - args.time) > 1e-4);
        else {
          if (args.value === undefined) throw new ToolError('Pass value (or remove: true).');
          list = upsertKeyframe(list, { time: args.time, value: args.value, easing: args.easing });
        }
        count = list.length;
        if (list.length) keys[args.property] = list;
        else delete keys[args.property];
        return [{ kind: 'update', id: n.id, set: { keyframes: keys } }];
      });
      return writeResult(out, { keyframes: count });
    },
  }),

  defineTool({
    name: 'video_set_transition',
    title: 'Set a transition',
    description: 'Set or clear the transition at the start (in) or end (out) of a clip: crossfade, dip-to-black, wipe-left, wipe-right, slide-left or zoom, with duration and easing.',
    category: 'video',
    access: 'write',
    input: { projectId: zProjectId, clipId: z.string(), side: z.enum(['in', 'out']), kind: z.enum(['crossfade', 'dip-to-black', 'wipe-left', 'wipe-right', 'slide-left', 'zoom']).nullable(), duration: z.number().positive().max(10).default(0.5), easing: zEasing.default('ease-in-out') },
    output: zWriteResult,
    example: { input: { projectId: 'prj_8Kq2...', clipId: 'clp_2', side: 'in', kind: 'crossfade', duration: 0.8 }, output: { status: 'committed', commitId: 'c_5e...' } },
    async handler(args, ctx) {
      const out = await edit(ctx, args.projectId, args.kind ? `${args.kind} ${args.side}` : `Remove transition ${args.side}`, (state) => {
        need(state, args.clipId, 'clip', 'clip');
        return [{ kind: 'update', id: args.clipId, set: { [args.side === 'in' ? 'transitionIn' : 'transitionOut']: args.kind ? { kind: args.kind, duration: args.duration, easing: args.easing } : null } }];
      });
      return writeResult(out);
    },
  }),

  defineTool({
    name: 'video_add_effect',
    title: 'Add a clip effect',
    description: 'Add an effect to a clip: colorGrade {exposure, contrast, saturation, temperature, tint} or a filter (gaussianBlur, sharpen, noise, pixelate, grayscale, sepia, vignette, emboss, edgeDetect). For green screens set backgroundRemoval with update_node, or use video_remove_background.',
    category: 'video',
    access: 'write',
    input: { projectId: zProjectId, clipId: z.string(), effect: z.union([zFilterKind, z.literal('colorGrade')]), params: z.record(z.string(), z.number()).default({}) },
    output: zWriteResult.extend({ effectId: z.string() }),
    example: { input: { projectId: 'prj_8Kq2...', clipId: 'clp_1', effect: 'colorGrade', params: { temperature: 20, saturation: 10 } }, output: { status: 'proposed', proposalId: 'prop_3e...', effectId: 'fx_1...' } },
    async handler(args, ctx) {
      const effectId = newId('fx');
      const out = await edit(ctx, args.projectId, `Add ${args.effect}`, (state) => {
        need(state, args.clipId, 'clip', 'clip');
        return [{ kind: 'listInsert', id: args.clipId, prop: 'effects', items: [{ id: effectId, effect: args.effect, params: { ...(args.effect === 'colorGrade' ? COLOR_GRADE_DEFAULTS : FILTER_DEFAULTS[args.effect]), ...args.params }, enabled: true }] }];
      });
      return writeResult(out, { effectId });
    },
  }),

  defineTool({
    name: 'video_remove_background',
    title: 'Remove a clip\'s background',
    description: 'Cut the subject out of a video clip: "chroma" keys out a color (green or blue screen; set keyColor), "auto" separates the subject from a mostly still background. Clips on lower tracks show through.',
    category: 'video',
    access: 'write',
    input: { projectId: zProjectId, clipId: z.string(), method: z.enum(['chroma', 'auto']), keyColor: zColor.default('#00b140'), tolerance: z.number().min(0).max(1).default(0.25), softness: z.number().min(0).max(1).default(0.1), enabled: z.boolean().default(true) },
    output: zWriteResult,
    example: { input: { projectId: 'prj_8Kq2...', clipId: 'clp_host', method: 'chroma', keyColor: '#00b140' }, output: { status: 'committed', commitId: 'c_9d...' } },
    async handler(args, ctx) {
      const out = await edit(ctx, args.projectId, args.enabled ? 'Remove background' : 'Turn off background removal', (state) => {
        need(state, args.clipId, 'clip', 'clip');
        return [{ kind: 'update', id: args.clipId, set: { backgroundRemoval: { enabled: args.enabled, method: args.method, keyColor: args.keyColor, tolerance: args.tolerance, softness: args.softness } } }];
      });
      return writeResult(out);
    },
  }),

  defineTool({
    name: 'video_add_track',
    title: 'Add a track',
    description: 'Add a video, audio, title, effect or animation track to a sequence. Visual tracks go on top unless you pass index (0 = top).',
    category: 'video',
    access: 'write',
    input: { projectId: zProjectId, sequenceId: z.string(), trackType: z.enum(['video', 'audio', 'title', 'effect', 'animation']), name: z.string().max(100).optional(), index: z.number().int().min(0).optional() },
    output: zWriteResult.extend({ trackId: z.string() }),
    example: { input: { projectId: 'prj_8Kq2...', sequenceId: 'seq_main', trackType: 'audio', name: 'Music' }, output: { status: 'committed', commitId: 'c_1a...', trackId: 'trk_music' } },
    async handler(args, ctx) {
      let trackId = '';
      const out = await edit(ctx, args.projectId, `Add ${args.trackType} track`, (state) => {
        const seq = need(state, args.sequenceId, 'sequence', 'sequence');
        const n = tracksOf(state, seq.id).filter((t) => t.props.trackType === args.trackType).length;
        const track = makeNode('track', { name: args.name ?? `${TRACK_NAMES[args.trackType]} ${n + 1}`, trackType: args.trackType });
        trackId = track.id;
        const index = args.index ?? (args.trackType === 'audio' ? seq.children.length : 0);
        return [{ kind: 'create', parentId: seq.id, index: Math.min(index, seq.children.length), nodes: [track] }];
      });
      return writeResult(out, { trackId });
    },
  }),

  defineTool({
    name: 'video_mix_track',
    title: 'Mix a track',
    description: 'Audio mixing for a track: gain in dB (-60..12), pan (-1 left .. 1 right), mute, and ducking (lower this track while another track, usually dialogue, has sound).',
    category: 'video',
    access: 'write',
    input: { projectId: zProjectId, trackId: z.string(), gain: z.number().min(-60).max(12).optional(), pan: z.number().min(-1).max(1).optional(), muted: z.boolean().optional(), duckUnder: z.string().nullable().optional().describe('Track id that triggers ducking, or null to turn ducking off'), duckAmountDb: z.number().min(-40).max(0).optional() },
    output: zWriteResult,
    example: { input: { projectId: 'prj_8Kq2...', trackId: 'trk_music', gain: -6, duckUnder: 'trk_voice', duckAmountDb: -12 }, output: { status: 'committed', commitId: 'c_3b...' } },
    async handler(args, ctx) {
      const out = await edit(ctx, args.projectId, 'Mix track', (state) => {
        const t = need(state, args.trackId, 'track', 'track');
        const set: Record<string, unknown> = {};
        if (args.gain !== undefined) set.gain = args.gain;
        if (args.pan !== undefined) set.pan = args.pan;
        if (args.muted !== undefined) set.muted = args.muted;
        if (args.duckUnder !== undefined || args.duckAmountDb !== undefined) {
          if (args.duckUnder) need(state, args.duckUnder, 'track', 'track');
          set.ducking = { enabled: args.duckUnder === undefined ? t.props.ducking.enabled : !!args.duckUnder, sourceTrackId: args.duckUnder === undefined ? t.props.ducking.sourceTrackId : args.duckUnder, amountDb: args.duckAmountDb ?? t.props.ducking.amountDb };
        }
        return [{ kind: 'update', id: t.id, set }];
      });
      return writeResult(out);
    },
  }),

  defineTool({
    name: 'video_generate_captions',
    title: 'Generate captions',
    description: 'Listen to the sequence\'s dialogue and add timed captions on a Captions track. With a speech-to-text service configured they contain the words; otherwise they are timed slots where speech was detected, ready for text.',
    category: 'video',
    access: 'write',
    input: { projectId: zProjectId, sequenceId: z.string(), clipIds: z.array(z.string()).optional(), language: z.string().max(10).optional() },
    output: zWriteResult.extend({ captions: z.number(), transcribed: z.boolean() }),
    example: { input: { projectId: 'prj_8Kq2...', sequenceId: 'seq_main' }, output: { status: 'proposed', proposalId: 'prop_cap...', captions: 14, transcribed: true } },
    async handler(args, ctx) {
      await ctx.requireProject(args.projectId, 'write');
      if (ctx.principal.mode === 'view') throw new ToolError('This connection is view-only.');
      const state = await ctx.state(args.projectId);
      need(state, args.sequenceId, 'sequence', 'sequence');
      const provider = ctx.services.ext.speechProvider as SpeechProvider | undefined;
      if (!provider) throw new ToolError('Captions are not available on this server.');
      const { segments, hasText } = await captionSegments(ctx.services, state, { projectId: args.projectId, sequenceId: args.sequenceId, ...(args.clipIds ? { clipIds: args.clipIds } : {}), ...(args.language ? { language: args.language } : {}) }, provider, () => {});
      if (!segments.length) return { text: 'No speech found in the sequence.', data: { status: 'committed', captions: 0, transcribed: hasText } };
      const out = await ctx.apply(args.projectId, captionClipOps(state, args.sequenceId, segments), hasText ? `Generate ${segments.length} captions` : `Add ${segments.length} caption slots`);
      return writeResult(out, { captions: segments.length, transcribed: hasText });
    },
  }),

  /* Animation ------------------------------------------------------ */

  defineTool({
    name: 'anim_add_layer',
    title: 'Add an animation layer',
    description: 'Add an animation layer (a drawing that can be frame-by-frame, tweened with keyframes, rigged with bones or moved along a path) to an animation track. Pass shapes for its first drawing, in layer coordinates around its anchor.',
    category: 'animation',
    access: 'write',
    input: { projectId: zProjectId, sequenceId: z.string(), name: z.string().max(100).default('Layer'), start: z.number().min(0).default(0), duration: z.number().positive().optional(), x: z.number().default(0), y: z.number().default(0), shapes: z.array(zVectorShape).default([]) },
    output: zWriteResult.extend({ layerId: z.string(), trackId: z.string() }),
    example: { input: { projectId: 'prj_8Kq2...', sequenceId: 'seq_anim', name: 'Ball', shapes: [{ id: 'b', kind: 'ellipse', x: -50, y: -50, width: 100, height: 100, fill: '#e8590c', stroke: null, strokeWidth: 0 }] }, output: { status: 'committed', commitId: 'c_4f...', layerId: 'anl_ball', trackId: 'trk_anim' } },
    async handler(args, ctx) {
      let layerId = '';
      let trackId = '';
      const out = await edit(ctx, args.projectId, `Add animation layer "${args.name}"`, (state) => {
        const seq = need(state, args.sequenceId, 'sequence', 'sequence');
        const ops: Operation[] = [];
        let track = tracksOf(state, seq.id).find((t) => t.props.trackType === 'animation');
        if (!track) {
          track = makeNode('track', { name: 'Animation', trackType: 'animation' });
          ops.push({ kind: 'create', parentId: seq.id, index: 0, nodes: [track] });
        }
        trackId = track.id;
        const duration = args.duration ?? Math.max(0.1, seq.props.duration - args.start);
        const layer = makeNode('animLayer', { name: args.name, start: args.start, duration, x: args.x, y: args.y, frames: [{ id: newId('frm'), hold: 1, shapes: args.shapes.map((s) => ({ ...s, id: s.id || newId('shp') })), strokes: [], assetId: null }] });
        layerId = layer.id;
        ops.push({ kind: 'create', parentId: track.id, nodes: [layer] }, ...grow(state, seq.id, args.start + duration));
        return ops;
      });
      return writeResult(out, { layerId, trackId });
    },
  }),

  defineTool({
    name: 'anim_add_frame',
    title: 'Add a drawing frame',
    description: 'Add a frame-by-frame drawing to an animation layer. hold is how many timeline frames it stays on screen. index inserts it at a position (default: after the last frame).',
    category: 'animation',
    access: 'write',
    input: { projectId: zProjectId, layerId: z.string(), shapes: z.array(zVectorShape).max(500), hold: z.number().int().min(1).max(240).default(1), index: z.number().int().min(0).optional() },
    output: zWriteResult.extend({ frameId: z.string() }),
    example: { input: { projectId: 'prj_8Kq2...', layerId: 'anl_ball', shapes: [{ id: 's', kind: 'ellipse', x: -60, y: -40, width: 120, height: 80, fill: '#e8590c', stroke: null, strokeWidth: 0 }], hold: 2 }, output: { status: 'committed', commitId: 'c_6d...', frameId: 'frm_2...' } },
    async handler(args, ctx) {
      const frameId = newId('frm');
      const out = await edit(ctx, args.projectId, 'Add frame', (state) => {
        const l = need(state, args.layerId, 'animLayer', 'animation layer');
        return [{ kind: 'listInsert', id: l.id, prop: 'frames', ...(args.index !== undefined ? { index: Math.min(args.index, l.props.frames.length) } : {}), items: [{ id: frameId, hold: args.hold, shapes: args.shapes.map((s) => ({ ...s, id: s.id || newId('shp') })), strokes: [], assetId: null }] }];
      });
      return writeResult(out, { frameId });
    },
  }),

  defineTool({
    name: 'anim_set_motion_path',
    title: 'Move along a path',
    description: 'Make an animation layer follow a path over its duration (points in sequence coordinates, origin at the frame centre). orientToPath turns the layer to face along the path. Pass points: [] to remove the path.',
    category: 'animation',
    access: 'write',
    input: { projectId: zProjectId, layerId: z.string(), points: z.array(z.object({ x: z.number(), y: z.number() })).max(200), smooth: z.boolean().default(true), orientToPath: z.boolean().default(false), easing: zEasing.default('ease-in-out') },
    output: zWriteResult,
    example: { input: { projectId: 'prj_8Kq2...', layerId: 'anl_ball', points: [{ x: -500, y: 200 }, { x: 0, y: -150 }, { x: 500, y: 200 }] }, output: { status: 'proposed', proposalId: 'prop_2f...' } },
    async handler(args, ctx) {
      const out = await edit(ctx, args.projectId, args.points.length ? 'Set motion path' : 'Remove motion path', (state) => {
        const l = need(state, args.layerId, 'animLayer', 'animation layer');
        if (!args.points.length) return [{ kind: 'update', id: l.id, set: { motionPath: null } }];
        if (args.points.length < 2) throw new ToolError('A path needs at least two points.');
        const pts = args.points;
        // Smooth paths use Catmull-Rom tangents as bezier handles.
        const anchors = pts.map((p, i) => {
          if (!args.smooth) return { x: p.x, y: p.y };
          const prev = pts[i - 1] ?? p;
          const next = pts[i + 1] ?? p;
          const tx = (next.x - prev.x) / 6;
          const ty = (next.y - prev.y) / 6;
          return { x: p.x, y: p.y, ...(i > 0 ? { in: { x: p.x - tx, y: p.y - ty } } : {}), ...(i < pts.length - 1 ? { out: { x: p.x + tx, y: p.y + ty } } : {}) };
        });
        return [{ kind: 'update', id: l.id, set: { motionPath: { path: { closed: false, anchors }, orientToPath: args.orientToPath, easing: args.easing } } }];
      });
      return writeResult(out);
    },
  }),

  defineTool({
    name: 'anim_rig',
    title: 'Rig and pose bones',
    description:
      'Bone rigging for a character layer. addBones appends bones (parentId null for a root at x, y; angle in radians relative to the parent; length in pixels). pose records joint angles (radians, by bone id) at a time in seconds from the layer start; poses in between are interpolated with the easing.',
    category: 'animation',
    access: 'write',
    input: {
      projectId: zProjectId,
      layerId: z.string(),
      addBones: z.array(z.object({ id: z.string().regex(/^[\w-]+$/).optional(), name: z.string().max(60), parentId: z.string().nullable(), length: z.number().positive(), angle: z.number(), x: z.number().default(0), y: z.number().default(0) })).max(64).optional(),
      pose: z.object({ time: z.number().min(0), angles: z.record(z.string(), z.number()), easing: zEasing.default('ease-in-out') }).optional(),
    },
    output: zWriteResult.extend({ boneIds: z.array(z.string()) }),
    example: { input: { projectId: 'prj_8Kq2...', layerId: 'anl_arm', addBones: [{ id: 'upper', name: 'Upper arm', parentId: null, length: 120, angle: 0.3, x: 0, y: 0 }, { id: 'lower', name: 'Forearm', parentId: 'upper', length: 100, angle: 0.4 }], pose: { time: 1, angles: { upper: -0.6, lower: 1.1 } } }, output: { status: 'committed', commitId: 'c_8e...', boneIds: ['upper', 'lower'] } },
    async handler(args, ctx) {
      const ids: string[] = [];
      const out = await edit(ctx, args.projectId, args.addBones?.length ? 'Add bones' : 'Pose rig', (state) => {
        const l = need(state, args.layerId, 'animLayer', 'animation layer');
        const rig = structuredClone(l.props.rig ?? { bones: [], poses: [] });
        for (const b of args.addBones ?? []) {
          const id = b.id ?? newId('bone');
          if (rig.bones.some((x) => x.id === id)) throw new ToolError(`Bone ${id} already exists.`);
          if (b.parentId && !rig.bones.some((x) => x.id === b.parentId) && !(args.addBones ?? []).some((x) => x.id === b.parentId)) throw new ToolError(`Unknown parent bone ${b.parentId}.`);
          rig.bones.push({ id, name: b.name, parentId: b.parentId, length: b.length, angle: b.angle, x: b.x, y: b.y, attachment: null });
          ids.push(id);
        }
        if (args.pose) {
          for (const k of Object.keys(args.pose.angles)) if (!rig.bones.some((b) => b.id === k)) throw new ToolError(`Unknown bone ${k} in pose.`);
          rig.poses = [...rig.poses.filter((p) => Math.abs(p.time - args.pose!.time) > 1e-4), { time: args.pose.time, angles: args.pose.angles, easing: args.pose.easing }].sort((a, b) => a.time - b.time);
        }
        return [{ kind: 'update', id: l.id, set: { rig } }];
      });
      return writeResult(out, { boneIds: ids });
    },
  }),
];
