import { z } from 'zod';
import { BLEND_MODES, TOOL_KINDS } from './types.js';
import { NODE_TYPES, type NodeType } from './nodes.js';
import { isColor } from './color.js';
import type { Operation } from './ops.js';

/**
 * Runtime schemas for everything that can arrive from outside the process
 * (AI tool calls, collaborators, plugins, imported files). Operations that fail
 * validation never reach the operation log.
 */

export const zColor = z.string().refine(isColor, { message: 'Expected a color like #rrggbb' });
export const zPoint = z.object({ x: z.number(), y: z.number() });
export const zAuthor = z.object({ type: z.enum(['human', 'ai', 'system']), id: z.string(), name: z.string() });

export const zEasing = z.union([
  z.enum(['linear', 'hold', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'back-out', 'bounce-out']),
  z.object({ bezier: z.tuple([z.number(), z.number(), z.number(), z.number()]) }),
]);
export const zKeyframe = z.object({ time: z.number(), value: z.number(), easing: zEasing });
export const zKeyframes = z.partialRecord(z.enum(['x', 'y', 'scale', 'rotation', 'opacity', 'volume', 'blur']), z.array(zKeyframe));

export const zPathAnchor = z.object({ x: z.number(), y: z.number(), in: zPoint.optional(), out: zPoint.optional() });
export const zBezierPath = z.object({ closed: z.boolean(), anchors: z.array(zPathAnchor) });

export const zSelection = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rect'), x: z.number(), y: z.number(), width: z.number(), height: z.number(), feather: z.number().optional() }),
  z.object({ kind: z.literal('ellipse'), x: z.number(), y: z.number(), width: z.number(), height: z.number(), feather: z.number().optional() }),
  z.object({ kind: z.literal('polygon'), points: z.array(zPoint).min(3), feather: z.number().optional() }),
  z.object({ kind: z.literal('mask'), assetId: z.string(), feather: z.number().optional() }),
]);

export const zStroke = z.object({
  id: z.string(),
  tool: z.enum(['brush', 'eraser', 'heal', 'clone']),
  color: zColor,
  size: z.number().positive().max(5000),
  hardness: z.number().min(0).max(1),
  opacity: z.number().min(0).max(1),
  tip: z.union([z.enum(['round', 'square']), z.object({ assetId: z.string() })]),
  spacing: z.number().min(0.01).max(10),
  sourceOffset: zPoint.optional(),
  clip: z.lazy(() => zSelection).nullable().optional(),
  points: z.array(z.object({ x: z.number(), y: z.number(), pressure: z.number().min(0).max(1) })).max(100000),
});

export const zVectorShape = z.object({
  id: z.string(),
  kind: z.enum(['rect', 'ellipse', 'polygon', 'path', 'line']),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  radius: z.number().optional(),
  points: z.array(zPoint).optional(),
  path: zBezierPath.optional(),
  fill: zColor.nullable(),
  stroke: zColor.nullable(),
  strokeWidth: z.number().min(0),
});

export const zGeneration = z.object({ kind: z.enum(['fill', 'extend', 'style']), prompt: z.string().max(2000), provider: z.string().max(200), maskAssetId: z.string().nullable().optional(), createdAt: z.string() });

export const zAdjustment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('curves'), channel: z.enum(['rgb', 'r', 'g', 'b']), points: z.array(z.tuple([z.number(), z.number()])).min(2) }),
  z.object({
    kind: z.literal('levels'),
    inBlack: z.number().min(0).max(255),
    inWhite: z.number().min(0).max(255),
    gamma: z.number().min(0.1).max(10),
    outBlack: z.number().min(0).max(255),
    outWhite: z.number().min(0).max(255),
  }),
  z.object({ kind: z.literal('hueSaturation'), hue: z.number().min(-180).max(180), saturation: z.number().min(-100).max(100), lightness: z.number().min(-100).max(100) }),
  z.object({
    kind: z.literal('colorBalance'),
    shadows: z.tuple([z.number(), z.number(), z.number()]),
    midtones: z.tuple([z.number(), z.number(), z.number()]),
    highlights: z.tuple([z.number(), z.number(), z.number()]),
  }),
  z.object({ kind: z.literal('brightnessContrast'), brightness: z.number().min(-100).max(100), contrast: z.number().min(-100).max(100) }),
  z.object({ kind: z.literal('lut'), assetId: z.string(), intensity: z.number().min(0).max(1) }),
  z.object({ kind: z.literal('invert') }),
  z.object({ kind: z.literal('temperature'), amount: z.number().min(-100).max(100) }),
]);

export const zFilterKind = z.enum(['gaussianBlur', 'sharpen', 'noise', 'pixelate', 'grayscale', 'sepia', 'vignette', 'emboss', 'edgeDetect']);
export const zSmartFilter = z.object({
  id: z.string(),
  filter: zFilterKind,
  params: z.record(z.string(), z.number()),
  enabled: z.boolean(),
  opacity: z.number().min(0).max(1),
});

export const zEditFxKind = z.enum(['shake', 'zoomPunch', 'flash', 'rgbSplit', 'glitch', 'strobe', 'letterbox', 'vhs']);

export const zTransition = z.object({
  kind: z.enum(['crossfade', 'dip-to-black', 'wipe-left', 'wipe-right', 'slide-left', 'zoom', 'whip-left', 'whip-right', 'zoom-punch', 'spin', 'flash', 'glitch']),
  duration: z.number().min(0).max(30),
  easing: zEasing,
});

export const zTitleSpec = z.object({
  text: z.string(),
  fontFamily: z.string(),
  fontSize: z.number().positive(),
  fontWeight: z.number(),
  color: zColor,
  background: zColor.nullable(),
  align: z.enum(['left', 'center', 'right']),
  caption: z.boolean(),
});

export const zChartSpec = z.object({
  type: z.enum(['bar', 'line', 'scatter', 'pie', 'area']),
  title: z.string().optional(),
  labels: z.array(z.string()),
  series: z.array(z.object({ name: z.string(), values: z.array(z.number()), color: zColor.optional() })),
  xLabel: z.string().optional(),
  yLabel: z.string().optional(),
});

export const zEmbedRef = z.object({
  kind: z.enum(['cell-output', 'asset', 'chart', 'canvas', 'sequence-frame', 'slide']),
  ref: z.string(),
  time: z.number().optional(),
});

export const zCellOutput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stdout'), text: z.string() }),
  z.object({ kind: z.literal('stderr'), text: z.string() }),
  z.object({ kind: z.literal('result'), text: z.string() }),
  z.object({ kind: z.literal('error'), name: z.string(), message: z.string(), traceback: z.string().optional() }),
  z.object({ kind: z.literal('image'), assetId: z.string(), mime: z.string() }),
  z.object({ kind: z.literal('chart'), spec: zChartSpec }),
  z.object({ kind: z.literal('table'), columns: z.array(z.string()), rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))) }),
]);

export const zElementAnimation = z.object({
  id: z.string(),
  kind: z.enum(['fade-in', 'fade-out', 'fly-in', 'fly-out', 'zoom-in', 'pulse', 'spin', 'custom']),
  delay: z.number().min(0),
  duration: z.number().min(0),
  easing: zEasing,
  trigger: z.enum(['on-enter', 'on-click', 'with-previous']),
  click: z.number().int().min(1).max(200).nullable().optional(),
  keyframes: zKeyframes.optional(),
});

const zTextStyle = z.object({
  fontFamily: z.string(),
  fontSize: z.number().positive(),
  fontWeight: z.number(),
  color: zColor,
  lineHeight: z.number().positive(),
  spaceBefore: z.number(),
  spaceAfter: z.number(),
  italic: z.boolean().optional(),
});

const zBone = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  length: z.number().min(0),
  angle: z.number(),
  x: z.number(),
  y: z.number(),
  attachment: z
    .object({ assetId: z.string().nullable(), shape: zVectorShape.nullable(), offsetX: z.number(), offsetY: z.number() })
    .nullable(),
});

/** Prop schemas per node type. Partial versions are used to validate `update` operations. */
export const PROP_SCHEMAS: Record<NodeType, z.ZodObject> = {
  project: z.object({ name: z.string().max(200), primaryTool: z.enum(TOOL_KINDS as [string, ...string[]]), aiConsent: z.boolean(), description: z.string() }),
  notes: z.object({ name: z.string() }),
  note: z.object({ kind: z.enum(['decision', 'prompt', 'rejected', 'note']), text: z.string().max(20000), author: zAuthor, createdAt: z.string(), auto: z.boolean().optional(), ref: z.object({ proposalId: z.string().optional(), jobId: z.string().optional(), commitId: z.string().optional() }).optional() }),
  comments: z.object({ name: z.string() }),
  comment: z.object({
    anchor: z.object({
      tool: z.enum(TOOL_KINDS as [string, ...string[]]),
      nodeId: z.string(),
      x: z.number().optional(),
      y: z.number().optional(),
      time: z.number().optional(),
      line: z.number().optional(),
      range: z.tuple([z.number(), z.number()]).optional(),
    }),
    text: z.string().max(20000),
    author: zAuthor,
    createdAt: z.string(),
    resolved: z.boolean(),
    replies: z.array(z.object({ id: z.string(), author: zAuthor, text: z.string(), createdAt: z.string() })),
  }),
  canvas: z.object({
    name: z.string(),
    width: z.number().int().min(1).max(16384),
    height: z.number().int().min(1).max(16384),
    background: zColor.nullable(),
    colorProfile: z.enum(['srgb', 'display-p3']),
    selection: zSelection.nullable(),
  }),
  layer: z.object({
    name: z.string(),
    layerType: z.enum(['raster', 'vector', 'text', 'adjustment', 'fill', 'group']),
    visible: z.boolean(),
    locked: z.boolean(),
    opacity: z.number().min(0).max(1),
    blendMode: z.enum(BLEND_MODES as [string, ...string[]]),
    x: z.number(),
    y: z.number(),
    scaleX: z.number(),
    scaleY: z.number(),
    rotation: z.number(),
    mask: z.object({ source: zSelection, inverted: z.boolean(), enabled: z.boolean() }).nullable(),
    vectorMask: zBezierPath.nullable(),
    filters: z.array(zSmartFilter),
    assetId: z.string().nullable().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    strokes: z.array(zStroke).optional(),
    shapes: z.array(zVectorShape).optional(),
    text: z.string().optional(),
    fontFamily: z.string().optional(),
    fontSize: z.number().positive().optional(),
    fontWeight: z.number().optional(),
    fontStyle: z.enum(['normal', 'italic']).optional(),
    fontVariations: z.record(z.string(), z.number()).optional(),
    color: zColor.optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    lineHeight: z.number().optional(),
    letterSpacing: z.number().optional(),
    baselineShift: z.number().optional(),
    textPath: zBezierPath.nullable().optional(),
    boxWidth: z.number().nullable().optional(),
    adjustment: zAdjustment.optional(),
    fillColor: zColor.optional(),
    generation: zGeneration.nullable().optional(),
  }),
  sequence: z.object({
    name: z.string(),
    purpose: z.enum(['video', 'recense', 'animation']),
    width: z.number().int().min(16).max(8192),
    height: z.number().int().min(16).max(8192),
    fps: z.number().min(1).max(240),
    duration: z.number().min(0).max(36000),
    background: zColor,
    playback: z.enum(['once', 'loop', 'pingpong']),
    beats: z.array(z.number().min(0)).max(20000).optional(),
    bpm: z.number().min(0).max(400).nullable().optional(),
  }),
  track: z.object({
    name: z.string(),
    trackType: z.enum(['video', 'audio', 'title', 'effect', 'animation']),
    muted: z.boolean(),
    locked: z.boolean(),
    hidden: z.boolean(),
    gain: z.number().min(-60).max(24),
    pan: z.number().min(-1).max(1),
    ducking: z.object({ enabled: z.boolean(), sourceTrackId: z.string().nullable(), amountDb: z.number().min(-60).max(0) }),
  }),
  clip: z.object({
    name: z.string(),
    assetId: z.string().nullable(),
    start: z.number().min(0),
    in: z.number().min(0),
    out: z.number().min(0),
    sourceDuration: z.number().min(0),
    speed: z.number().positive().max(100),
    reverse: z.boolean(),
    speedRamp: z.array(z.object({ t: z.number().min(0).max(1), speed: z.number().positive().max(100) })).nullable(),
    x: z.number(),
    y: z.number(),
    scale: z.number(),
    rotation: z.number(),
    opacity: z.number().min(0).max(1),
    volume: z.number().min(-60).max(24),
    keyframes: zKeyframes,
    effects: z.array(z.object({ id: z.string(), effect: z.union([zFilterKind, z.literal('colorGrade'), zEditFxKind]), params: z.record(z.string(), z.number()), enabled: z.boolean(), assetId: z.string().nullable().optional() })),
    transitionIn: zTransition.nullable(),
    transitionOut: zTransition.nullable(),
    title: zTitleSpec.nullable(),
    backgroundRemoval: z
      .object({ enabled: z.boolean(), method: z.enum(['chroma', 'auto', 'provider']), keyColor: zColor, tolerance: z.number().min(0).max(1), softness: z.number().min(0).max(1) })
      .nullable(),
    generation: zGeneration
      .extend({ region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable().optional(), sourceAssetId: z.string(), sourceIn: z.number(), sourceOut: z.number() })
      .nullable()
      .optional(),
  }),
  animLayer: z.object({
    name: z.string(),
    start: z.number().min(0),
    duration: z.number().min(0),
    visible: z.boolean(),
    frames: z.array(z.object({ id: z.string(), hold: z.number().int().min(1), shapes: z.array(zVectorShape), strokes: z.array(zStroke), assetId: z.string().nullable() })),
    sprite: z
      .object({ assetId: z.string(), columns: z.number().int().min(1), rows: z.number().int().min(1), frameCount: z.number().int().min(1), frameWidth: z.number(), frameHeight: z.number() })
      .nullable(),
    rig: z.object({ bones: z.array(zBone), poses: z.array(z.object({ time: z.number(), angles: z.record(z.string(), z.number()), easing: zEasing })) }).nullable(),
    motionPath: z.object({ path: zBezierPath, orientToPath: z.boolean(), easing: zEasing }).nullable(),
    x: z.number(),
    y: z.number(),
    scale: z.number(),
    rotation: z.number(),
    opacity: z.number().min(0).max(1),
    anchorX: z.number(),
    anchorY: z.number(),
    keyframes: zKeyframes,
    onionSkin: z.object({ enabled: z.boolean(), before: z.number().int().min(0).max(10), after: z.number().int().min(0).max(10) }),
    playback: z.enum(['once', 'loop', 'pingpong']),
  }),
  codeWorkspace: z.object({ name: z.string(), allowNetwork: z.boolean(), packages: z.array(z.string()).max(32), entry: z.string().nullable() }),
  codeFile: z.object({
    path: z.string().min(1).max(512).refine((p) => !p.includes('..') && !p.startsWith('/'), { message: 'Paths must be relative and stay inside the workspace' }),
    language: z.enum(['python', 'javascript', 'typescript', 'json', 'markdown', 'css', 'html', 'text']),
    content: z.string().max(2_000_000),
  }),
  notebook: z.object({ name: z.string(), language: z.enum(['python', 'javascript', 'typescript']) }),
  cell: z.object({
    cellType: z.enum(['code', 'markdown']),
    language: z.enum(['python', 'javascript', 'typescript']),
    source: z.string().max(500_000),
    outputs: z.array(zCellOutput),
    executionCount: z.number().int().min(0),
    lastRunAt: z.string().nullable(),
    lastRunMs: z.number().nullable(),
  }),
  document: z.object({ name: z.string(), styles: z.record(z.string(), zTextStyle), pageSize: z.enum(['a4', 'letter']) }),
  block: z.object({
    blockType: z.enum(['heading', 'paragraph', 'bullet', 'numbered', 'todo', 'quote', 'code', 'table', 'image', 'embed', 'divider']),
    text: z.string().max(200_000),
    level: z.number().int().min(0).max(6).optional(),
    language: z.string().optional(),
    checked: z.boolean().optional(),
    rows: z.array(z.array(z.string())).optional(),
    assetId: z.string().nullable().optional(),
    caption: z.string().optional(),
    embed: zEmbedRef.nullable().optional(),
    style: z.string().nullable().optional(),
  }),
  suggestion: z.object({
    blockId: z.string(),
    kind: z.enum(['replace', 'insert-after', 'delete']),
    text: z.string(),
    blockType: z.enum(['heading', 'paragraph', 'bullet', 'numbered', 'todo', 'quote', 'code', 'table', 'image', 'embed', 'divider']).optional(),
    author: zAuthor,
    createdAt: z.string(),
    status: z.enum(['open', 'accepted', 'rejected']),
    reason: z.string().optional(),
  }),
  deck: z.object({
    name: z.string(),
    width: z.number().int().min(16).max(8192),
    height: z.number().int().min(16).max(8192),
    theme: z.object({
      name: z.string(),
      colors: z.object({ background: zColor, surface: zColor, text: zColor, muted: zColor, accent: zColor, accent2: zColor }),
      fonts: z.object({ heading: z.string(), body: z.string(), mono: z.string() }),
      sizes: z.object({ title: z.number(), heading: z.number(), body: z.number(), caption: z.number() }),
    }),
    masters: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        background: zColor.nullable(),
        placeholders: z.array(z.object({ role: z.enum(['title', 'subtitle', 'body', 'image', 'footer']), x: z.number(), y: z.number(), w: z.number(), h: z.number() })),
      }),
    ),
    shareId: z.string().nullable(),
  }),
  slide: z.object({
    name: z.string(),
    masterId: z.string().nullable(),
    layout: z.enum(['title', 'title-body', 'two-column', 'image-full', 'blank', 'section']),
    background: zColor.nullable(),
    notes: z.string().max(50_000),
    transition: z.object({ kind: z.enum(['none', 'fade', 'push', 'wipe', 'zoom']), duration: z.number().min(0).max(10), easing: zEasing }),
    rehearsalSeconds: z.number().nullable(),
    hidden: z.boolean(),
  }),
  slideElement: z.object({
    elementType: z.enum(['text', 'image', 'video', 'shape', 'chart', 'embed']),
    role: z.enum(['title', 'subtitle', 'body', 'image', 'footer']).nullable(),
    x: z.number(),
    y: z.number(),
    w: z.number().min(0),
    h: z.number().min(0),
    rotation: z.number(),
    opacity: z.number().min(0).max(1),
    text: z.string().optional(),
    fontSize: z.number().positive().nullable().optional(),
    fontFamily: z.string().nullable().optional(),
    color: zColor.nullable().optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    valign: z.enum(['top', 'middle', 'bottom']).nullable().optional(),
    bold: z.boolean().optional(),
    assetId: z.string().nullable().optional(),
    shape: zVectorShape.nullable().optional(),
    chart: zChartSpec.nullable().optional(),
    embed: zEmbedRef.nullable().optional(),
    animations: z.array(zElementAnimation),
  }),
};

const zNodeId = z.string().min(1).max(128).regex(/^[\w-]+$/, 'Ids may contain letters, digits, _ and -');

export const zSceneNode = z.object({
  id: zNodeId,
  type: z.enum(NODE_TYPES),
  parentId: z.string().nullable(),
  children: z.array(z.string()),
  props: z.record(z.string(), z.unknown()),
});

export const zOperation: z.ZodType<Operation> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('create'), parentId: z.string(), index: z.number().int().optional(), nodes: z.array(zSceneNode).min(1).max(5000) }),
    z.object({ kind: z.literal('delete'), id: z.string() }),
    z.object({ kind: z.literal('update'), id: z.string(), set: z.record(z.string(), z.unknown()), unset: z.array(z.string()).optional(), base: z.record(z.string(), z.string()).optional() }),
    z.object({ kind: z.literal('move'), id: z.string(), parentId: z.string(), index: z.number().int().optional() }),
    z.object({ kind: z.literal('listInsert'), id: z.string(), prop: z.string(), index: z.number().int().optional(), items: z.array(z.unknown()).max(100000) }),
    z.object({ kind: z.literal('listRemove'), id: z.string(), prop: z.string(), index: z.number().int().min(0), count: z.number().int().min(1), expect: z.array(z.unknown()).max(100000).optional() }),
    z.object({ kind: z.literal('listUpdate'), id: z.string(), prop: z.string(), itemId: z.string(), set: z.record(z.string(), z.unknown()), unset: z.array(z.string()).max(1000).optional() }),
    z.object({ kind: z.literal('batch'), ops: z.array(zOperation).max(5000) }),
  ]),
) as z.ZodType<Operation>;

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Validate a node's props against its type schema. */
export function validateNodeProps(type: NodeType, props: unknown, partial = false): ValidationIssue[] {
  const schema = PROP_SCHEMAS[type];
  const s = partial ? schema.partial().strict() : schema.strict();
  const r = s.safeParse(props);
  return r.success ? [] : r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/**
 * Deep validation of an operation against current node types. `typeOf` resolves existing node ids
 * (needed for `update` ops, whose payloads are partial props of the target node).
 */
export function validateOperation(op: unknown, typeOf: (id: string) => NodeType | undefined): ValidationIssue[] {
  const parsed = zOperation.safeParse(op);
  if (!parsed.success) return parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  const issues: ValidationIssue[] = [];
  const created = new Map<string, NodeType>();
  const visit = (o: Operation, path: string) => {
    switch (o.kind) {
      case 'create':
        o.nodes.forEach((n, i) => {
          created.set(n.id, n.type);
          for (const issue of validateNodeProps(n.type, n.props)) issues.push({ path: `${path}.nodes.${i}.props.${issue.path}`, message: issue.message });
        });
        break;
      case 'update': {
        const t = created.get(o.id) ?? typeOf(o.id);
        if (!t) {
          issues.push({ path: `${path}.id`, message: `Unknown node ${o.id}` });
          break;
        }
        for (const issue of validateNodeProps(t, o.set, true)) issues.push({ path: `${path}.set.${issue.path}`, message: issue.message });
        break;
      }
      case 'listInsert': {
        const t = created.get(o.id) ?? typeOf(o.id);
        if (!t) {
          issues.push({ path: `${path}.id`, message: `Unknown node ${o.id}` });
          break;
        }
        const shape = PROP_SCHEMAS[t].shape as Record<string, z.ZodType>;
        const listSchema = shape[o.prop];
        if (!listSchema) {
          issues.push({ path: `${path}.prop`, message: `${t} has no list prop ${o.prop}` });
          break;
        }
        const r = listSchema.safeParse(o.items);
        if (!r.success) for (const i of r.error.issues) issues.push({ path: `${path}.items.${i.path.join('.')}`, message: i.message });
        break;
      }
      case 'batch':
        o.ops.forEach((sub, i) => visit(sub, `${path}.ops.${i}`));
        break;
      default:
        break;
    }
  };
  visit(parsed.data, 'op');
  return issues;
}
