import type { Author, BlendMode, Color, Point, ToolKind } from './types.js';
import type { Easing, Keyframe } from './keyframes.js';
import type { BezierPath } from './paths.js';

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

export interface ProjectProps {
  name: string;
  primaryTool: ToolKind;
  /** Explicit per-project consent: no AI operation may run on this project's data unless true. */
  aiConsent: boolean;
  description: string;
}

export type NoteKind = 'decision' | 'prompt' | 'rejected' | 'note';

export interface NoteProps {
  kind: NoteKind;
  text: string;
  author: Author;
  createdAt: string;
  /** Recorded by Omnix from something that happened (a rejection, an approved command, a gate). */
  auto?: boolean;
  /** What the note is about, so the panel can link to it. */
  ref?: { proposalId?: string; jobId?: string; commitId?: string };
}

/** Where a comment is pinned. Exactly one tool-specific locator is normally set. */
export interface CommentAnchor {
  tool: ToolKind;
  nodeId: string;
  /** Canvas or slide coordinates. */
  x?: number;
  y?: number;
  /** Timeline time in seconds. */
  time?: number;
  /** Code line (1-based). */
  line?: number;
  /** Character range inside a document block. */
  range?: [number, number];
}

export interface CommentReply {
  id: string;
  author: Author;
  text: string;
  createdAt: string;
}

export interface CommentProps {
  anchor: CommentAnchor;
  text: string;
  author: Author;
  createdAt: string;
  resolved: boolean;
  replies: CommentReply[];
}

/* ------------------------------------------------------------------ */
/* Image editor                                                        */
/* ------------------------------------------------------------------ */

export type Selection =
  | { kind: 'rect'; x: number; y: number; width: number; height: number; feather?: number }
  | { kind: 'ellipse'; x: number; y: number; width: number; height: number; feather?: number }
  | { kind: 'polygon'; points: Point[]; feather?: number }
  /** Raster selection stored as an 8-bit alpha mask asset at canvas resolution. */
  | { kind: 'mask'; assetId: string; feather?: number };

export interface CanvasProps {
  name: string;
  width: number;
  height: number;
  background: Color | null;
  colorProfile: 'srgb' | 'display-p3';
  selection: Selection | null;
}

export type LayerType = 'raster' | 'vector' | 'text' | 'adjustment' | 'fill' | 'group';

export interface LayerMask {
  /** The mask's geometry. Masks are non-destructive and can be disabled. */
  source: Selection;
  inverted: boolean;
  enabled: boolean;
}

export type StrokeTool = 'brush' | 'eraser' | 'heal' | 'clone';

export interface StrokePoint {
  x: number;
  y: number;
  /** 0..1 stylus pressure (1 for mouse). */
  pressure: number;
}

export interface Stroke {
  id: string;
  tool: StrokeTool;
  color: Color;
  size: number;
  hardness: number;
  opacity: number;
  /** Brush tip: round, square, or an asset id for a custom tip image. */
  tip: 'round' | 'square' | { assetId: string };
  /** Spacing between dabs as a fraction of size. */
  spacing: number;
  /** For clone/heal: offset from destination to sample source. */
  sourceOffset?: Point;
  /** Paint only inside this selection (canvas coordinates), like painting with an active selection. */
  clip?: Selection | null;
  points: StrokePoint[];
}

export type ShapeKind = 'rect' | 'ellipse' | 'polygon' | 'path' | 'line';

export interface VectorShape {
  id: string;
  kind: ShapeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
  points?: Point[];
  path?: BezierPath;
  fill: Color | null;
  stroke: Color | null;
  strokeWidth: number;
}

export type Adjustment =
  | { kind: 'curves'; channel: 'rgb' | 'r' | 'g' | 'b'; points: [number, number][] }
  | { kind: 'levels'; inBlack: number; inWhite: number; gamma: number; outBlack: number; outWhite: number }
  | { kind: 'hueSaturation'; hue: number; saturation: number; lightness: number }
  | {
      kind: 'colorBalance';
      shadows: [number, number, number];
      midtones: [number, number, number];
      highlights: [number, number, number];
    }
  | { kind: 'brightnessContrast'; brightness: number; contrast: number }
  | { kind: 'lut'; assetId: string; intensity: number }
  | { kind: 'invert' }
  | { kind: 'temperature'; amount: number };

export type FilterKind =
  | 'gaussianBlur'
  | 'sharpen'
  | 'noise'
  | 'pixelate'
  | 'grayscale'
  | 'sepia'
  | 'vignette'
  | 'emboss'
  | 'edgeDetect';

/** Smart filters are stored on the layer and applied at render time (non-destructive). */
export interface SmartFilter {
  id: string;
  filter: FilterKind;
  params: Record<string, number>;
  enabled: boolean;
  opacity: number;
}

/** How generated content was made, so the editor can show the prompt and mask and offer to redo it. */
export interface GenerationInfo {
  kind: 'fill' | 'extend' | 'style';
  prompt: string;
  /** Which provider produced it ("builtin" or the configured image model). */
  provider: string;
  /** The area that was generated (a grayscale mask asset), shown to the user. */
  maskAssetId?: string | null;
  createdAt: string;
}

/** Generated video: the clip now plays a new render; the original is kept for comparison and undo. */
export interface ClipGeneration extends GenerationInfo {
  /** The generated area in source-video pixels. */
  region?: { x: number; y: number; width: number; height: number } | null;
  sourceAssetId: string;
  sourceIn: number;
  sourceOut: number;
}

export interface LayerProps {
  name: string;
  layerType: LayerType;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: BlendMode;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  mask: LayerMask | null;
  vectorMask: BezierPath | null;
  filters: SmartFilter[];
  /** raster */
  assetId?: string | null;
  width?: number;
  height?: number;
  strokes?: Stroke[];
  /** vector */
  shapes?: VectorShape[];
  /** text */
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  fontStyle?: 'normal' | 'italic';
  fontVariations?: Record<string, number>;
  color?: Color;
  align?: 'left' | 'center' | 'right';
  lineHeight?: number;
  letterSpacing?: number;
  baselineShift?: number;
  textPath?: BezierPath | null;
  boxWidth?: number | null;
  /** adjustment */
  adjustment?: Adjustment;
  /** fill */
  fillColor?: Color;
  /** Set on layers made by generative fill or extend. */
  generation?: GenerationInfo | null;
}

/* ------------------------------------------------------------------ */
/* Video + animation timeline                                          */
/* ------------------------------------------------------------------ */

export type PlaybackMode = 'once' | 'loop' | 'pingpong';

export interface SequenceProps {
  name: string;
  /** Video and animation share one timeline engine; this picks the editor UI. */
  purpose: 'video' | 'animation';
  width: number;
  height: number;
  fps: number;
  /** Total length in seconds. */
  duration: number;
  background: Color;
  playback: PlaybackMode;
}

export type TrackType = 'video' | 'audio' | 'title' | 'effect' | 'animation';

export interface DuckingSettings {
  enabled: boolean;
  /** The track whose audio triggers ducking (usually dialogue). */
  sourceTrackId: string | null;
  amountDb: number;
}

export interface TrackProps {
  name: string;
  trackType: TrackType;
  muted: boolean;
  locked: boolean;
  hidden: boolean;
  /** Track gain in dB. */
  gain: number;
  /** -1 (left) .. 1 (right). */
  pan: number;
  ducking: DuckingSettings;
}

export type TransitionKind = 'crossfade' | 'dip-to-black' | 'wipe-left' | 'wipe-right' | 'slide-left' | 'zoom';

export interface Transition {
  kind: TransitionKind;
  duration: number;
  easing: Easing;
}

export interface ClipEffect {
  id: string;
  effect: FilterKind | 'colorGrade';
  params: Record<string, number>;
  enabled: boolean;
  /** colorGrade: an optional .cube LUT asset (a look, for example from a style reference). */
  assetId?: string | null;
}

export interface TitleSpec {
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: Color;
  background: Color | null;
  align: 'left' | 'center' | 'right';
  /** Caption-style titles are positioned automatically near the bottom. */
  caption: boolean;
}

export interface BackgroundRemoval {
  enabled: boolean;
  method: 'chroma' | 'auto' | 'provider';
  keyColor: Color;
  tolerance: number;
  softness: number;
}

/** Animatable clip and layer properties. */
export type AnimatableProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity' | 'volume' | 'blur';
export const ANIMATABLE_PROPS: readonly AnimatableProp[] = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume', 'blur'];

export interface ClipProps {
  name: string;
  /** Media for video/audio clips. Null for title clips. */
  assetId: string | null;
  /** Position on the timeline in seconds. */
  start: number;
  /** In and out points in the source media, seconds. out - in is the source span used. */
  in: number;
  out: number;
  /** Source duration (for slip limits); 0 when unknown or for stills/titles. */
  sourceDuration: number;
  speed: number;
  reverse: boolean;
  /** Optional speed ramp: piecewise speed over normalized clip time (0..1). */
  speedRamp: { t: number; speed: number }[] | null;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  /** Clip volume in dB (audio). */
  volume: number;
  keyframes: Partial<Record<AnimatableProp, Keyframe[]>>;
  effects: ClipEffect[];
  transitionIn: Transition | null;
  transitionOut: Transition | null;
  title: TitleSpec | null;
  backgroundRemoval: BackgroundRemoval | null;
  /** Set when the clip's media was regenerated (generative fill on video). */
  generation?: ClipGeneration | null;
}

/* Animation */

export interface AnimFrame {
  id: string;
  /** How many timeline frames this drawing is held for. */
  hold: number;
  shapes: VectorShape[];
  strokes: Stroke[];
  assetId: string | null;
}

export interface Bone {
  id: string;
  name: string;
  parentId: string | null;
  length: number;
  /** Rotation relative to parent (radians). */
  angle: number;
  /** Root bones only: position in layer space. */
  x: number;
  y: number;
  /** Optional sprite attached rigidly to this bone. */
  attachment: { assetId: string | null; shape: VectorShape | null; offsetX: number; offsetY: number } | null;
}

export interface RigPose {
  /** Time in seconds relative to the layer start. */
  time: number;
  angles: Record<string, number>;
  easing: Easing;
}

export interface Rig {
  bones: Bone[];
  poses: RigPose[];
}

export interface MotionPath {
  path: BezierPath;
  orientToPath: boolean;
  easing: Easing;
}

export interface SpriteSheetRef {
  assetId: string;
  columns: number;
  rows: number;
  frameCount: number;
  frameWidth: number;
  frameHeight: number;
}

export interface AnimLayerProps {
  name: string;
  /** Timeline start in seconds. */
  start: number;
  duration: number;
  visible: boolean;
  frames: AnimFrame[];
  sprite: SpriteSheetRef | null;
  rig: Rig | null;
  motionPath: MotionPath | null;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  anchorX: number;
  anchorY: number;
  keyframes: Partial<Record<AnimatableProp, Keyframe[]>>;
  /** Onion skin settings used by the editor. */
  onionSkin: { enabled: boolean; before: number; after: number };
  playback: PlaybackMode;
}

/* ------------------------------------------------------------------ */
/* Code Grounds                                                        */
/* ------------------------------------------------------------------ */

export type CodeLanguage = 'python' | 'javascript' | 'typescript' | 'json' | 'markdown' | 'css' | 'html' | 'text';

export interface CodeWorkspaceProps {
  name: string;
  /** Network is off by default for sandboxed runs. */
  allowNetwork: boolean;
  /** Extra packages the sandbox may load (subject to install limits). */
  packages: string[];
  /** Entry file run by "Run project". */
  entry: string | null;
}

export interface CodeFileProps {
  path: string;
  language: CodeLanguage;
  content: string;
}

export interface ChartSpec {
  type: 'bar' | 'line' | 'scatter' | 'pie' | 'area';
  title?: string;
  labels: string[];
  series: { name: string; values: number[]; color?: Color }[];
  xLabel?: string;
  yLabel?: string;
}

export type CellOutput =
  | { kind: 'stdout'; text: string }
  | { kind: 'stderr'; text: string }
  | { kind: 'result'; text: string }
  | { kind: 'error'; name: string; message: string; traceback?: string }
  | { kind: 'image'; assetId: string; mime: string }
  | { kind: 'chart'; spec: ChartSpec }
  | { kind: 'table'; columns: string[]; rows: (string | number | null)[][] };

export interface NotebookProps {
  name: string;
  language: 'python' | 'javascript' | 'typescript';
}

export interface CellProps {
  cellType: 'code' | 'markdown';
  language: 'python' | 'javascript' | 'typescript';
  source: string;
  outputs: CellOutput[];
  executionCount: number;
  lastRunAt: string | null;
  lastRunMs: number | null;
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

export type BlockType =
  | 'heading'
  | 'paragraph'
  | 'bullet'
  | 'numbered'
  | 'todo'
  | 'quote'
  | 'code'
  | 'table'
  | 'image'
  | 'embed'
  | 'divider';

/** A live reference to output elsewhere in the project. Re-resolved every time the doc renders. */
export interface EmbedRef {
  kind: 'cell-output' | 'asset' | 'chart' | 'canvas' | 'sequence-frame' | 'slide';
  /** Node id (cell, canvas, sequence, slide) or asset id. */
  ref: string;
  /** For sequence frames: time in seconds. */
  time?: number;
}

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: Color;
  lineHeight: number;
  spaceBefore: number;
  spaceAfter: number;
  italic?: boolean;
}

export type StyleSheet = Record<string, TextStyle>;

export interface DocumentProps {
  name: string;
  styles: StyleSheet;
  pageSize: 'a4' | 'letter';
}

export interface BlockProps {
  blockType: BlockType;
  /** Inline markdown: **bold**, *italic*, `code`, [link](url), ~~strike~~. */
  text: string;
  level?: number;
  language?: string;
  checked?: boolean;
  rows?: string[][];
  assetId?: string | null;
  caption?: string;
  embed?: EmbedRef | null;
  /** Named style from the document style sheet; defaults per block type. */
  style?: string | null;
}

export interface SuggestionProps {
  blockId: string;
  kind: 'replace' | 'insert-after' | 'delete';
  text: string;
  blockType?: BlockType;
  author: Author;
  createdAt: string;
  status: 'open' | 'accepted' | 'rejected';
  reason?: string;
}

/* ------------------------------------------------------------------ */
/* Slideshows                                                          */
/* ------------------------------------------------------------------ */

export interface ThemeTokens {
  name: string;
  colors: { background: Color; surface: Color; text: Color; muted: Color; accent: Color; accent2: Color };
  fonts: { heading: string; body: string; mono: string };
  sizes: { title: number; heading: number; body: number; caption: number };
}

export interface MasterSlide {
  id: string;
  name: string;
  /** Placeholder elements copied into slides that use this master. */
  placeholders: { role: 'title' | 'subtitle' | 'body' | 'image' | 'footer'; x: number; y: number; w: number; h: number }[];
  background: Color | null;
}

export interface DeckProps {
  name: string;
  width: number;
  height: number;
  theme: ThemeTokens;
  masters: MasterSlide[];
  /** Public presentation link id, null when sharing is off. */
  shareId: string | null;
}

export type SlideTransitionKind = 'none' | 'fade' | 'push' | 'wipe' | 'zoom';

export interface SlideProps {
  name: string;
  masterId: string | null;
  layout: 'title' | 'title-body' | 'two-column' | 'image-full' | 'blank' | 'section';
  background: Color | null;
  notes: string;
  transition: { kind: SlideTransitionKind; duration: number; easing: Easing };
  /** Rehearsal timing in seconds (last rehearsal), null if never rehearsed. */
  rehearsalSeconds: number | null;
  hidden: boolean;
}

export type ElementAnimationKind = 'fade-in' | 'fade-out' | 'fly-in' | 'fly-out' | 'zoom-in' | 'pulse' | 'spin' | 'custom';

export interface ElementAnimation {
  id: string;
  kind: ElementAnimationKind;
  /** Delay after the slide (or previous click) in seconds. */
  delay: number;
  duration: number;
  easing: Easing;
  trigger: 'on-enter' | 'on-click' | 'with-previous';
  /**
   * For on-click animations: which click of the slide starts it (1 = first click). Without it,
   * the animation takes the click after this element's previous animation.
   */
  click?: number | null;
  /** Custom keyframes reuse the animation engine. */
  keyframes?: Partial<Record<AnimatableProp, Keyframe[]>>;
}

export type SlideElementType = 'text' | 'image' | 'video' | 'shape' | 'chart' | 'embed';

export interface SlideElementProps {
  elementType: SlideElementType;
  role: 'title' | 'subtitle' | 'body' | 'image' | 'footer' | null;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  opacity: number;
  /** Inline markdown for text elements. */
  text?: string;
  fontSize?: number | null;
  fontFamily?: string | null;
  color?: Color | null;
  align?: 'left' | 'center' | 'right';
  /** Vertical text alignment in the box (default: titles sit at the bottom, other text at the top). */
  valign?: 'top' | 'middle' | 'bottom' | null;
  bold?: boolean;
  assetId?: string | null;
  /** Shape geometry. Polygon points and paths are in the shape's own width × height frame and scale with the element. */
  shape?: VectorShape | null;
  chart?: ChartSpec | null;
  embed?: EmbedRef | null;
  animations: ElementAnimation[];
}

/* ------------------------------------------------------------------ */
/* Node union                                                          */
/* ------------------------------------------------------------------ */

export interface NodePropsMap {
  project: ProjectProps;
  notes: { name: string };
  note: NoteProps;
  comments: { name: string };
  comment: CommentProps;
  canvas: CanvasProps;
  layer: LayerProps;
  sequence: SequenceProps;
  track: TrackProps;
  clip: ClipProps;
  animLayer: AnimLayerProps;
  codeWorkspace: CodeWorkspaceProps;
  codeFile: CodeFileProps;
  notebook: NotebookProps;
  cell: CellProps;
  document: DocumentProps;
  block: BlockProps;
  suggestion: SuggestionProps;
  deck: DeckProps;
  slide: SlideProps;
  slideElement: SlideElementProps;
}

export type NodeType = keyof NodePropsMap;

export const NODE_TYPES = [
  'project',
  'notes',
  'note',
  'comments',
  'comment',
  'canvas',
  'layer',
  'sequence',
  'track',
  'clip',
  'animLayer',
  'codeWorkspace',
  'codeFile',
  'notebook',
  'cell',
  'document',
  'block',
  'suggestion',
  'deck',
  'slide',
  'slideElement',
] as const satisfies readonly NodeType[];

export interface SceneNode<T extends NodeType = NodeType> {
  id: string;
  type: T;
  parentId: string | null;
  children: string[];
  props: NodePropsMap[T];
}

export type AnyNode = { [K in NodeType]: SceneNode<K> }[NodeType];

/** Which node types may be children of which. Enforced by the operation applier. */
export const ALLOWED_CHILDREN: Record<NodeType, readonly NodeType[]> = {
  project: ['notes', 'comments', 'canvas', 'sequence', 'codeWorkspace', 'document', 'deck'],
  notes: ['note'],
  note: [],
  comments: ['comment'],
  comment: [],
  canvas: ['layer'],
  layer: ['layer'],
  sequence: ['track'],
  track: ['clip', 'animLayer'],
  clip: [],
  animLayer: [],
  codeWorkspace: ['codeFile', 'notebook'],
  codeFile: [],
  notebook: ['cell'],
  cell: [],
  document: ['block', 'suggestion'],
  block: [],
  suggestion: [],
  deck: ['slide'],
  slide: ['slideElement'],
  slideElement: [],
};

/** The top-level node type that represents each tool's document. */
export const TOOL_ROOT_TYPE: Record<ToolKind, NodeType> = {
  image: 'canvas',
  video: 'sequence',
  animation: 'sequence',
  code: 'codeWorkspace',
  document: 'document',
  slides: 'deck',
};
