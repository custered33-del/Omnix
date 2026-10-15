import { z } from 'zod';
import type { AnimLayerProps, ClipEffect, MasterSlide, Rig, SceneNode, SmartFilter, StyleSheet, ThemeTokens } from './nodes.js';
import type { Operation } from './ops.js';
import type { ProjectState } from './state.js';
import { DEFAULT_DOC_STYLES } from './defaults.js';
import { applyThemeOp, THEME_PRESETS } from './decks.js';
import { newId } from './ids.js';
import { zColor, zEasing, zFilterKind, zKeyframes, zBezierPath, zVectorShape } from './schemas.js';

/**
 * Reusable presets (feature 55): a look for layers or clips, an animation rig with its motion,
 * a document's text styles, or a slideshow theme, saved once and applied anywhere. A preset is
 * plain data; applying it produces ordinary operations, so it can be undone, reviewed as a
 * proposal, or applied to many documents in a batch.
 */

export type PresetKind = 'layer-effects' | 'clip-effects' | 'rig' | 'doc-styles' | 'slide-theme';
export const PRESET_KINDS: PresetKind[] = ['layer-effects', 'clip-effects', 'rig', 'doc-styles', 'slide-theme'];

export interface PresetDataMap {
  'layer-effects': { filters: Omit<SmartFilter, 'id'>[] };
  'clip-effects': { effects: Omit<ClipEffect, 'id'>[] };
  rig: { rig: Rig; keyframes?: AnimLayerProps['keyframes']; motionPath?: AnimLayerProps['motionPath']; duration?: number };
  'doc-styles': { styles: StyleSheet };
  'slide-theme': { theme: ThemeTokens; masters?: MasterSlide[] };
}

export interface Preset<K extends PresetKind = PresetKind> {
  id: string;
  kind: K;
  name: string;
  description: string;
  data: PresetDataMap[K];
  builtIn?: boolean;
}

/* ------------------------------------------------------------------ */
/* Validation (presets arrive from people, Claude and plugins)        */
/* ------------------------------------------------------------------ */

const zTextStyle = z.object({ fontFamily: z.string().max(80), fontSize: z.number().min(4).max(200), fontWeight: z.number().min(100).max(900), color: zColor, lineHeight: z.number().min(0.8).max(4), spaceBefore: z.number().min(0).max(200), spaceAfter: z.number().min(0).max(200), italic: z.boolean().optional() });
const zBone = z.object({
  id: z.string(),
  name: z.string().max(80),
  parentId: z.string().nullable(),
  length: z.number(),
  angle: z.number(),
  x: z.number(),
  y: z.number(),
  attachment: z.object({ assetId: z.string().nullable(), shape: zVectorShape.nullable(), offsetX: z.number(), offsetY: z.number() }).nullable(),
});
export const zPresetData = {
  'layer-effects': z.object({ filters: z.array(z.object({ filter: zFilterKind, params: z.record(z.string(), z.number()), enabled: z.boolean().default(true), opacity: z.number().min(0).max(1).default(1) })).min(1).max(20) }),
  'clip-effects': z.object({ effects: z.array(z.object({ effect: z.union([zFilterKind, z.literal('colorGrade')]), params: z.record(z.string(), z.number()), enabled: z.boolean().default(true), assetId: z.string().nullable().optional() })).min(1).max(20) }),
  rig: z.object({
    rig: z.object({ bones: z.array(zBone).min(1).max(64), poses: z.array(z.object({ time: z.number().min(0), angles: z.record(z.string(), z.number()), easing: zEasing })).max(500) }),
    keyframes: zKeyframes.optional(),
    motionPath: z.object({ path: zBezierPath, orientToPath: z.boolean(), easing: zEasing }).nullable().optional(),
    duration: z.number().positive().optional(),
  }),
  'doc-styles': z.object({ styles: z.record(z.string().max(40), zTextStyle) }),
  'slide-theme': z.object({
    theme: z.object({
      name: z.string().max(80),
      colors: z.object({ background: zColor, surface: zColor, text: zColor, muted: zColor, accent: zColor, accent2: zColor }),
      fonts: z.object({ heading: z.string(), body: z.string(), mono: z.string() }),
      sizes: z.object({ title: z.number(), heading: z.number(), body: z.number(), caption: z.number() }),
    }),
    masters: z.array(z.unknown()).optional(),
  }),
} satisfies Record<PresetKind, z.ZodType>;

/** Check preset data for a kind; throws with a readable message when it does not fit. */
export function parsePresetData<K extends PresetKind>(kind: K, data: unknown): PresetDataMap[K] {
  const r = zPresetData[kind].safeParse(data);
  if (!r.success) throw new Error(`That is not a valid ${kind} preset: ${r.error.issues.map((i) => `${i.path.join('.') || 'data'}: ${i.message}`).join('; ')}`);
  return r.data as PresetDataMap[K];
}

/* ------------------------------------------------------------------ */
/* What a preset applies to                                           */
/* ------------------------------------------------------------------ */

/** Node types each kind can be applied to (documents apply to everything suitable inside them). */
export const PRESET_TARGETS: Record<PresetKind, string[]> = {
  'layer-effects': ['layer', 'canvas'],
  'clip-effects': ['clip', 'track', 'sequence'],
  rig: ['animLayer'],
  'doc-styles': ['document'],
  'slide-theme': ['deck'],
};

/** Which kind of preset a node can be saved as. */
export function presetKindFor(node: SceneNode): PresetKind | null {
  switch (node.type) {
    case 'layer':
      return 'layer-effects';
    case 'clip':
      return 'clip-effects';
    case 'animLayer':
      return 'rig';
    case 'document':
      return 'doc-styles';
    case 'deck':
      return 'slide-theme';
    default:
      return null;
  }
}

/** Capture a node's reusable part as preset data. */
export function presetFromNode(state: ProjectState, nodeId: string): { kind: PresetKind; data: PresetDataMap[PresetKind] } {
  const n = state.nodes[nodeId];
  if (!n) throw new Error('Nothing to save: that item no longer exists.');
  const kind = presetKindFor(n);
  if (!kind) throw new Error(`A ${n.type} cannot be saved as a preset. Save a layer's filters, a clip's effects, an animation rig, a document's styles or a slideshow's theme.`);
  const p = n.props as unknown as Record<string, unknown>;
  switch (kind) {
    case 'layer-effects': {
      const filters = (p.filters as SmartFilter[]).map(({ id: _id, ...f }) => f);
      if (!filters.length) throw new Error('This layer has no filters to save yet.');
      return { kind, data: { filters } };
    }
    case 'clip-effects': {
      const effects = (p.effects as ClipEffect[]).map(({ id: _id, ...e }) => e);
      if (!effects.length) throw new Error('This clip has no effects to save yet.');
      return { kind, data: { effects } };
    }
    case 'rig': {
      const rig = p.rig as Rig | null;
      if (!rig?.bones.length) throw new Error('This layer has no rig to save yet.');
      const keyframes = p.keyframes as AnimLayerProps['keyframes'];
      return { kind, data: { rig: structuredClone(rig), ...(keyframes && Object.keys(keyframes).length ? { keyframes: structuredClone(keyframes) } : {}), ...(p.motionPath ? { motionPath: structuredClone(p.motionPath as AnimLayerProps['motionPath']) } : {}), duration: p.duration as number } };
    }
    case 'doc-styles':
      return { kind, data: { styles: structuredClone(p.styles as StyleSheet) } };
    case 'slide-theme':
      return { kind, data: { theme: structuredClone(p.theme as ThemeTokens), masters: structuredClone(p.masters as MasterSlide[]) } };
  }
}

function freshIds<T extends object>(items: T[], prefix: string): (T & { id: string })[] {
  return items.map((x) => ({ ...structuredClone(x), id: newId(prefix) }));
}

/**
 * Operations that apply a preset to a target. Looks are added after what is there (effects stack);
 * a rig, styles or theme replace the target's own.
 */
export function applyPresetOps(state: ProjectState, preset: Pick<Preset, 'kind' | 'data' | 'name'>, targetId: string): Operation[] {
  const target = state.nodes[targetId];
  if (!target) throw new Error('The target no longer exists.');
  if (!PRESET_TARGETS[preset.kind].includes(target.type)) throw new Error(`A ${preset.kind} preset does not apply to a ${target.type}. It applies to: ${PRESET_TARGETS[preset.kind].join(', ')}.`);
  const kids = (id: string) => state.nodes[id]?.children.map((c) => state.nodes[c]!).filter(Boolean) ?? [];
  switch (preset.kind) {
    case 'layer-effects': {
      const data = preset.data as PresetDataMap['layer-effects'];
      const layers: SceneNode<'layer'>[] = [];
      const visit = (id: string) => {
        for (const c of kids(id)) {
          if (c.type !== 'layer') continue;
          const l = c as SceneNode<'layer'>;
          if (l.props.layerType === 'group') visit(l.id);
          else if (l.props.layerType === 'raster' || l.props.layerType === 'fill' || l.props.layerType === 'vector' || l.props.layerType === 'text') layers.push(l);
        }
      };
      if (target.type === 'layer') layers.push(target as SceneNode<'layer'>);
      else visit(target.id);
      // Whole canvases get the look on their pictures (raster layers), or on everything when there are none.
      const pictures = target.type === 'canvas' ? layers.filter((l) => l.props.layerType === 'raster') : layers;
      return (pictures.length ? pictures : layers).map((l) => ({ kind: 'update', id: l.id, set: { filters: [...l.props.filters, ...freshIds(data.filters, 'flt')] } }));
    }
    case 'clip-effects': {
      const data = preset.data as PresetDataMap['clip-effects'];
      const clips: SceneNode<'clip'>[] = [];
      // Picture effects go on picture clips: audio tracks are left alone.
      const visit = (n: SceneNode) => {
        if (n.type === 'clip') clips.push(n as SceneNode<'clip'>);
        else if (!(n.type === 'track' && (n as SceneNode<'track'>).props.trackType === 'audio')) for (const c of kids(n.id)) visit(c);
      };
      visit(target);
      return clips.map((c) => ({ kind: 'update', id: c.id, set: { effects: [...c.props.effects, ...freshIds(data.effects, 'fx')] } }));
    }
    case 'rig': {
      const data = preset.data as PresetDataMap['rig'];
      const set: Record<string, unknown> = { rig: structuredClone(data.rig) };
      if (data.keyframes) set.keyframes = structuredClone(data.keyframes);
      if (data.motionPath !== undefined) set.motionPath = structuredClone(data.motionPath);
      if (data.duration) set.duration = Math.max((target.props as AnimLayerProps).duration, data.duration);
      return [{ kind: 'update', id: target.id, set }];
    }
    case 'doc-styles': {
      const data = preset.data as PresetDataMap['doc-styles'];
      return [{ kind: 'update', id: target.id, set: { styles: { ...(target.props as { styles: StyleSheet }).styles, ...structuredClone(data.styles) } } }];
    }
    case 'slide-theme': {
      const data = preset.data as PresetDataMap['slide-theme'];
      return [applyThemeOp(state, target.id, structuredClone(data.theme))];
    }
  }
}

/* ------------------------------------------------------------------ */
/* Built-in presets                                                   */
/* ------------------------------------------------------------------ */

const styles = (font: string, headingFont: string, color: string, accent: string, scale = 1): StyleSheet => {
  const out: StyleSheet = structuredClone(DEFAULT_DOC_STYLES);
  for (const [k, s] of Object.entries(out)) {
    const heading = k === 'title' || k.startsWith('h');
    out[k] = { ...s, fontFamily: k === 'code' ? s.fontFamily : heading ? headingFont : font, fontSize: Math.round(s.fontSize * scale), color: heading ? accent : k === 'caption' || k === 'quote' ? s.color : color };
  }
  return out;
};

const pendulum: Rig = {
  bones: [{ id: 'rod', name: 'Rod', parentId: null, length: 220, angle: Math.PI / 2, x: 0, y: 0, attachment: { assetId: null, shape: { id: 'bob', kind: 'ellipse', x: 190, y: -30, width: 60, height: 60, fill: '#e8590c', stroke: null, strokeWidth: 0 }, offsetX: 0, offsetY: 0 } }],
  poses: [
    { time: 0, angles: { rod: Math.PI / 2 - 0.6 }, easing: 'ease-in-out' },
    { time: 1, angles: { rod: Math.PI / 2 + 0.6 }, easing: 'ease-in-out' },
    { time: 2, angles: { rod: Math.PI / 2 - 0.6 }, easing: 'ease-in-out' },
  ],
};
const wavingArm: Rig = {
  bones: [
    { id: 'upper', name: 'Upper arm', parentId: null, length: 120, angle: -Math.PI / 3, x: 0, y: 0, attachment: null },
    { id: 'fore', name: 'Forearm', parentId: 'upper', length: 100, angle: -0.4, x: 0, y: 0, attachment: null },
    { id: 'hand', name: 'Hand', parentId: 'fore', length: 36, angle: 0, x: 0, y: 0, attachment: null },
  ],
  poses: [
    { time: 0, angles: { upper: -Math.PI / 3, fore: -0.4, hand: 0 }, easing: 'ease-in-out' },
    { time: 0.4, angles: { upper: -Math.PI / 3, fore: -1.1, hand: -0.3 }, easing: 'ease-in-out' },
    { time: 0.8, angles: { upper: -Math.PI / 3, fore: -0.4, hand: 0.2 }, easing: 'ease-in-out' },
    { time: 1.2, angles: { upper: -Math.PI / 3, fore: -1.1, hand: -0.3 }, easing: 'ease-in-out' },
    { time: 1.6, angles: { upper: -Math.PI / 3, fore: -0.4, hand: 0 }, easing: 'ease-in-out' },
  ],
};

export const BUILTIN_PRESETS: Preset[] = [
  { id: 'builtin-fx-film-grain', kind: 'layer-effects', name: 'Film grain', description: 'Fine grain over the picture.', data: { filters: [{ filter: 'noise', params: { amount: 0.08, seed: 7 }, enabled: true, opacity: 1 }] }, builtIn: true },
  { id: 'builtin-fx-vintage', kind: 'layer-effects', name: 'Vintage', description: 'Warm sepia, a soft vignette and grain.', data: { filters: [{ filter: 'sepia', params: { amount: 0.6 }, enabled: true, opacity: 1 }, { filter: 'vignette', params: { amount: 0.45, radius: 0.65 }, enabled: true, opacity: 1 }, { filter: 'noise', params: { amount: 0.05, seed: 3 }, enabled: true, opacity: 1 }] }, builtIn: true },
  { id: 'builtin-fx-mono', kind: 'layer-effects', name: 'Black and white', description: 'Full grayscale.', data: { filters: [{ filter: 'grayscale', params: { amount: 1 }, enabled: true, opacity: 1 }] }, builtIn: true },
  { id: 'builtin-fx-soft-focus', kind: 'layer-effects', name: 'Soft focus', description: 'A light blur blended over the original.', data: { filters: [{ filter: 'gaussianBlur', params: { radius: 6 }, enabled: true, opacity: 0.45 }] }, builtIn: true },
  { id: 'builtin-fx-crisp', kind: 'layer-effects', name: 'Crisp', description: 'Gentle sharpening for detail.', data: { filters: [{ filter: 'sharpen', params: { amount: 0.6, radius: 1.5 }, enabled: true, opacity: 1 }] }, builtIn: true },
  { id: 'builtin-clip-warm-film', kind: 'clip-effects', name: 'Warm film', description: 'Warmer, a little more contrast, softer color and grain.', data: { effects: [{ effect: 'colorGrade', params: { exposure: 0, contrast: 12, saturation: -10, temperature: 25, tint: 4, intensity: 1 }, enabled: true }, { effect: 'noise', params: { amount: 0.04, seed: 5 }, enabled: true }] }, builtIn: true },
  { id: 'builtin-clip-cool-night', kind: 'clip-effects', name: 'Cool night', description: 'Cooler and a touch darker.', data: { effects: [{ effect: 'colorGrade', params: { exposure: -0.35, contrast: 8, saturation: -15, temperature: -35, tint: 0, intensity: 1 }, enabled: true }] }, builtIn: true },
  { id: 'builtin-clip-punchy', kind: 'clip-effects', name: 'Punchy', description: 'Bold contrast and color.', data: { effects: [{ effect: 'colorGrade', params: { exposure: 0, contrast: 25, saturation: 22, temperature: 0, tint: 0, intensity: 1 }, enabled: true }] }, builtIn: true },
  { id: 'builtin-clip-mono', kind: 'clip-effects', name: 'Black and white', description: 'Grayscale with a little extra contrast.', data: { effects: [{ effect: 'grayscale', params: { amount: 1 }, enabled: true }, { effect: 'colorGrade', params: { exposure: 0, contrast: 15, saturation: 0, temperature: 0, tint: 0, intensity: 1 }, enabled: true }] }, builtIn: true },
  { id: 'builtin-rig-pendulum', kind: 'rig', name: 'Pendulum', description: 'One bone with a weight that swings back and forth every two seconds.', data: { rig: pendulum, duration: 2 }, builtIn: true },
  { id: 'builtin-rig-waving-arm', kind: 'rig', name: 'Waving arm', description: 'Upper arm, forearm and hand, waving twice.', data: { rig: wavingArm, duration: 1.6 }, builtIn: true },
  { id: 'builtin-doc-classic', kind: 'doc-styles', name: 'Classic serif', description: 'Georgia throughout, navy headings.', data: { styles: styles('Georgia', 'Georgia', '#2b2e35', '#1d3557', 1.05) }, builtIn: true },
  { id: 'builtin-doc-modern', kind: 'doc-styles', name: 'Modern sans', description: 'Inter body, Space Grotesk headings in deep violet.', data: { styles: styles('Inter', 'Space Grotesk', '#2b2e35', '#3d1f7a') }, builtIn: true },
  { id: 'builtin-doc-report', kind: 'doc-styles', name: 'Report', description: 'Source Serif body and Inter headings, slightly smaller for dense pages.', data: { styles: styles('Source Serif 4', 'Inter', '#1d1f24', '#0b5c7a', 0.95) }, builtIn: true },
  ...THEME_PRESETS.map((theme): Preset => ({ id: `builtin-theme-${theme.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, kind: 'slide-theme', name: theme.name, description: `${theme.fonts.heading} headings on ${theme.colors.background}.`, data: { theme }, builtIn: true })),
];
