import { z } from 'zod';
import { clipEnd, clipsOf, tracksOf, type Keyframe, type SceneNode } from '@omnix/core';
import { useModule } from '../app.js';
import { defineTool, ToolError, zProjectId, type ToolDef } from '../mcp/registry.js';
import { registerToolProvider } from '../mcp/tools/index.js';
import { edit, need, writeResult, zWriteResult } from '../mcp/tools/helpers.js';
import type { Services } from '../services.js';
import { lastSpeechError, type SpeechProvider } from '../captions/stt.js';
import { cachedTranscript, describeOnScreen, drawGrid, fmtTime, framePng, onScreenAt, sequenceFrames, sequenceTranscript, trackPoint } from './awareness.js';

/** Claude's senses for video: hear it, see it (with coordinates), and follow what moves. */
function videoTools(services: Services): ToolDef[] {
  const speech = () => {
    const p = services.ext.speechProvider as SpeechProvider | undefined;
    if (!p) throw new ToolError('Listening is not available on this server.');
    return p;
  };
  const range = (state: Parameters<typeof tracksOf>[0], sequenceId: string, clipId?: string, start?: number, end?: number) => {
    const seq = need(state, sequenceId, 'sequence', 'sequence');
    let from = start ?? 0;
    let to = end;
    if (clipId) {
      const c = need(state, clipId, 'clip', 'clip');
      from = start ?? c.props.start;
      to = end ?? clipEnd(c.props);
    }
    if (to === undefined) {
      let last = 0;
      for (const t of tracksOf(state, sequenceId)) for (const c of clipsOf(state, t.id)) last = Math.max(last, clipEnd(c.props));
      to = last || seq.props.duration;
    }
    if (!(to > from)) throw new ToolError('end must be after start.');
    return { seq, from, to };
  };

  return [
    defineTool({
      name: 'video_transcript',
      title: 'Hear what is said',
      description:
        "Transcribe the speech in a sequence: every line with its start and end time on the timeline, so you know what is said when (to cut on a sentence, place a title as a word is spoken, or find a moment). Runs a speech model on the user's computer (free; the first time it downloads the model). Results are kept until the clips' sound changes. Without the model, it reports when speech happens but not the words.",
      category: 'video',
      access: 'read',
      input: { projectId: zProjectId, sequenceId: z.string(), clipIds: z.array(z.string()).optional().describe('Only these clips (default: everything audible)'), language: z.string().max(10).optional().describe('For example "en"; default: detected') },
      output: z.object({ hasWords: z.boolean(), lines: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })) }),
      example: { input: { projectId: 'prj_8Kq2...', sequenceId: 'seq_main' }, output: { hasWords: true, lines: [{ start: 1.2, end: 3.4, text: 'This lamp follows the sun.' }] } },
      async handler(args, ctx) {
        await ctx.requireProject(args.projectId, 'read');
        const state = await ctx.state(args.projectId);
        need(state, args.sequenceId, 'sequence', 'sequence');
        const r = await sequenceTranscript(services, state, args.sequenceId, speech(), { projectId: args.projectId, ...(args.clipIds ? { clipIds: args.clipIds } : {}), ...(args.language ? { language: args.language } : {}) });
        const lines = r.segments.map((s) => ({ start: Math.round(s.start * 100) / 100, end: Math.round(s.end * 100) / 100, text: s.text }));
        const head = !lines.length ? 'No speech found.' : r.hasText ? `${lines.length} line(s):` : `Speech at ${lines.length} place(s), but no words: the speech model could not run${lastSpeechError ? ` (${lastSpeechError})` : ' (it needs internet once to download)'}. Tell the user this exact reason. Times:`;
        return { text: [head, ...lines.map((l) => `[${fmtTime(l.start)}–${fmtTime(l.end)}] ${l.text || '(speech)'}`)].join('\n'), data: { hasWords: r.hasText, lines } };
      },
    }),

    defineTool({
      name: 'video_look',
      title: 'See the video',
      description:
        'Look at a sequence: frames sampled across a time range (or one clip), each with a grid in sequence pixels and its time, so you can see what is where (for example where a hand or a face is) and give exact coordinates to other tools. For each frame it also lists what is on screen in the edit (clips, pictures, titles and animation) with its box, top-most first, and what is being said then if a transcript exists.',
      category: 'video',
      access: 'read',
      input: {
        projectId: zProjectId,
        sequenceId: z.string(),
        clipId: z.string().optional().describe('Look only at this clip’s time range'),
        start: z.number().min(0).optional(),
        end: z.number().min(0).optional(),
        count: z.number().int().min(1).max(12).default(6).describe('How many frames'),
        maxSize: z.number().int().min(128).max(1024).default(512).describe('Longest side of each frame in pixels'),
        grid: z.boolean().default(true),
      },
      output: z.object({ frames: z.array(z.object({ time: z.number(), onScreen: z.array(z.record(z.string(), z.unknown())) })), width: z.number(), height: z.number() }),
      example: { input: { projectId: 'prj_8Kq2...', sequenceId: 'seq_main', count: 4 }, output: { frames: [{ time: 0.5, onScreen: [{ id: 'clp_1', kind: 'video', name: 'Interview', box: { x: 0, y: 0, width: 1920, height: 1080 } }] }], width: 1920, height: 1080 } },
      async handler(args, ctx) {
        await ctx.requireProject(args.projectId, 'read');
        const state = await ctx.state(args.projectId);
        const { seq, from, to } = range(state, args.sequenceId, args.clipId, args.start, args.end);
        const n = args.count;
        const times = Array.from({ length: n }, (_, i) => Math.round((n === 1 ? from : from + ((to - from) * (i + 0.5)) / n) * 100) / 100);
        const rendered = await sequenceFrames(services, state, args.sequenceId, times, args.maxSize);
        const images: { data: Buffer; mimeType: string }[] = [];
        const frames: { time: number; onScreen: Record<string, unknown>[] }[] = [];
        const lines: string[] = [`"${seq.props.name}" is ${seq.props.width}×${seq.props.height}; x grows to the right and y downwards from the top-left. Frames:`];
        // Speech for the same moments, when a transcript already exists (it is not made here).
        const said = await cachedTranscript(services, state, args.sequenceId);
        for (const r of rendered) {
          if (args.grid) drawGrid(r.canvas, r.scale, seq.props.width, seq.props.height, r.time);
          images.push({ data: await framePng(r.canvas), mimeType: 'image/png' });
          const items = await onScreenAt(services, state, args.sequenceId, r.time);
          frames.push({ time: r.time, onScreen: items as unknown as Record<string, unknown>[] });
          const words = said.filter((s) => s.start <= r.time && s.end >= r.time).map((s) => s.text).join(' ');
          lines.push(`${fmtTime(r.time)}: ${describeOnScreen(items)}${words ? `. Said: "${words}"` : ''}`);
        }
        if (!said.length) lines.push('For what is said, call video_transcript.');
        return { text: lines.join('\n'), data: { frames, width: seq.props.width, height: seq.props.height }, images };
      },
    }),

    defineTool({
      name: 'video_track',
      title: 'Follow something that moves',
      description:
        'Follow a point of the picture (for example the centre of a hand, found with video_look) from one time to another, and get its position over time in sequence pixels. With followClipId, that clip (a picture, sticker or title) is keyframed to move with it, centred on the point plus offsetX/offsetY. Confidence drops where the point is hidden or changes a lot; check those moments with video_look.',
      category: 'video',
      access: 'write',
      input: {
        projectId: zProjectId,
        sequenceId: z.string(),
        x: z.number().describe('Point to follow, in sequence pixels, at time `from`'),
        y: z.number(),
        from: z.number().min(0),
        to: z.number().min(0),
        radius: z.number().min(4).max(400).default(40).describe('Half-size of the area that is followed, in sequence pixels'),
        maxMove: z.number().min(4).max(600).default(80).describe('Most it moves between two tracked frames, in sequence pixels'),
        fps: z.number().min(2).max(30).default(12).describe('Tracked positions per second'),
        followClipId: z.string().optional().describe('A clip to move along with the point'),
        offsetX: z.number().default(0),
        offsetY: z.number().default(0),
      },
      output: zWriteResult.partial({ status: true }).extend({ points: z.array(z.object({ time: z.number(), x: z.number(), y: z.number(), confidence: z.number() })), lowConfidence: z.array(z.number()) }),
      example: { input: { projectId: 'prj_8Kq2...', sequenceId: 'seq_main', x: 820, y: 610, from: 2, to: 5, followClipId: 'clp_sticker' }, output: { status: 'committed', commitId: 'c_tr...', points: [{ time: 2, x: 820, y: 610, confidence: 1 }], lowConfidence: [] } },
      async handler(args, ctx) {
        if (!(args.to > args.from)) throw new ToolError('to must be after from.');
        if (args.to - args.from > 60) throw new ToolError('Follow at most 60 seconds at a time.');
        await ctx.requireProject(args.projectId, args.followClipId ? 'write' : 'read');
        const state = await ctx.state(args.projectId);
        const seq = need(state, args.sequenceId, 'sequence', 'sequence');
        const follow = args.followClipId ? need(state, args.followClipId, 'clip', 'clip') : null;
        const points = await trackPoint(services, state, args.sequenceId, { x: args.x, y: args.y, from: args.from, to: args.to, radius: args.radius, maxMove: args.maxMove, fps: args.fps, exclude: follow ? [follow.id] : [] });
        const lowConfidence = points.filter((p) => p.confidence < 0.5).map((p) => p.time);
        const summary = `Followed (${args.x}, ${args.y}) from ${fmtTime(args.from)} to ${fmtTime(args.to)}: ends at (${points[points.length - 1]!.x}, ${points[points.length - 1]!.y}).${lowConfidence.length ? ` Unsure at ${lowConfidence.length} moment(s), from ${fmtTime(lowConfidence[0]!)}; check with video_look.` : ''}`;
        if (!follow) return { text: summary, data: { points, lowConfidence } };
        // Clip positions are offsets of the clip's centre from the frame's centre, keyed from the clip's start.
        const key = (v: (p: (typeof points)[number]) => number): Keyframe[] => points.filter((p) => p.time >= follow.props.start - 1e-6 && p.time <= clipEnd(follow.props) + 1e-6).map((p) => ({ time: Math.round((p.time - follow.props.start) * 1000) / 1000, value: Math.round(v(p)), easing: 'linear' }));
        const xs = key((p) => p.x + args.offsetX - seq.props.width / 2);
        const ys = key((p) => p.y + args.offsetY - seq.props.height / 2);
        if (!xs.length) throw new ToolError(`"${follow.props.name}" is not on the timeline between ${fmtTime(args.from)} and ${fmtTime(args.to)}. Move or lengthen it first.`);
        const out = await edit(ctx, args.projectId, `Make "${follow.props.name}" follow a point`, (s) => {
          const c = s.nodes[follow.id] as SceneNode<'clip'>;
          return [{ kind: 'update', id: c.id, set: { keyframes: { ...c.props.keyframes, x: xs, y: ys } } }];
        });
        return { ...writeResult(out, { points, lowConfidence }), text: `${summary} "${follow.props.name}" now moves with it (${xs.length} keyframes).` };
      },
    }),
  ] as unknown as ToolDef[];
}

useModule(({ services }) => {
  registerToolProvider(services, videoTools);
});
