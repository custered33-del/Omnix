import {
  applyLayoutOps,
  applyOp,
  clipDuration,
  clipsOf,
  deckSlides,
  documentBlocks,
  duplicateSlideOps,
  layerProps,
  makeNode,
  newId,
  newSlideOps,
  notesContainer,
  setSpeedOp,
  THEME_PRESETS,
  applyThemeOp,
  tracksOf,
  type Adjustment,
  type BlockType,
  type ClipEffect,
  type FilterKind,
  type Operation,
  type ProjectState,
  type SceneNode,
  type SlideLayout,
  type ThemeTokens,
} from '@omnix/core';
import { COLOR_GRADE_DEFAULTS, FILTER_DEFAULTS, type Mask } from '@omnix/imaging';
import { layerBounds } from '@omnix/render';
import type { Services } from '../../services.js';
import { canvasIdOf, compositeRaster, layerAlphaMaskAsset, layerRaster, uploadRaster } from '../../render/pixels.js';
import { invertMask, skyMask, subjectMask } from './regions.js';
import { canvasLayers, resolveTargets, targetIds, type Target, type TargetScope, type TargetSet } from './targets.js';
import { colorFrom, placeBox, positionFrom, shiftColor, toneFrom, unquote, type Position, type Tone } from './vocab.js';

/**
 * Natural-language commands (feature 48): "make the sky warmer and move the title to the lower
 * third" becomes a list of steps, each a small set of ordinary operations, so the whole command can
 * be reviewed as one proposed change (and modified or partly rejected) before anything commits.
 *
 * The parser is rule based and deterministic. Phrases it does not understand are reported back;
 * when Claude is configured, the server hands the whole command to Claude instead.
 */

export interface CommandEnv {
  services: Services;
  projectId: string;
  /** The open document (canvas, sequence, deck or document). */
  documentId: string;
  selection: string[];
  /** Current slide in a deck. */
  slideId: string | null;
  /** Playhead position in a timeline. */
  time: number | null;
  /** Owner of assets created on the way (masks). */
  ownerId: string;
}

export interface CommandStep {
  clause: string;
  label: string;
  ops: Operation[];
  /** Nodes this step changed or created. */
  nodeIds: string[];
}

export interface CommandPlan {
  steps: CommandStep[];
  unmatched: { clause: string; reason: string }[];
}

class Miss extends Error {}

/** Run a regex and return its groups (optionally reordered, so phrasings with swapped parts share code). */
function rx(re: RegExp, text: string, order?: number[]): string[] | null {
  const m = re.exec(text);
  if (!m) return null;
  const groups = [...m].map((g) => g ?? '');
  return order ? [groups[0]!, ...order.map((i) => groups[i] ?? '')] : groups;
}

const VERB_SPLIT =
  /\s+(?:and then|then|and|also|plus)\s+(?=(?:make|move|put|place|set|change|add|insert|turn|rename|hide|show|unhide|delete|remove|blur|sharpen|resize|scale|center|centre|align|speed|slow|mute|unmute|trim|cut|shorten|fade|use|apply|switch|give|colou?r|paint|increase|decrease|reduce|lower|raise|brighten|darken|warm|cool|saturate|desaturate|rotate|duplicate|copy|bold|italicize|unbold|replace|crop|nudge|shift|drag|push|grow|shrink|enlarge|reverse|play|convert|retitle|lighten|dim|boost|get rid of|erase)\b)/i;

/** Split a command into clauses, keeping quoted text intact. */
export function splitClauses(text: string): string[] {
  const quotes: string[] = [];
  const masked = text.replace(/["“][^"”]*["”]|'[^']*'(?=\s|$|[,.;])/g, (q) => {
    quotes.push(q);
    return `\u0000${quotes.length - 1}\u0000`;
  });
  const parts = masked
    .split(/\s*(?:[;\n]+|\.\s+|,\s*(?:and\s+|then\s+)?)\s*/)
    .flatMap((p) => p.split(VERB_SPLIT))
    .map((p) => p.replace(/\u0000(\d+)\u0000/g, (_, i: string) => quotes[Number(i)]!).trim().replace(/[.!]+$/, ''))
    .filter(Boolean);
  return parts;
}

function normalize(clause: string): string {
  return clause
    .trim()
    .replace(/^(?:please\s+|can you\s+|could you\s+|would you\s+|i want (?:you )?to\s+|let's\s+|lets\s+|go ahead and\s+|try to\s+)+/i, '')
    .replace(/\s+(?:please|for me|thanks|thank you)$/i, '')
    .replace(/\?$/, '')
    .trim();
}

interface Ctx {
  env: CommandEnv;
  state: ProjectState;
  scope: TargetScope;
  /** The clause as typed (for names and text) and lowercased (for matching). */
  raw: string;
  low: string;
  pixels: { composite?: Promise<import('@omnix/imaging').Raster> };
}

type Handler = (c: Ctx) => Promise<CommandStep | null>;

function targetsOf(c: Ctx, phrase: string): TargetSet {
  const t = resolveTargets(phrase, c.scope);
  if (!t || !t.targets.length) throw new Miss(`I couldn't find "${phrase.trim()}" in this ${docWord(c)}.`);
  return t;
}

function docWord(c: Ctx): string {
  const d = c.state.nodes[c.env.documentId];
  switch (d?.type) {
    case 'canvas':
      return 'image';
    case 'sequence':
      return (d as SceneNode<'sequence'>).props.purpose === 'animation' ? 'animation' : 'video';
    case 'deck':
      return 'slideshow';
    default:
      return 'document';
  }
}

function step(clause: string, label: string, ops: Operation[], nodeIds: string[]): CommandStep {
  return { clause, label, ops, nodeIds };
}

function node<T extends SceneNode['type']>(c: Ctx, id: string): SceneNode<T> {
  return c.state.nodes[id] as SceneNode<T>;
}

function seqOf(c: Ctx): SceneNode<'sequence'> | null {
  const d = c.state.nodes[c.env.documentId];
  return d?.type === 'sequence' ? (d as SceneNode<'sequence'>) : null;
}

function deckOf(c: Ctx): SceneNode<'deck'> | null {
  const d = c.state.nodes[c.env.documentId];
  return d?.type === 'deck' ? (d as SceneNode<'deck'>) : null;
}

function currentSlide(c: Ctx): SceneNode<'slide'> | null {
  const deck = deckOf(c);
  if (!deck) return null;
  const slides = deckSlides(c.state, deck.id);
  return slides.find((s) => s.id === c.env.slideId) ?? slides[0] ?? null;
}

/* Pixels: masks for regions and layers ----------------------------------- */

/**
 * The picture itself, for finding regions like the sky: photos and fills only, so text, shapes and
 * adjustments on top do not cut holes in the mask (which would show once they move).
 */
async function composite(c: Ctx, canvasId: string) {
  c.pixels.composite ??= (async () => {
    const host = c.env.services.renderHost();
    const nodes = { ...c.state.nodes };
    for (const l of canvasLayers(c.state, canvasId)) if (['text', 'vector', 'adjustment'].includes(l.props.layerType) && l.props.visible) nodes[l.id] = { ...l, props: { ...l.props, visible: false } };
    return compositeRaster(host, { ...c.state, nodes }, canvasId);
  })();
  return c.pixels.composite;
}

async function regionMask(c: Ctx, canvasId: string, region: 'sky' | 'subject' | 'background'): Promise<string> {
  const r = await composite(c, canvasId);
  let m: Mask | null = null;
  if (region === 'sky') m = skyMask(r);
  else {
    const s = subjectMask(r);
    m = s && (region === 'subject' ? s : invertMask(s));
  }
  if (!m) throw new Miss(region === 'sky' ? "I couldn't find a sky in this image (looked for a bright, smooth area along the top)." : `I couldn't separate the ${region} from the rest of the image.`);
  return uploadRaster(c.env.services, m, `${region} mask.png`, c.env.projectId, c.env.ownerId, { asMask: true, tags: ['mask', region] });
}

async function layerAlphaMask(c: Ctx, layer: SceneNode<'layer'>): Promise<string> {
  const canvasId = canvasIdOf(c.state, layer.id);
  if (!canvasId) throw new Miss('That layer is not on a canvas.');
  return layerAlphaMaskAsset(c.env.services, c.state, canvasId, layer.id, c.env.projectId, c.env.ownerId, `${layer.props.name} shape.png`);
}

function adjustmentLayerOps(c: Ctx, parentId: string, index: number, adjustments: { adj: Adjustment; name: string }[], maskAssetId: string | null): { ops: Operation[]; ids: string[] } {
  const ops: Operation[] = [];
  const ids: string[] = [];
  adjustments.forEach((a, i) => {
    const n = makeNode('layer', layerProps('adjustment', { name: a.name, adjustment: a.adj, ...(maskAssetId ? { mask: { source: { kind: 'mask', assetId: maskAssetId }, inverted: false, enabled: true } } : {}) }));
    ops.push({ kind: 'create', parentId, index: index + i, nodes: [n] });
    ids.push(n.id);
  });
  return { ops, ids };
}

/* Tone ------------------------------------------------------------------- */

const TONE_NAMES: Record<Tone, string> = {
  warmer: 'Warmer',
  cooler: 'Cooler',
  brighter: 'Brighter',
  darker: 'Darker',
  'more-saturated': 'More vivid',
  'less-saturated': 'More muted',
  grayscale: 'Black and white',
  sepia: 'Sepia',
  'more-contrast': 'More contrast',
  'less-contrast': 'Less contrast',
  moodier: 'Moodier',
};

function toneAdjustments(tone: Tone, s: number): { adj: Adjustment; name: string }[] {
  const name = TONE_NAMES[tone];
  switch (tone) {
    case 'warmer':
      return [{ adj: { kind: 'temperature', amount: Math.round(25 * s) }, name }];
    case 'cooler':
      return [{ adj: { kind: 'temperature', amount: -Math.round(25 * s) }, name }];
    case 'brighter':
      return [{ adj: { kind: 'brightnessContrast', brightness: Math.round(15 * s), contrast: 0 }, name }];
    case 'darker':
      return [{ adj: { kind: 'brightnessContrast', brightness: -Math.round(15 * s), contrast: 0 }, name }];
    case 'more-saturated':
      return [{ adj: { kind: 'hueSaturation', hue: 0, saturation: Math.round(25 * s), lightness: 0 }, name }];
    case 'less-saturated':
      return [{ adj: { kind: 'hueSaturation', hue: 0, saturation: -Math.round(30 * s), lightness: 0 }, name }];
    case 'grayscale':
      return [{ adj: { kind: 'hueSaturation', hue: 0, saturation: -100, lightness: 0 }, name }];
    case 'sepia':
      return [
        { adj: { kind: 'hueSaturation', hue: 0, saturation: -100, lightness: 0 }, name: 'Sepia (gray)' },
        { adj: { kind: 'temperature', amount: 45 }, name: 'Sepia (warm)' },
      ];
    case 'more-contrast':
      return [{ adj: { kind: 'brightnessContrast', brightness: 0, contrast: Math.round(20 * s) }, name }];
    case 'less-contrast':
      return [{ adj: { kind: 'brightnessContrast', brightness: 0, contrast: -Math.round(20 * s) }, name }];
    case 'moodier':
      return [
        { adj: { kind: 'brightnessContrast', brightness: -Math.round(10 * s), contrast: Math.round(15 * s) }, name },
        { adj: { kind: 'hueSaturation', hue: 0, saturation: -Math.round(15 * s), lightness: 0 }, name: `${name} (muted)` },
      ];
  }
}

function toneGrade(tone: Tone, s: number): Record<string, number> {
  switch (tone) {
    case 'warmer':
      return { temperature: 25 * s };
    case 'cooler':
      return { temperature: -25 * s };
    case 'brighter':
      return { exposure: 0.3 * s };
    case 'darker':
      return { exposure: -0.3 * s };
    case 'more-saturated':
      return { saturation: 25 * s };
    case 'less-saturated':
      return { saturation: -30 * s };
    case 'grayscale':
      return { saturation: -100 };
    case 'sepia':
      return { saturation: -80, temperature: 40 };
    case 'more-contrast':
      return { contrast: 20 * s };
    case 'less-contrast':
      return { contrast: -20 * s };
    case 'moodier':
      return { exposure: -0.2 * s, contrast: 15 * s, saturation: -15 * s };
  }
}

const clampGrade = (k: string, v: number) => (k === 'exposure' ? Math.max(-3, Math.min(3, v)) : k === 'intensity' ? Math.max(0, Math.min(1, v)) : Math.max(-100, Math.min(100, v)));

function gradeOps(clip: SceneNode<'clip'>, delta: Record<string, number>): Operation {
  const fx = clip.props.effects.find((e) => e.effect === 'colorGrade' && e.enabled);
  if (fx) {
    const params = { ...fx.params };
    for (const [k, v] of Object.entries(delta)) params[k] = Math.round(clampGrade(k, (params[k] ?? 0) + v) * 100) / 100;
    return { kind: 'listUpdate', id: clip.id, prop: 'effects', itemId: fx.id, set: { params } };
  }
  const params: Record<string, number> = { ...COLOR_GRADE_DEFAULTS };
  for (const [k, v] of Object.entries(delta)) params[k] = Math.round(clampGrade(k, v) * 100) / 100;
  const item: ClipEffect = { id: newId('fx'), effect: 'colorGrade', params, enabled: true };
  return { kind: 'listInsert', id: clip.id, prop: 'effects', items: [item] };
}

/** A clip on an effect track spanning the whole sequence: grades everything below it. */
function wholeSequenceEffect(c: Ctx, seq: SceneNode<'sequence'>, effect: ClipEffect, name: string): { ops: Operation[]; ids: string[] } {
  const ops: Operation[] = [];
  let track = tracksOf(c.state, seq.id).find((t) => t.props.trackType === 'effect');
  if (!track) {
    track = makeNode('track', { name: 'Effects', trackType: 'effect' });
    ops.push({ kind: 'create', parentId: seq.id, index: 0, nodes: [track] });
  }
  const existing = track && c.state.nodes[track.id] ? clipsOf(c.state, track.id).find((cl) => cl.props.start <= 0.01 && cl.props.start + clipDuration(cl.props) >= seq.props.duration - 0.01) : undefined;
  if (existing) {
    ops.push({ kind: 'listInsert', id: existing.id, prop: 'effects', items: [effect] });
    return { ops, ids: [existing.id] };
  }
  const clip = makeNode('clip', { name, start: 0, in: 0, out: seq.props.duration, effects: [effect] });
  ops.push({ kind: 'create', parentId: track.id, nodes: [clip] });
  return { ops, ids: [clip.id] };
}

async function applyTone(c: Ctx, ts: TargetSet, tone: Tone, s: number): Promise<CommandStep> {
  const ops: Operation[] = [];
  const ids: string[] = [];
  const label = `${TONE_NAMES[tone]}: ${ts.label}`;
  for (const t of ts.targets) {
    switch (t.kind) {
      case 'canvas': {
        const canvas = node<'canvas'>(c, t.id);
        const r = adjustmentLayerOps(c, canvas.id, canvas.children.length, toneAdjustments(tone, s), null);
        ops.push(...r.ops);
        ids.push(...r.ids);
        break;
      }
      case 'region': {
        const assetId = await regionMask(c, t.canvasId, t.region);
        const canvas = node<'canvas'>(c, t.canvasId);
        const r = adjustmentLayerOps(c, canvas.id, canvas.children.length, toneAdjustments(tone, s).map((a) => ({ ...a, name: `${a.name} (${t.region})` })), assetId);
        ops.push(...r.ops);
        ids.push(...r.ids);
        break;
      }
      case 'layer': {
        const l = node<'layer'>(c, t.id);
        const p = l.props;
        if (p.layerType === 'text' && p.color) ops.push({ kind: 'update', id: l.id, set: { color: shiftColor(p.color, tone, s) } });
        else if (p.layerType === 'fill' && p.fillColor) ops.push({ kind: 'update', id: l.id, set: { fillColor: shiftColor(p.fillColor, tone, s) } });
        else if (p.layerType === 'vector') ops.push({ kind: 'update', id: l.id, set: { shapes: (p.shapes ?? []).map((sh) => ({ ...sh, fill: sh.fill ? shiftColor(sh.fill, tone, s) : null, stroke: sh.stroke ? shiftColor(sh.stroke, tone, s) : null })) } });
        else if (p.layerType === 'group') {
          const r = adjustmentLayerOps(c, l.id, l.children.length, toneAdjustments(tone, s), null);
          ops.push(...r.ops);
          ids.push(...r.ids);
          continue;
        } else if (p.layerType === 'raster') {
          const assetId = await layerAlphaMask(c, l);
          const parent = c.state.nodes[l.parentId!]!;
          const r = adjustmentLayerOps(c, parent.id, parent.children.indexOf(l.id) + 1, toneAdjustments(tone, s).map((a) => ({ ...a, name: `${a.name} (${p.name})` })), assetId);
          ops.push(...r.ops);
          ids.push(...r.ids);
          continue;
        } else throw new Miss(`"${p.name}" is an adjustment layer; change its settings instead.`);
        ids.push(l.id);
        break;
      }
      case 'clip': {
        const cl = node<'clip'>(c, t.id);
        if (cl.props.title) ops.push({ kind: 'update', id: cl.id, set: { title: { ...cl.props.title, color: shiftColor(cl.props.title.color, tone, s) } } });
        else ops.push(gradeOps(cl, toneGrade(tone, s)));
        ids.push(cl.id);
        break;
      }
      case 'sequence': {
        const seq = node<'sequence'>(c, t.id);
        const params: Record<string, number> = { ...COLOR_GRADE_DEFAULTS };
        for (const [k, v] of Object.entries(toneGrade(tone, s))) params[k] = clampGrade(k, v);
        const r = wholeSequenceEffect(c, seq, { id: newId('fx'), effect: 'colorGrade', params, enabled: true }, TONE_NAMES[tone]);
        ops.push(...r.ops);
        ids.push(...r.ids);
        break;
      }
      case 'element': {
        const e = node<'slideElement'>(c, t.id);
        if (e.props.elementType === 'text') ops.push({ kind: 'update', id: e.id, set: { color: shiftColor(e.props.color ?? deckOf(c)?.props.theme.colors.text ?? '#222222', tone, s) } });
        else if (e.props.elementType === 'shape' && e.props.shape) ops.push({ kind: 'update', id: e.id, set: { shape: { ...e.props.shape, fill: e.props.shape.fill ? shiftColor(e.props.shape.fill, tone, s) : null } } });
        else throw new Miss('Slide images have no color controls yet. Open the picture in the image editor to adjust it.');
        ids.push(e.id);
        break;
      }
      case 'slide':
      case 'slideBackground': {
        const sl = node<'slide'>(c, t.id);
        const deck = deckOf(c)!;
        ops.push({ kind: 'update', id: sl.id, set: { background: shiftColor(sl.props.background ?? deck.props.theme.colors.background, tone, s) } });
        ids.push(sl.id);
        break;
      }
      case 'deck': {
        const deck = node<'deck'>(c, t.id);
        const th = deck.props.theme;
        const colors = Object.fromEntries(Object.entries(th.colors).map(([k, v]) => [k, shiftColor(v, tone, s)])) as ThemeTokens['colors'];
        ops.push(applyThemeOp(c.state, deck.id, { ...th, colors }));
        ids.push(deck.id);
        break;
      }
      case 'textStyle':
      case 'document': {
        const docId = t.kind === 'document' ? t.id : t.documentId;
        const doc = node<'document'>(c, docId);
        const keys = t.kind === 'document' ? Object.keys(doc.props.styles) : t.styles;
        const styles = { ...doc.props.styles };
        for (const k of keys) if (styles[k]) styles[k] = { ...styles[k]!, color: shiftColor(styles[k]!.color, tone, s) };
        ops.push({ kind: 'update', id: doc.id, set: { styles } });
        ids.push(doc.id);
        break;
      }
      default:
        throw new Miss(`I can't change the color of ${ts.label}.`);
    }
  }
  return step(c.raw, label, ops, ids);
}

/** Split "the sky a bit warmer" into a target and the longest trailing phrase `parse` accepts. */
function splitTail<T>(rest: string, parse: (tail: string) => T | null, maxWords = 5): { head: string; value: T } | null {
  const words = rest.split(/\s+/);
  for (let k = Math.min(maxWords, words.length - 1); k >= 1; k--) {
    const value = parse(words.slice(-k).join(' '));
    if (value) return { head: words.slice(0, -k).join(' ').replace(/\s+(?:look|feel|appear|seem|be)$/, ''), value };
  }
  return null;
}

const toneHandler: Handler = async (c) => {
  let m: string[] | null = /^(?:make|turn|get|render|have)\s+(.+)$/.exec(c.low);
  if (m) {
    const hit = splitTail(m[1]!, toneFrom);
    if (hit && hit.head) return applyTone(c, targetsOf(c, hit.head), hit.value.tone, hit.value.strength);
  }
  m = /^(warm|cool|brighten|darken|saturate|desaturate|lighten|dim)(?:\s+up|\s+down)?\s+(.+?)(?:\s+(a (?:little )?bit|slightly|a little|a lot|much|more))?$/.exec(c.low);
  if (m) {
    const word = { warm: 'warmer', cool: 'cooler', brighten: 'brighter', lighten: 'brighter', darken: 'darker', dim: 'darker', saturate: 'more saturated', desaturate: 'less saturated' }[m[1]!]!;
    const tone = toneFrom(`${m[3] ? `${m[3]} ` : ''}${word}`)!;
    return applyTone(c, targetsOf(c, m[2]!), tone.tone, tone.strength);
  }
  m = /^(add|increase|boost|raise|more|reduce|decrease|lower|less)\s+(?:the\s+|some\s+)?(contrast|brightness|saturation|warmth|color|colour)(?:\s+(?:of|on|in|to|for)\s+(.+))?$/.exec(c.low);
  if (m) {
    const up = /add|increase|boost|raise|more/.test(m[1]!);
    const tone: Tone = { contrast: up ? 'more-contrast' : 'less-contrast', brightness: up ? 'brighter' : 'darker', saturation: up ? 'more-saturated' : 'less-saturated', color: up ? 'more-saturated' : 'less-saturated', colour: up ? 'more-saturated' : 'less-saturated', warmth: up ? 'warmer' : 'cooler' }[m[2]!] as Tone;
    return applyTone(c, m[3] ? targetsOf(c, m[3]) : wholeDoc(c), tone, 1);
  }
  const alone = toneFrom(c.low.replace(/^(?:make it |a bit |go )/, ''));
  if (alone && !/\s(?:the|to|of)\s/.test(c.low)) return applyTone(c, wholeDoc(c), alone.tone, alone.strength);
  return null;
};

function wholeDoc(c: Ctx): TargetSet {
  const d = c.state.nodes[c.env.documentId]!;
  switch (d.type) {
    case 'canvas':
      return { targets: [{ kind: 'canvas', id: d.id }], label: 'the image' };
    case 'sequence':
      return { targets: [{ kind: 'sequence', id: d.id }], label: 'the video' };
    case 'deck':
      return { targets: [{ kind: 'deck', id: d.id }], label: 'the deck' };
    default:
      return { targets: [{ kind: 'document', id: d.id }], label: 'the document' };
  }
}

/* Placement ---------------------------------------------------------------- */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function frameOf(c: Ctx): { W: number; H: number } {
  const d = c.state.nodes[c.env.documentId]!;
  if (d.type === 'canvas') return { W: (d as SceneNode<'canvas'>).props.width, H: (d as SceneNode<'canvas'>).props.height };
  if (d.type === 'sequence') return { W: (d as SceneNode<'sequence'>).props.width, H: (d as SceneNode<'sequence'>).props.height };
  if (d.type === 'deck') return { W: (d as SceneNode<'deck'>).props.width, H: (d as SceneNode<'deck'>).props.height };
  throw new Miss('Positions only apply to images, videos, animations and slides.');
}

async function boxOf(c: Ctx, t: Target): Promise<{ box: Box; apply: (x: number, y: number) => Operation } | null> {
  const { W, H } = frameOf(c);
  switch (t.kind) {
    case 'layer': {
      const l = node<'layer'>(c, t.id);
      if (l.props.layerType === 'adjustment' || l.props.layerType === 'fill') return null;
      const host = c.env.services.renderHost();
      if (l.props.assetId) await host.loadAsset(l.props.assetId);
      const b = layerBounds(host, c.state, l.id);
      return { box: { x: b.x, y: b.y, w: b.width, h: b.height }, apply: (x, y) => ({ kind: 'update', id: l.id, set: { x: Math.round(l.props.x + (x - b.x)), y: Math.round(l.props.y + (y - b.y)) } }) };
    }
    case 'element': {
      const e = node<'slideElement'>(c, t.id);
      return { box: { x: e.props.x, y: e.props.y, w: e.props.w, h: e.props.h }, apply: (x, y) => ({ kind: 'update', id: e.id, set: { x, y } }) };
    }
    case 'clip': {
      const cl = node<'clip'>(c, t.id);
      const p = cl.props;
      let w: number;
      let h: number;
      if (p.title) {
        const lines = p.title.text.split('\n').length;
        w = W * 0.86 * p.scale;
        h = p.title.fontSize * 1.25 * lines * p.scale;
      } else {
        w = W * p.scale;
        h = H * p.scale;
      }
      const cx = W / 2 + p.x;
      const cy = H / 2 + p.y;
      return { box: { x: cx - w / 2, y: cy - h / 2, w, h }, apply: (x, y) => ({ kind: 'update', id: cl.id, set: { x: Math.round(x + w / 2 - W / 2), y: Math.round(y + h / 2 - H / 2) } }) };
    }
    case 'animLayer': {
      const l = node<'animLayer'>(c, t.id);
      const size = 200 * l.props.scale;
      return { box: { x: l.props.x - size / 2, y: l.props.y - size / 2, w: size, h: size }, apply: (x, y) => ({ kind: 'update', id: l.id, set: { x: Math.round(x + size / 2), y: Math.round(y + size / 2) } }) };
    }
    default:
      return null;
  }
}

async function placeTargets(c: Ctx, ts: TargetSet, pos: Position): Promise<CommandStep> {
  const { W, H } = frameOf(c);
  const ops: Operation[] = [];
  for (const t of ts.targets) {
    const b = await boxOf(c, t);
    if (!b) throw new Miss(`${ts.label} can't be positioned.`);
    const { x, y } = placeBox(pos, b.box, W, H);
    ops.push(b.apply(x, y));
  }
  return step(c.raw, `Move ${ts.label} to the ${pos.replace('-', ' ')}`, ops, targetIds(ts));
}

const ORDER_WORDS = /^(start|beginning|top|front|first|end|bottom|back|last)$/;

function reorder(c: Ctx, ts: TargetSet, where: string, ref?: TargetSet, relation?: string): CommandStep {
  const ops: Operation[] = [];
  for (const t of ts.targets) {
    if (!('id' in t)) throw new Miss(`${ts.label} can't be reordered.`);
    const n = c.state.nodes[t.id]!;
    if (!['slide', 'block', 'layer', 'animLayer'].includes(n.type)) throw new Miss(`${ts.label} can't be reordered that way.`);
    const parent = c.state.nodes[n.parentId!]!;
    const siblings = parent.children.filter((id) => id !== n.id);
    // Layers are listed top-first, so "top" means the end of the child list.
    const topIsEnd = n.type === 'layer' || n.type === 'animLayer';
    let index: number;
    if (ref && relation) {
      const r = ref.targets[0];
      if (!r || !('id' in r)) throw new Miss('I could not find what to move it next to.');
      const ri = siblings.indexOf(r.id);
      if (ri < 0) throw new Miss('Both things need to be in the same place to reorder them.');
      const after = /after|below|behind/.test(relation);
      index = topIsEnd ? (after ? ri : ri + 1) : after ? ri + 1 : ri;
    } else {
      const toStart = /start|beginning|top|front|first/.test(where);
      index = topIsEnd ? (toStart ? siblings.length : 0) : toStart ? 0 : siblings.length;
      if (n.type === 'layer' && !toStart && /bottom|back|last/.test(where)) index = 0;
    }
    ops.push({ kind: 'move', id: n.id, parentId: parent.id, index });
  }
  return step(c.raw, `Move ${ts.label}${ref ? ` ${relation} ${ref.label}` : ` to the ${where}`}`, ops, targetIds(ts));
}

const moveHandler: Handler = async (c) => {
  let m: string[] | null = /^(?:move|put|place|position|drag|shift|set|bring|send)\s+(.+?)\s+(?:to|into|in|at|on|toward|towards|over to)\s+(?:the\s+)?(.+)$/.exec(c.low);
  if (m) {
    const pos = positionFrom(m[2]!);
    if (pos) return placeTargets(c, targetsOf(c, m[1]!), pos);
    if (ORDER_WORDS.test(m[2]!.replace(/\s+of the (?:list|deck|document|page|stack)$/, ''))) return reorder(c, targetsOf(c, m[1]!), m[2]!);
    const at = /^position\s+(\d+)$/.exec(m[2]!);
    if (at) {
      const ts = targetsOf(c, m[1]!);
      const t = ts.targets[0];
      if (t && 'id' in t) {
        const n = c.state.nodes[t.id]!;
        return step(c.raw, `Move ${ts.label} to position ${at[1]}`, [{ kind: 'move', id: n.id, parentId: n.parentId!, index: Math.max(0, Number(at[1]) - 1) }], [n.id]);
      }
    }
  }
  m = /^(?:move|put|place|drag|bring|send)\s+(.+?)\s+(before|after|above|below|in front of|behind)\s+(.+)$/.exec(c.low);
  if (m) return reorder(c, targetsOf(c, m[1]!), '', targetsOf(c, m[3]!), m[2]!);
  m = /^(?:bring|send)\s+(.+?)\s+to\s+(?:the\s+)?(front|back)$/.exec(c.low);
  if (m) return reorder(c, targetsOf(c, m[1]!), m[2] === 'front' ? 'top' : 'bottom');
  m = /^(?:move|nudge|shift|push|drag)\s+(.+?)\s+(up|down|left|right|higher|lower)(?:\s+(?:by\s+)?(a (?:little|bit|touch)|slightly|a lot|(\d+)\s*(?:px|pixels|points|pt)?))?$/.exec(c.low);
  if (m) {
    const ts = targetsOf(c, m[1]!);
    const { W, H } = frameOf(c);
    const dir = m[2] === 'higher' ? 'up' : m[2] === 'lower' ? 'down' : m[2]!;
    const base = dir === 'up' || dir === 'down' ? H : W;
    const amount = m[4] ? Number(m[4]) : m[3] && /little|bit|touch|slightly/.test(m[3]) ? base * 0.03 : m[3] && /lot/.test(m[3]) ? base * 0.2 : base * 0.08;
    const ops: Operation[] = [];
    for (const t of ts.targets) {
      const b = await boxOf(c, t);
      if (!b) throw new Miss(`${ts.label} can't be moved.`);
      const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
      const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
      ops.push(b.apply(Math.round(b.box.x + dx), Math.round(b.box.y + dy)));
    }
    return step(c.raw, `Move ${ts.label} ${dir}`, ops, targetIds(ts));
  }
  m = /^(?:center|centre)\s+(.+?)(?:\s+(horizontally|vertically)|\s+on the (?:canvas|slide|page|frame|screen|image))?$/.exec(c.low);
  if (m) {
    const ts = targetsOf(c, m[1]!);
    const { W, H } = frameOf(c);
    const ops: Operation[] = [];
    for (const t of ts.targets) {
      const b = await boxOf(c, t);
      if (!b) throw new Miss(`${ts.label} can't be centered.`);
      const x = m[2] === 'vertically' ? b.box.x : Math.round((W - b.box.w) / 2);
      const y = m[2] === 'horizontally' ? b.box.y : Math.round((H - b.box.h) / 2);
      ops.push(b.apply(x, y));
    }
    return step(c.raw, `Center ${ts.label}${m[2] ? ` ${m[2]}` : ''}`, ops, targetIds(ts));
  }
  m = /^align\s+(.+?)\s+(?:to\s+(?:the\s+)?)?(left|right|top|bottom|center|centre|middle)(?:\s+(?:edge|side))?$/.exec(c.low);
  if (m) {
    const word = m[2] === 'centre' || m[2] === 'middle' ? 'center' : m[2]!;
    const ts = targetsOf(c, m[1]!);
    if (ts.targets.every((t) => t.kind === 'element' || t.kind === 'layer') && ['left', 'right', 'center'].includes(word) && ts.targets.every((t) => t.kind === 'element' ? node<'slideElement'>(c, t.id).props.elementType === 'text' : node<'layer'>(c, (t as { id: string }).id).props.layerType === 'text')) {
      // "align the title left" on text means text alignment.
      return step(c.raw, `Align ${ts.label} ${word}`, ts.targets.map((t) => ({ kind: 'update', id: (t as { id: string }).id, set: { align: word } }) as Operation), targetIds(ts));
    }
    return placeTargets(c, ts, positionFrom(word)!);
  }
  return null;
};

/* Size ---------------------------------------------------------------------- */

function sizeFactor(word: string, pct?: string, dir?: string): number | null {
  if (pct) {
    const n = Number(pct) / 100;
    return dir && /smaller/.test(dir) ? Math.max(0.05, 1 - n) : dir ? 1 + n : n;
  }
  if (/^(?:bigger|larger|wider|taller)$/.test(word)) return 1.25;
  if (/^(?:a (?:little|bit) (?:bigger|larger)|slightly (?:bigger|larger))$/.test(word)) return 1.1;
  if (/^(?:much (?:bigger|larger)|huge|a lot bigger)$/.test(word)) return 1.6;
  if (/^(?:smaller|narrower|shorter)$/.test(word)) return 0.8;
  if (/^(?:a (?:little|bit) smaller|slightly smaller)$/.test(word)) return 0.9;
  if (/^(?:much smaller|tiny|a lot smaller)$/.test(word)) return 0.6;
  if (/^twice as (?:big|large)$|^double (?:the )?size$/.test(word)) return 2;
  if (/^half (?:the|its|as) size$|^half as (?:big|large)$/.test(word)) return 0.5;
  return null;
}

async function resizeTargets(c: Ctx, ts: TargetSet, f: number): Promise<CommandStep> {
  const ops: Operation[] = [];
  for (const t of ts.targets) {
    switch (t.kind) {
      case 'layer': {
        const l = node<'layer'>(c, t.id);
        if (l.props.layerType === 'text') ops.push({ kind: 'update', id: l.id, set: { fontSize: Math.max(4, Math.round((l.props.fontSize ?? 48) * f)) } });
        else {
          const b = await boxOf(c, t);
          if (!b) throw new Miss(`${ts.label} has no size.`);
          const cx = b.box.x + b.box.w / 2;
          const cy = b.box.y + b.box.h / 2;
          const nx = cx - (b.box.w * f) / 2;
          const ny = cy - (b.box.h * f) / 2;
          ops.push({ kind: 'update', id: l.id, set: { scaleX: l.props.scaleX * f, scaleY: l.props.scaleY * f, x: Math.round(l.props.x + (nx - b.box.x)), y: Math.round(l.props.y + (ny - b.box.y)) } });
        }
        break;
      }
      case 'element': {
        const e = node<'slideElement'>(c, t.id);
        const p = e.props;
        const set: Record<string, unknown> = { w: Math.round(p.w * f), h: Math.round(p.h * f), x: Math.round(p.x - (p.w * (f - 1)) / 2), y: Math.round(p.y - (p.h * (f - 1)) / 2) };
        if (p.elementType === 'text') set.fontSize = Math.max(6, Math.round((p.fontSize ?? (p.role === 'title' ? deckOf(c)!.props.theme.sizes.title : deckOf(c)!.props.theme.sizes.body)) * f));
        ops.push({ kind: 'update', id: e.id, set });
        break;
      }
      case 'clip': {
        const cl = node<'clip'>(c, t.id);
        if (cl.props.title) ops.push({ kind: 'update', id: cl.id, set: { title: { ...cl.props.title, fontSize: Math.max(8, Math.round(cl.props.title.fontSize * f)) } } });
        else ops.push({ kind: 'update', id: cl.id, set: { scale: Math.round(cl.props.scale * f * 1000) / 1000 } });
        break;
      }
      case 'animLayer': {
        const l = node<'animLayer'>(c, t.id);
        ops.push({ kind: 'update', id: l.id, set: { scale: Math.round(l.props.scale * f * 1000) / 1000 } });
        break;
      }
      case 'textStyle':
      case 'document': {
        const docId = t.kind === 'document' ? t.id : t.documentId;
        const doc = node<'document'>(c, docId);
        const keys = t.kind === 'document' ? Object.keys(doc.props.styles) : t.styles;
        const styles = { ...doc.props.styles };
        for (const k of keys) if (styles[k]) styles[k] = { ...styles[k]!, fontSize: Math.max(6, Math.round(styles[k]!.fontSize * f)) };
        ops.push({ kind: 'update', id: doc.id, set: { styles } });
        break;
      }
      default:
        throw new Miss(`I can't resize ${ts.label}.`);
    }
  }
  return step(c.raw, `${f >= 1 ? 'Enlarge' : 'Shrink'} ${ts.label}`, ops, targetIds(ts));
}

const sizeHandler: Handler = async (c) => {
  let m: string[] | null = /^(?:make|scale|resize|have)\s+(.+?)\s+((?:a (?:little|bit) |slightly |much |a lot )?(?:bigger|larger|smaller|wider|taller|narrower|shorter)|huge|tiny|twice as (?:big|large)|half (?:the|its|as) size|half as (?:big|large)|double (?:the )?size|(\d+)\s*%\s*(bigger|larger|smaller))$/.exec(c.low);
  if (m) {
    const f = sizeFactor(m[2]!.replace(/\s+/g, ' '), m[3], m[4]);
    if (f) return resizeTargets(c, targetsOf(c, m[1]!), f);
  }
  m = /^(?:scale|resize|zoom|size)\s+(.+?)\s+(?:to|by)\s+(\d+)\s*%$/.exec(c.low);
  if (m) return resizeTargets(c, targetsOf(c, m[1]!), Number(m[2]) / 100);
  m = /^(grow|enlarge|shrink)\s+(.+)$/.exec(c.low);
  if (m) return resizeTargets(c, targetsOf(c, m[2]!), m[1] === 'shrink' ? 0.8 : 1.25);
  m = /^(?:make|set|change)\s+(?:the\s+)?(?:font|text)\s*(?:size)?\s+(?:of\s+(.+?)\s+)?(?:to\s+)?(bigger|larger|smaller|(\d+)\s*(?:px|pt|points)?)$/.exec(c.low);
  if (m) {
    const ts = m[1] ? targetsOf(c, m[1]) : c.scope.selection.length ? targetsOf(c, 'selection') : targetsOf(c, 'text');
    if (m[3]) {
      const size = Number(m[3]);
      const ops: Operation[] = ts.targets.map((t) => {
        if (t.kind === 'layer') return { kind: 'update', id: t.id, set: { fontSize: size } };
        if (t.kind === 'element') return { kind: 'update', id: t.id, set: { fontSize: size } };
        if (t.kind === 'clip' && node<'clip'>(c, t.id).props.title) return { kind: 'update', id: t.id, set: { title: { ...node<'clip'>(c, t.id).props.title!, fontSize: size } } };
        throw new Miss(`I can't set a font size on ${ts.label}.`);
      });
      return step(c.raw, `Font size ${size} for ${ts.label}`, ops, targetIds(ts));
    }
    return resizeTargets(c, ts, m[2] === 'smaller' ? 0.85 : 1.2);
  }
  return null;
};

/* Visibility, opacity, delete, rename, duplicate ------------------------------- */

const visibilityHandler: Handler = async (c) => {
  const m = /^(hide|show|unhide|reveal)\s+(.+)$/.exec(c.low);
  if (!m) return null;
  const show = m[1] !== 'hide';
  const ts = targetsOf(c, m[2]!);
  const ops: Operation[] = ts.targets.map((t) => {
    if (t.kind === 'layer' || t.kind === 'animLayer') return { kind: 'update', id: t.id, set: { visible: show } };
    if (t.kind === 'slide') return { kind: 'update', id: t.id, set: { hidden: !show } };
    if (t.kind === 'element' || t.kind === 'clip') return { kind: 'update', id: t.id, set: { opacity: show ? 1 : 0 } };
    throw new Miss(`I can't ${m[1]} ${ts.label}.`);
  });
  return step(c.raw, `${show ? 'Show' : 'Hide'} ${ts.label}`, ops, targetIds(ts));
};

function opacityOps(c: Ctx, ts: TargetSet, value: number): Operation[] {
  return ts.targets.map((t) => {
    if (t.kind === 'layer' || t.kind === 'element' || t.kind === 'clip' || t.kind === 'animLayer') return { kind: 'update', id: t.id, set: { opacity: Math.max(0, Math.min(1, value)) } };
    throw new Miss(`I can't change the opacity of ${ts.label}.`);
  });
}

const opacityHandler: Handler = async (c) => {
  let m: string[] | null = /^(?:set|make|change|put)\s+(?:the\s+)?(?:opacity|transparency)\s+(?:of\s+)?(.+?)\s+(?:to|at)\s+(\d+)\s*%$/.exec(c.low) ?? /^(?:set|make|change)\s+(.+?)(?:'s)?\s+(?:opacity|transparency)\s+(?:to\s+)?(\d+)\s*%$/.exec(c.low);
  if (m) {
    const ts = targetsOf(c, m[1]!);
    const v = Number(m[2]) / 100;
    const isTransparency = /transparency/.test(c.low);
    return step(c.raw, `Opacity ${Math.round((isTransparency ? 1 - v : v) * 100)}% for ${ts.label}`, opacityOps(c, ts, isTransparency ? 1 - v : v), targetIds(ts));
  }
  m = /^make\s+(.+?)\s+(\d+)\s*%\s+(transparent|opaque|see-through)$/.exec(c.low);
  if (m) {
    const ts = targetsOf(c, m[1]!);
    const v = Number(m[2]) / 100;
    const opacity = m[3] === 'opaque' ? v : 1 - v;
    return step(c.raw, `Opacity ${Math.round(opacity * 100)}% for ${ts.label}`, opacityOps(c, ts, opacity), targetIds(ts));
  }
  m = /^make\s+(.+?)\s+(semi-?transparent|see-through|transparent|faint|ghostly|fully opaque|opaque|solid)$/.exec(c.low);
  if (m) {
    const ts = targetsOf(c, m[1]!);
    const opacity = /opaque|solid/.test(m[2]!) ? 1 : m[2] === 'transparent' ? 0.3 : 0.5;
    return step(c.raw, `Opacity ${Math.round(opacity * 100)}% for ${ts.label}`, opacityOps(c, ts, opacity), targetIds(ts));
  }
  return null;
};

async function removeBackgroundStep(c: Ctx, canvasId: string): Promise<CommandStep> {
  const canvas = node<'canvas'>(c, canvasId);
  const rasters = canvasLayers(c.state, canvasId).filter((l) => l.props.layerType === 'raster' && l.props.visible);
  const main = [...rasters].sort((a, b) => (b.props.width ?? 0) * (b.props.height ?? 0) - (a.props.width ?? 0) * (a.props.height ?? 0))[0];
  if (!main) throw new Miss('There is no photo layer to remove the background from.');
  const r = await layerRaster(c.env.services.renderHost(), c.state, canvas.id, main.id, false);
  const s = subjectMask(r);
  if (!s) throw new Miss("I couldn't tell the subject from the background in this photo.");
  const assetId = await uploadRaster(c.env.services, s, `${main.props.name} mask.png`, c.env.projectId, c.env.ownerId, { asMask: true });
  return step(c.raw, `Remove the background from "${main.props.name}"`, [{ kind: 'update', id: main.id, set: { mask: { source: { kind: 'mask', assetId }, inverted: false, enabled: true } } }], [main.id]);
}

const deleteHandler: Handler = async (c) => {
  const m = /^(?:delete|remove|get rid of|erase|drop|cut out|take out)\s+(.+?)(?:\s+from\s+(?:the\s+)?(?:image|photo|picture|canvas|video|timeline|slide|deck|document|doc))?$/.exec(c.low);
  if (!m) return null;
  const ts = targetsOf(c, m[1]!);
  const ops: Operation[] = [];
  for (const t of ts.targets) {
    if (t.kind === 'region' && t.region === 'background') return removeBackgroundStep(c, t.canvasId);
    if (t.kind === 'region') throw new Miss(`To remove ${ts.label}, select it and use Generative fill (it fills the area from its surroundings).`);
    if (t.kind === 'slideBackground') {
      ops.push({ kind: 'update', id: t.id, set: { background: null } });
      continue;
    }
    if (!['layer', 'clip', 'element', 'slide', 'block', 'animLayer'].includes(t.kind)) throw new Miss(`I won't delete ${ts.label} from a command. Do it from the editor if you're sure.`);
    const id = (t as { id: string }).id;
    if (t.kind === 'slide' && deckSlides(c.state, deckOf(c)!.id).length <= 1) throw new Miss('A slideshow needs at least one slide.');
    ops.push({ kind: 'delete', id });
  }
  return step(c.raw, `Delete ${ts.label}`, ops, []);
};

const renameHandler: Handler = async (c) => {
  const m = /^(?:rename|call|name)\s+(.+?)\s+(?:to|as)?\s*(["“'‘].+["”'’]|.+)$/.exec(c.low);
  if (!m || !/^(?:rename|call|name)\s/.test(c.low) || !/\s(?:to|as)\s|["“'‘]/.test(c.low.slice(m[1]!.length))) return null;
  const ts = targetsOf(c, m[1]!);
  const name = unquote(originalTail(c, m[2]!));
  const ops: Operation[] = ts.targets.map((t) => {
    if (['layer', 'clip', 'animLayer', 'slide'].includes(t.kind)) return { kind: 'update', id: (t as { id: string }).id, set: { name } };
    if (t.kind === 'canvas' || t.kind === 'sequence' || t.kind === 'deck' || t.kind === 'document') return { kind: 'update', id: t.id, set: { name } };
    throw new Miss(`${ts.label} has no name to change. Did you mean to change its text?`);
  });
  return step(c.raw, `Rename ${ts.label} to "${name}"`, ops, targetIds(ts));
};

/** The original-case text for a lowercased tail of the clause. */
function originalTail(c: Ctx, lowTail: string): string {
  const i = c.low.lastIndexOf(lowTail);
  return i >= 0 ? c.raw.slice(i, i + lowTail.length) : lowTail;
}

const duplicateHandler: Handler = async (c) => {
  const m = /^(?:duplicate|copy|clone)\s+(.+)$/.exec(c.low);
  if (!m) return null;
  const ts = targetsOf(c, m[1]!);
  const ops: Operation[] = [];
  const ids: string[] = [];
  for (const t of ts.targets) {
    if (t.kind === 'slide') {
      const r = duplicateSlideOps(c.state, t.id);
      ops.push(r.op);
      ids.push(r.slideId);
      continue;
    }
    if (!['layer', 'element', 'block', 'clip', 'animLayer'].includes(t.kind)) throw new Miss(`I can't duplicate ${ts.label}.`);
    const n = c.state.nodes[(t as { id: string }).id]!;
    if (n.children.length) throw new Miss(`Duplicating groups isn't supported from commands yet.`);
    const copy = { ...structuredClone(n), id: newId(n.id.split('_')[0] ?? n.type.slice(0, 3)), children: [] } as SceneNode;
    const props = copy.props as unknown as Record<string, unknown>;
    if (typeof props.name === 'string') props.name = `${props.name} copy`;
    if (n.type === 'layer') {
      props.x = (props.x as number) + 20;
      props.y = (props.y as number) + 20;
    } else if (n.type === 'slideElement') {
      props.x = (props.x as number) + 24;
      props.y = (props.y as number) + 24;
    } else if (n.type === 'clip') {
      props.start = (n as SceneNode<'clip'>).props.start + clipDuration((n as SceneNode<'clip'>).props);
    }
    const parent = c.state.nodes[n.parentId!]!;
    ops.push({ kind: 'create', parentId: parent.id, index: parent.children.indexOf(n.id) + 1, nodes: [copy] });
    ids.push(copy.id);
  }
  return step(c.raw, `Duplicate ${ts.label}`, ops, ids);
};

/* Text, color, font --------------------------------------------------------------- */

function textOps(c: Ctx, ts: TargetSet, text: string): Operation[] {
  return ts.targets.map((t) => {
    switch (t.kind) {
      case 'layer': {
        const l = node<'layer'>(c, t.id);
        if (l.props.layerType !== 'text') throw new Miss(`"${l.props.name}" isn't a text layer.`);
        return { kind: 'update', id: l.id, set: { text, ...(l.props.name === l.props.text?.split('\n')[0] || /^text$/i.test(l.props.name) ? { name: text.split('\n')[0]!.slice(0, 60) } : {}) } };
      }
      case 'clip': {
        const cl = node<'clip'>(c, t.id);
        if (!cl.props.title) throw new Miss(`"${cl.props.name}" isn't a title.`);
        return { kind: 'update', id: cl.id, set: { title: { ...cl.props.title, text }, name: text.slice(0, 40) } };
      }
      case 'element': {
        const e = node<'slideElement'>(c, t.id);
        if (e.props.elementType !== 'text') throw new Miss('That element has no text.');
        return { kind: 'update', id: e.id, set: { text } };
      }
      case 'block':
        return { kind: 'update', id: t.id, set: { text } };
      default:
        throw new Miss(`${ts.label} has no text.`);
    }
  });
}

const textHandler: Handler = async (c) => {
  let m: string[] | null = /^(?:change|set|replace|update|edit)\s+(?:the\s+(?:text|wording|copy|words)\s+(?:of|in|on)\s+)?(.+?)(?:'s text|\s+text)?\s+(?:to|with)\s+(["“'‘].+["”'’])$/.exec(c.low);
  if (!m) m = /^(?:make|have|let)\s+(.+?)\s+(?:say|read)\s+(.+)$/.exec(c.low);
  if (!m) {
    const loose = /^(?:change|set|retitle|update)\s+(.+?)\s+to\s+(.+)$/.exec(c.low);
    if (loose && !colorFrom(loose[2]!) && !positionFrom(loose[2]!) && !/^\d+\s*(?:%|px|pt|x|s|seconds?)?$/.test(loose[2]!) && !/theme|layout|font|transition|speed|volume|opacity/.test(loose[2]!)) {
      const ts = resolveTargets(loose[1]!, c.scope);
      if (ts && ts.targets.every((t) => t.kind === 'element' || t.kind === 'block' || (t.kind === 'layer' && node<'layer'>(c, t.id).props.layerType === 'text') || (t.kind === 'clip' && node<'clip'>(c, t.id).props.title))) m = loose;
    }
  }
  if (!m) return null;
  const ts = targetsOf(c, m[1]!);
  const text = unquote(originalTail(c, m[2]!));
  return step(c.raw, `Change ${ts.label} to "${text.slice(0, 40)}"`, textOps(c, ts, text), targetIds(ts));
}

async function colorOps(c: Ctx, ts: TargetSet, color: string): Promise<{ ops: Operation[]; ids: string[] }> {
  const ops: Operation[] = [];
  const ids: string[] = [];
  for (const t of ts.targets) {
    switch (t.kind) {
      case 'layer': {
        const l = node<'layer'>(c, t.id);
        const p = l.props;
        if (p.layerType === 'text') ops.push({ kind: 'update', id: l.id, set: { color } });
        else if (p.layerType === 'fill') ops.push({ kind: 'update', id: l.id, set: { fillColor: color } });
        else if (p.layerType === 'vector') ops.push({ kind: 'update', id: l.id, set: { shapes: (p.shapes ?? []).map((s) => ({ ...s, fill: color })) } });
        else throw new Miss(`"${p.name}" is a photo layer; try "make it warmer" or add a color fill instead.`);
        ids.push(l.id);
        break;
      }
      case 'region': {
        if (t.region !== 'background') throw new Miss(`Recoloring ${ts.label} isn't supported; try "make ${ts.label} warmer".`);
        const assetId = await regionMask(c, t.canvasId, 'background');
        const canvas = node<'canvas'>(c, t.canvasId);
        const n = makeNode('layer', layerProps('fill', { name: 'New background', fillColor: color, mask: { source: { kind: 'mask', assetId }, inverted: false, enabled: true } }));
        // Just above the photo the background came from (below text and graphics on top).
        const layers = canvas.children;
        const photo = [...layers].reverse().find((id) => node<'layer'>(c, id).props.layerType === 'raster');
        ops.push({ kind: 'create', parentId: canvas.id, index: photo ? layers.indexOf(photo) + 1 : layers.length, nodes: [n] });
        ids.push(n.id);
        break;
      }
      case 'canvas': {
        const bg = canvasLayers(c.state, t.id).find((l) => l.props.layerType === 'fill');
        if (!bg) throw new Miss('This image has no background fill to recolor.');
        ops.push({ kind: 'update', id: bg.id, set: { fillColor: color } });
        ids.push(bg.id);
        break;
      }
      case 'clip': {
        const cl = node<'clip'>(c, t.id);
        if (!cl.props.title) throw new Miss('Only titles have a color; for footage try "make it warmer".');
        ops.push({ kind: 'update', id: cl.id, set: { title: { ...cl.props.title, color } } });
        ids.push(cl.id);
        break;
      }
      case 'sequence':
        ops.push({ kind: 'update', id: t.id, set: { background: color } });
        ids.push(t.id);
        break;
      case 'element': {
        const e = node<'slideElement'>(c, t.id);
        if (e.props.elementType === 'text') ops.push({ kind: 'update', id: e.id, set: { color } });
        else if (e.props.elementType === 'shape' && e.props.shape) ops.push({ kind: 'update', id: e.id, set: { shape: { ...e.props.shape, fill: color } } });
        else throw new Miss('That element has no color to change.');
        ids.push(e.id);
        break;
      }
      case 'slide':
      case 'slideBackground':
        ops.push({ kind: 'update', id: t.id, set: { background: color } });
        ids.push(t.id);
        break;
      case 'deck': {
        const deck = node<'deck'>(c, t.id);
        ops.push(applyThemeOp(c.state, deck.id, { ...deck.props.theme, colors: { ...deck.props.theme.colors, accent: color } }));
        ids.push(deck.id);
        break;
      }
      case 'textStyle': {
        const doc = node<'document'>(c, t.documentId);
        const styles = { ...doc.props.styles };
        for (const k of t.styles) if (styles[k]) styles[k] = { ...styles[k]!, color };
        ops.push({ kind: 'update', id: doc.id, set: { styles } });
        ids.push(doc.id);
        break;
      }
      default:
        throw new Miss(`I can't recolor ${ts.label}.`);
    }
  }
  return { ops, ids };
}

const colorHandler: Handler = async (c) => {
  let target: string | null = null;
  let word = '';
  const m: string[] | null = /^(?:change|set)\s+(?:the\s+)?(?:colou?r|fill|text colou?r)\s+(?:of\s+)?(.+?)\s+to\s+(.+)$/.exec(c.low);
  if (m && colorFrom(m[2]!)) {
    target = m[1]!;
    word = m[2]!;
  } else {
    const v = /^(?:make|turn|colou?r|paint|change|set|tint)\s+(.+)$/.exec(c.low);
    const hit = v && splitTail(v[1]!.replace(/\s+(?:to|into)(?=\s+\S+(?:\s+\S+)?$)/, ''), (tail) => (colorFrom(tail) ? tail : null), 2);
    if (hit) {
      target = hit.head.replace(/(?:'s|\s+)colou?r$/, '').trim();
      word = hit.value;
    }
  }
  if (!target) return null;
  const color = colorFrom(word)!;
  const ts = targetsOf(c, target);
  const { ops, ids } = await colorOps(c, ts, color);
  return step(c.raw, `Make ${ts.label} ${word}`, ops, ids);
};

const fontHandler: Handler = async (c) => {
  let m = rx(/^(?:make|set|turn)\s+(.+?)\s+(bold|not bold|unbold|italic|italics|not italic|upright|regular|normal|plain)$/, c.low) ?? rx(/^(bold|unbold|italicize|embolden)\s+(.+)$/, c.low, [2, 1]);
  if (m) {
    const target = m[1]!;
    const word = m[2]!;
    const bold = /^(?:bold|embolden)$/.test(word) ? true : /not bold|unbold|regular|normal|plain/.test(word) ? false : undefined;
    const italic = /^(?:italic|italics|italicize)$/.test(word) ? true : /not italic|upright|regular|normal|plain/.test(word) ? false : undefined;
    const ts = targetsOf(c, target);
    const ops: Operation[] = ts.targets.map((t) => {
      switch (t.kind) {
        case 'layer':
          return { kind: 'update', id: t.id, set: { ...(bold !== undefined ? { fontWeight: bold ? 700 : 400 } : {}), ...(italic !== undefined ? { fontStyle: italic ? 'italic' : 'normal' } : {}) } };
        case 'element':
          if (bold === undefined) throw new Miss('Slide text boxes can be bold or regular; italics go in the text itself (*like this*).');
          return { kind: 'update', id: t.id, set: { bold } };
        case 'clip': {
          const cl = node<'clip'>(c, t.id);
          if (!cl.props.title) throw new Miss('Only titles have a font.');
          return { kind: 'update', id: cl.id, set: { title: { ...cl.props.title, fontWeight: bold === false ? 400 : 750 } } };
        }
        case 'textStyle': {
          const doc = node<'document'>(c, t.documentId);
          const styles = { ...doc.props.styles };
          for (const k of t.styles) if (styles[k]) styles[k] = { ...styles[k]!, ...(bold !== undefined ? { fontWeight: bold ? 700 : 400 } : {}), ...(italic !== undefined ? { italic } : {}) };
          return { kind: 'update', id: doc.id, set: { styles } };
        }
        case 'block': {
          const b = node<'block'>(c, t.id);
          const plain = b.props.text.replace(/^\*\*(.*)\*\*$/s, '$1').replace(/^\*(.*)\*$/s, '$1');
          const text = bold ? `**${plain}**` : italic ? `*${plain}*` : plain;
          return { kind: 'update', id: b.id, set: { text } };
        }
        default:
          throw new Miss(`I can't change the font of ${ts.label}.`);
      }
    });
    return step(c.raw, `${bold === true ? 'Bold' : italic === true ? 'Italic' : 'Regular'} ${ts.label}`, ops, targetIds(ts));
  }
  m = rx(/^(?:use|set|change|switch)\s+(?:the\s+)?font\s+(?:of\s+(.+?)\s+)?(?:to\s+)?(.+?)(?:\s+for\s+(.+))?$/, c.low) ?? rx(/^use\s+(?:the\s+)?(.+?)(?:\s+font)?\s+(?:for|on)\s+(.+)$/, c.low, [3, 1, 2]);
  if (m && (m[2] || m[3])) {
    const familyLow = m[2]!.replace(/\s+font$/, '').replace(/^["']|["']$/g, '');
    const family = originalTail(c, familyLow).replace(/\b\w/g, (ch) => ch.toUpperCase());
    const targetPhrase = m[1] ?? m[3];
    const ts = targetPhrase ? targetsOf(c, targetPhrase) : wholeDoc(c);
    const ops: Operation[] = ts.targets.map((t) => {
      switch (t.kind) {
        case 'layer':
          return { kind: 'update', id: t.id, set: { fontFamily: family } };
        case 'element':
          return { kind: 'update', id: t.id, set: { fontFamily: family } };
        case 'clip': {
          const cl = node<'clip'>(c, t.id);
          if (!cl.props.title) throw new Miss('Only titles have a font.');
          return { kind: 'update', id: cl.id, set: { title: { ...cl.props.title, fontFamily: family } } };
        }
        case 'deck': {
          const deck = node<'deck'>(c, t.id);
          return applyThemeOp(c.state, deck.id, { ...deck.props.theme, fonts: { ...deck.props.theme.fonts, heading: family, body: family } });
        }
        case 'textStyle':
        case 'document': {
          const docId = t.kind === 'document' ? t.id : t.documentId;
          const doc = node<'document'>(c, docId);
          const keys = t.kind === 'document' ? Object.keys(doc.props.styles).filter((k) => k !== 'code') : t.styles;
          const styles = { ...doc.props.styles };
          for (const k of keys) if (styles[k]) styles[k] = { ...styles[k]!, fontFamily: family };
          return { kind: 'update', id: doc.id, set: { styles } };
        }
        default:
          throw new Miss(`I can't change the font of ${ts.label}.`);
      }
    });
    return step(c.raw, `Use ${family} for ${ts.label}`, ops, targetIds(ts));
  }
  return null;
};

/* Add ---------------------------------------------------------------------------- */

const addHandler: Handler = async (c) => {
  const m = /^(?:add|insert|create|put in|make)\s+(?:a\s+|an\s+|another\s+|one more\s+|some\s+)?(?:new\s+|blank\s+|empty\s+)?(title|heading|headline|subtitle|subheading|caption|text(?: box| layer)?|label|slide|section(?: heading)?|paragraph|bullet(?: point)?|quote|note|divider|layer|track|video track|audio track|title track)(?:\s+(?:that says|saying|reading|with(?: the)? (?:text|title|words)|titled|called|named|about))?\s*:?\s*(.*)$/.exec(c.low);
  if (!m) return null;
  const kind = m[1]!;
  const value = m[2] ? unquote(originalTail(c, m[2])) : '';
  const doc = c.state.nodes[c.env.documentId]!;
  if (kind === 'note') {
    if (!value) throw new Miss('What should the note say?');
    const n = makeNode('note', { kind: 'note', text: value, author: { type: 'system', id: 'command', name: 'Command' }, createdAt: new Date().toISOString() });
    return step(c.raw, 'Add a note', [{ kind: 'create', parentId: notesContainer(c.state).id, nodes: [n] }], [n.id]);
  }
  switch (doc.type) {
    case 'canvas': {
      const canvas = doc as SceneNode<'canvas'>;
      if (/layer$/.test(kind) && kind !== 'text layer') {
        const n = makeNode('layer', layerProps('raster', { name: value || 'Layer', width: canvas.props.width, height: canvas.props.height }));
        return step(c.raw, 'Add a layer', [{ kind: 'create', parentId: canvas.id, nodes: [n] }], [n.id]);
      }
      const big = /title|heading|headline/.test(kind);
      const small = /caption|label/.test(kind);
      const fontSize = Math.round(canvas.props.height * (big ? 0.09 : small ? 0.035 : 0.05));
      const text = value || (big ? 'Title' : 'Text');
      const width = Math.min(canvas.props.width * 0.9, text.length * fontSize * 0.55);
      const pos = placeBox(big ? 'upper-third' : small ? 'lower-third' : 'center', { x: 0, y: 0, w: width, h: fontSize * 1.2 }, canvas.props.width, canvas.props.height);
      const n = makeNode('layer', layerProps('text', { name: text.slice(0, 40), text, fontSize, fontWeight: big ? 700 : 500, color: '#ffffff', align: 'center', x: Math.round(canvas.props.width / 2), y: pos.y }));
      return step(c.raw, `Add ${big ? 'a title' : 'text'} "${text.slice(0, 30)}"`, [{ kind: 'create', parentId: canvas.id, nodes: [n] }], [n.id]);
    }
    case 'sequence': {
      const seq = doc as SceneNode<'sequence'>;
      if (/track$/.test(kind)) {
        const tt = /audio/.test(kind) ? 'audio' : /title/.test(kind) ? 'title' : 'video';
        const n = makeNode('track', { name: value || `${tt[0]!.toUpperCase()}${tt.slice(1)} ${tracksOf(c.state, seq.id).filter((x) => x.props.trackType === tt).length + 1}`, trackType: tt });
        return step(c.raw, `Add a ${tt} track`, [{ kind: 'create', parentId: seq.id, index: tt === 'audio' ? undefined : 0, nodes: [n] } as Operation], [n.id]);
      }
      const caption = /caption|subtitle/.test(kind);
      const text = value || 'Title';
      const ops: Operation[] = [];
      let track = tracksOf(c.state, seq.id).find((x) => x.props.trackType === 'title');
      if (!track) {
        track = makeNode('track', { name: 'Titles', trackType: 'title' });
        ops.push({ kind: 'create', parentId: seq.id, index: 0, nodes: [track] });
      }
      const start = Math.max(0, c.env.time ?? 0);
      const clip = makeNode('clip', {
        name: text.slice(0, 40),
        start,
        in: 0,
        out: 3,
        title: { text, fontFamily: 'Inter', fontSize: caption ? 44 : 96, fontWeight: caption ? 600 : 750, color: '#ffffff', background: caption ? '#00000099' : null, align: 'center', caption },
        transitionIn: caption ? null : { kind: 'crossfade', duration: 0.4, easing: 'ease-out' },
        transitionOut: caption ? null : { kind: 'crossfade', duration: 0.4, easing: 'ease-in' },
      });
      ops.push({ kind: 'create', parentId: track.id, nodes: [clip] });
      if (start + 3 > seq.props.duration) ops.push({ kind: 'update', id: seq.id, set: { duration: start + 3 } });
      return step(c.raw, `Add ${caption ? 'a caption' : 'a title'} "${text.slice(0, 30)}"`, ops, [clip.id]);
    }
    case 'deck': {
      const deck = doc as SceneNode<'deck'>;
      if (kind === 'slide' || /^section/.test(kind)) {
        const slides = deckSlides(c.state, deck.id);
        const cur = currentSlide(c);
        const layout: SlideLayout = /^section/.test(kind) ? 'section' : value ? 'title-body' : 'title-body';
        const r = newSlideOps(c.state, deck.id, layout, { index: cur ? slides.indexOf(cur) + 1 : slides.length, ...(value ? { name: value.slice(0, 60), text: { title: value } } : {}) });
        return step(c.raw, `Add a slide${value ? ` "${value.slice(0, 30)}"` : ''}`, [r.op], [r.slideId]);
      }
      const slide = currentSlide(c);
      if (!slide) throw new Miss('Add a slide first.');
      const { W, H } = frameOf(c);
      const big = /title|heading|headline/.test(kind);
      const th = deck.props.theme;
      const h = big ? th.sizes.title * 1.6 : th.sizes.body * 2.2;
      const e = makeNode('slideElement', { elementType: 'text', role: big ? 'title' : /subtitle|subheading/.test(kind) ? 'subtitle' : null, x: Math.round(W * 0.08), y: Math.round(big ? H * 0.1 : H * 0.7), w: Math.round(W * 0.84), h: Math.round(h), text: value || (big ? 'Title' : 'Text'), animations: [] });
      return step(c.raw, `Add text to the slide`, [{ kind: 'create', parentId: slide.id, nodes: [e] }], [e.id]);
    }
    case 'document': {
      const blocks = documentBlocks(c.state, doc.id);
      const type: BlockType = /title|heading|headline|section/.test(kind) ? 'heading' : /bullet/.test(kind) ? 'bullet' : kind === 'quote' ? 'quote' : kind === 'divider' ? 'divider' : 'paragraph';
      const after = blocks.find((b) => c.scope.selection.includes(b.id));
      const index = after ? doc.children.indexOf(after.id) + 1 : doc.children.length;
      const b = makeNode('block', { blockType: type, text: value, ...(type === 'heading' ? { level: /title/.test(kind) ? 1 : /sub/.test(kind) ? 3 : 2 } : {}) });
      return step(c.raw, `Add a ${type}${value ? ` "${value.slice(0, 30)}"` : ''}`, [{ kind: 'create', parentId: doc.id, index, nodes: [b] }], [b.id]);
    }
    default:
      throw new Miss(`I can't add a ${kind} here.`);
  }
};

/* Filters and effects ----------------------------------------------------------- */

const filterHandler: Handler = async (c) => {
  let filter: FilterKind | null = null;
  let targetPhrase: string | null = null;
  let amount: string | undefined;
  let m: string[] | null = /^(blur|sharpen|pixelate|soften|defocus)\s+(.+?)(?:\s+(a (?:little|bit|touch)|slightly|a lot|heavily|lightly|more|by\s+\d+\s*(?:px)?))?$/.exec(c.low);
  if (m) {
    filter = m[1] === 'sharpen' ? 'sharpen' : m[1] === 'pixelate' ? 'pixelate' : 'gaussianBlur';
    targetPhrase = m[2]!;
    amount = m[3];
  }
  m = m ? null : /^(?:add|apply|put)\s+(?:a\s+|an\s+|some\s+)?(?:subtle\s+|light\s+|heavy\s+|strong\s+)?(vignette|grain|film grain|noise|blur|sharpening|emboss)(?:\s+(?:effect|filter))?(?:\s+(?:to|on)\s+(.+))?$/.exec(c.low);
  if (m) {
    filter = /vignette/.test(m[1]!) ? 'vignette' : /grain|noise/.test(m[1]!) ? 'noise' : /blur/.test(m[1]!) ? 'gaussianBlur' : /sharp/.test(m[1]!) ? 'sharpen' : 'emboss';
    targetPhrase = m[2] ?? null;
    amount = /subtle|light/.test(c.low) ? 'slightly' : /heavy|strong/.test(c.low) ? 'a lot' : undefined;
  }
  if (!filter) return null;
  const params: Record<string, number> = { ...FILTER_DEFAULTS[filter] };
  const k = amount ? (/little|bit|touch|slightly|lightly/.test(amount) ? 0.5 : /lot|heavily/.test(amount) ? 2 : 1) : 1;
  const px = amount && /by\s+(\d+)/.exec(amount);
  if (filter === 'gaussianBlur') params.radius = px ? Number(px[1]) : Math.round((params.radius ?? 4) * k);
  else if ('amount' in params) params.amount = Math.round(params.amount! * k * 100) / 100;
  const ts = targetPhrase ? targetsOf(c, targetPhrase) : wholeDoc(c);
  const ops: Operation[] = [];
  const ids: string[] = [];
  for (const t of ts.targets) {
    if (t.kind === 'layer') {
      ops.push({ kind: 'listInsert', id: t.id, prop: 'filters', items: [{ id: newId('flt'), filter, params, enabled: true, opacity: 1 }] });
      ids.push(t.id);
    } else if (t.kind === 'canvas' || t.kind === 'region') {
      const canvasId = t.kind === 'canvas' ? t.id : t.canvasId;
      const photo = [...canvasLayers(c.state, canvasId)].reverse().find((l) => l.props.layerType === 'raster' && l.props.visible);
      if (!photo) throw new Miss('There is no photo layer to apply that to.');
      if (t.kind === 'region') throw new Miss(`Filters apply to whole layers. Try "blur the ${photo.props.name}", or mask the area first.`);
      ops.push({ kind: 'listInsert', id: photo.id, prop: 'filters', items: [{ id: newId('flt'), filter, params, enabled: true, opacity: 1 }] });
      ids.push(photo.id);
    } else if (t.kind === 'clip') {
      ops.push({ kind: 'listInsert', id: t.id, prop: 'effects', items: [{ id: newId('fx'), effect: filter, params, enabled: true }] });
      ids.push(t.id);
    } else if (t.kind === 'sequence') {
      const r = wholeSequenceEffect(c, node<'sequence'>(c, t.id), { id: newId('fx'), effect: filter, params, enabled: true }, filter);
      ops.push(...r.ops);
      ids.push(...r.ids);
    } else throw new Miss(`Filters don't apply to ${ts.label}.`);
  }
  return step(c.raw, `${filter === 'gaussianBlur' ? 'Blur' : filter === 'noise' ? 'Add grain to' : filter[0]!.toUpperCase() + filter.slice(1)} ${ts.label}`, ops, ids);
};

/* Video timing and audio ------------------------------------------------------ */

function clipTargets(c: Ctx, ts: TargetSet): SceneNode<'clip'>[] {
  const out: SceneNode<'clip'>[] = [];
  for (const t of ts.targets) {
    if (t.kind === 'clip') out.push(node<'clip'>(c, t.id));
    else if (t.kind === 'sequence') for (const tr of tracksOf(c.state, t.id)) if (tr.props.trackType === 'video' || tr.props.trackType === 'audio') out.push(...clipsOf(c.state, tr.id));
    else throw new Miss(`${ts.label} isn't a clip.`);
  }
  return out;
}

const videoHandler: Handler = async (c) => {
  if (!seqOf(c)) return null;
  let m: string[] | null = /^(speed up|slow down|slow)\s+(.+?)(?:\s+(?:to|by)\s+([\d.]+)\s*(x|times|%)?)?$/.exec(c.low);
  if (m) {
    const ts = targetsOf(c, m[2]!);
    const up = m[1] === 'speed up';
    const ops: Operation[] = [];
    for (const cl of clipTargets(c, ts)) {
      let speed = up ? cl.props.speed * 1.5 : cl.props.speed * 0.5;
      if (m[3]) speed = m[4] === '%' ? (Number(m[3]) / 100) * (up ? 1 + cl.props.speed : cl.props.speed) : Number(m[3]);
      if (m[3] && m[4] === '%') speed = up ? cl.props.speed * (1 + Number(m[3]) / 100) : cl.props.speed * (1 - Number(m[3]) / 100);
      ops.push(setSpeedOp(c.state, cl.id, Math.max(0.05, Math.min(16, Math.round(speed * 100) / 100))));
    }
    return step(c.raw, `${up ? 'Speed up' : 'Slow down'} ${ts.label}`, ops, targetIds(ts));
  }
  m = /^(?:make|set|play|put)\s+(.+?)\s+(?:play\s+)?(?:at\s+|to\s+)?([\d.]+)\s*x(?:\s+speed)?$/.exec(c.low) ?? /^(?:play|put|show)\s+(.+?)\s+in\s+(slow[- ]?mo(?:tion)?)$/.exec(c.low);
  if (m) {
    const ts = targetsOf(c, m[1]!);
    const speed = /slow/.test(m[2]!) ? 0.5 : Number(m[2]);
    return step(c.raw, `Play ${ts.label} at ${speed}×`, clipTargets(c, ts).map((cl) => setSpeedOp(c.state, cl.id, speed)), targetIds(ts));
  }
  m = /^reverse\s+(.+)$/.exec(c.low);
  if (m) {
    const ts = targetsOf(c, m[1]!);
    return step(c.raw, `Reverse ${ts.label}`, clipTargets(c, ts).map((cl) => setSpeedOp(c.state, cl.id, cl.props.speed, { reverse: !cl.props.reverse })), targetIds(ts));
  }
  m = /^(mute|silence|unmute)\s+(.+)$/.exec(c.low);
  if (m) {
    const mute = m[1] !== 'unmute';
    const ts = targetsOf(c, m[2]!);
    return step(c.raw, `${mute ? 'Mute' : 'Unmute'} ${ts.label}`, clipTargets(c, ts).map((cl) => ({ kind: 'update', id: cl.id, set: { volume: mute ? -60 : 0 } }) as Operation), targetIds(ts));
  }
  m = /^(?:turn|make)\s+(.+?)\s+(up|down|louder|quieter|softer)(?:\s+(?:by\s+)?(\d+)\s*db)?$/.exec(c.low) ?? /^(?:set|change)\s+(?:the\s+)?volume\s+(?:of\s+)?(.+?)\s+to\s+(-?\d+)\s*(%|db)$/.exec(c.low);
  if (m) {
    const ts = targetsOf(c, m[1]!);
    const ops: Operation[] = clipTargets(c, ts).map((cl) => {
      let v: number;
      if (m![3] === '%' || m![3] === 'db') v = m![3] === '%' ? Math.max(-60, 20 * Math.log10(Math.max(0.001, Number(m![2]) / 100))) : Number(m![2]);
      else {
        const d = m![3] ? Number(m![3]) : 6;
        v = cl.props.volume + (/up|louder/.test(m![2]!) ? d : -d);
      }
      return { kind: 'update', id: cl.id, set: { volume: Math.round(Math.max(-60, Math.min(12, v)) * 10) / 10 } };
    });
    return step(c.raw, `Volume: ${ts.label}`, ops, targetIds(ts));
  }
  m = /^(?:trim|cut|shorten|make)\s+(.+?)\s+(?:down\s+)?(?:to\s+)?([\d.]+)\s*(?:s|sec|secs|seconds?)(?:\s+long)?$/.exec(c.low);
  if (m) {
    const ts = targetsOf(c, m[1]!);
    const target = Number(m[2]);
    const ops: Operation[] = clipTargets(c, ts).map((cl) => {
      const dur = clipDuration(cl.props);
      if (cl.props.title || !cl.props.assetId) return { kind: 'update', id: cl.id, set: { out: cl.props.in + target * cl.props.speed } };
      if (target > dur && cl.props.sourceDuration && cl.props.in + target * cl.props.speed > cl.props.sourceDuration) throw new Miss(`"${cl.props.name}" is only ${cl.props.sourceDuration.toFixed(1)} s long.`);
      return { kind: 'update', id: cl.id, set: { out: Math.round((cl.props.in + target * cl.props.speed) * 1000) / 1000 } };
    });
    return step(c.raw, `Trim ${ts.label} to ${target} s`, ops, targetIds(ts));
  }
  m = rx(/^fade\s+(in|out|in and out)\s+(.+)$/, c.low) ?? rx(/^fade\s+(.+?)\s+(in|out|in and out)$/, c.low, [2, 1]) ?? rx(/^add\s+(?:a\s+)?fade[- ]?(in|out)\s+(?:to\s+)?(.+)$/, c.low);
  if (m) {
    const which = m[1]!;
    const ts = targetsOf(c, m[2]!);
    const tr = { kind: 'crossfade' as const, duration: 0.8, easing: 'ease-in-out' as const };
    const ops: Operation[] = clipTargets(c, ts).map((cl) => ({ kind: 'update', id: cl.id, set: { ...(which !== 'out' ? { transitionIn: tr } : {}), ...(which !== 'in' ? { transitionOut: tr } : {}) } }) as Operation);
    return step(c.raw, `Fade ${which} ${ts.label}`, ops, targetIds(ts));
  }
  m = /^(?:add|use|put)\s+(?:a\s+)?(crossfades?|cross-fades?|dissolves?|transitions?|dips? to black|wipes?|zooms?)(?:\s+(?:between|to)\s+(.+))?$/.exec(c.low);
  if (m) {
    const seq = seqOf(c)!;
    const kind = /dip/.test(m[1]!) ? 'dip-to-black' : /wipe/.test(m[1]!) ? 'wipe-left' : /zoom/.test(m[1]!) ? 'zoom' : 'crossfade';
    const picture = tracksOf(c.state, seq.id).filter((t) => t.props.trackType === 'video').flatMap((t) => clipsOf(c.state, t.id)).sort((a, b) => a.props.start - b.props.start);
    let pairs = picture.slice(1);
    if (m[2] && !/^(?:all|every|each|the)?\s*(?:clips?|shots?|cuts?)$/.test(m[2])) {
      const both = m[2].split(/\s+and\s+/);
      const ids = both.flatMap((p) => clipTargets(c, targetsOf(c, p)).map((cl) => cl.id));
      pairs = picture.filter((cl, i) => i > 0 && ids.includes(cl.id) && ids.includes(picture[i - 1]!.id));
      if (!pairs.length) throw new Miss('Those clips are not next to each other.');
    }
    if (!pairs.length) throw new Miss('There are no cuts between clips yet.');
    const tr = { kind, duration: 0.6, easing: 'ease-in-out' };
    return step(c.raw, `Add ${kind.replace(/-/g, ' ')} transitions`, pairs.map((cl) => ({ kind: 'update', id: cl.id, set: { transitionIn: tr } }) as Operation), pairs.map((p) => p.id));
  }
  return null;
};

/* Slides and documents --------------------------------------------------------- */

const LAYOUTS: [RegExp, SlideLayout][] = [
  [/^title(?: only| slide)?$/, 'title'],
  [/^title (?:and|&|\+) (?:body|content|text|bullets)$|^content$|^standard$/, 'title-body'],
  [/^two[- ]columns?$/, 'two-column'],
  [/^(?:full[- ]?(?:bleed )?image|image|photo|picture)$/, 'image-full'],
  [/^section(?: header)?$/, 'section'],
  [/^blank|empty$/, 'blank'],
];

const slideHandler: Handler = async (c) => {
  const deck = deckOf(c);
  if (!deck) return null;
  let m: string[] | null = /^(?:use|apply|switch to|change to|try|go with|set)\s+(?:the\s+)?(?:a\s+)?([a-z ]+?)\s+theme$/.exec(c.low) ?? /^(?:change|set|switch)\s+(?:the\s+)?theme\s+to\s+(?:the\s+)?([a-z ]+?)(?:\s+theme)?$/.exec(c.low);
  if (m) {
    const want = m[1]!.trim();
    const preset = THEME_PRESETS.find((t) => t.name.toLowerCase() === want) ?? (want === 'dark' ? THEME_PRESETS.find((t) => t.name === 'Midnight') : want === 'light' || want === 'default' ? THEME_PRESETS[0] : want === 'serif' || want === 'classic' ? THEME_PRESETS.find((t) => t.name === 'Paper') : want === 'bright' || want === 'loud' ? THEME_PRESETS.find((t) => t.name === 'Bold') : want === 'green' || want === 'nature' ? THEME_PRESETS.find((t) => t.name === 'Forest') : undefined);
    if (!preset) throw new Miss(`There is no "${want}" theme. Themes: ${THEME_PRESETS.map((t) => t.name).join(', ')}.`);
    return step(c.raw, `Theme: ${preset.name}`, [applyThemeOp(c.state, deck.id, structuredClone(preset))], [deck.id]);
  }
  m = rx(/^(?:add|use|set|give|apply)\s+(?:a\s+|an\s+)?(fade|push|wipe|zoom|no)\s+transitions?\s*(?:(?:to|on|for|between)\s+(.+))?$/, c.low) ?? rx(/^make\s+(.+?)\s+(fade|push|wipe|zoom)(?:\s+in)?$/, c.low, [2, 1]);
  if (m) {
    const kind = m[1] === 'no' ? 'none' : m[1]!;
    const phrase = m[2];
    const slides = !phrase || /^(?:all|every|each)\b|^(?:the\s+)?(?:deck|slides|presentation)$/.test(phrase) ? deckSlides(c.state, deck.id) : targetsOf(c, phrase).targets.filter((t) => t.kind === 'slide').map((t) => node<'slide'>(c, (t as { id: string }).id));
    if (!slides.length) throw new Miss('Transitions go on slides, for example "add fade transitions to all slides".');
    return step(c.raw, `${kind === 'none' ? 'Remove' : `${kind[0]!.toUpperCase()}${kind.slice(1)}`} transitions`, slides.map((s) => ({ kind: 'update', id: s.id, set: { transition: { ...s.props.transition, kind, duration: s.props.transition.duration || 0.5 } } }) as Operation), slides.map((s) => s.id));
  }
  m = rx(/^(?:use|apply|switch to|change to)\s+(?:the\s+|a\s+)?(.+?)\s+layout(?:\s+(?:for|on)\s+(.+))?$/, c.low) ?? rx(/^(?:change|set)\s+(?:the\s+)?layout(?:\s+of\s+(.+?))?\s+to\s+(?:the\s+)?(.+?)(?:\s+layout)?$/, c.low, [2, 1]);
  if (m) {
    const layout = LAYOUTS.find(([re]) => re.test(m![1]!.trim()))?.[1];
    if (!layout) throw new Miss(`Layouts: title, title and body, two columns, full image, section, blank.`);
    const slides = m[2] ? targetsOf(c, m[2]).targets.filter((t) => t.kind === 'slide').map((t) => (t as { id: string }).id) : [currentSlide(c)!.id];
    return step(c.raw, `Layout: ${layout}`, slides.map((id) => applyLayoutOps(c.state, id, layout)), slides);
  }
  return null;
};

const BLOCK_KINDS: [RegExp, { blockType: BlockType; level?: number }][] = [
  [/^(?:a\s+)?(?:title|main heading|h1|heading 1)$/, { blockType: 'heading', level: 1 }],
  [/^(?:a\s+)?(?:heading|header|h2|heading 2|section heading)$/, { blockType: 'heading', level: 2 }],
  [/^(?:a\s+)?(?:subheading|sub-heading|h3|heading 3)$/, { blockType: 'heading', level: 3 }],
  [/^(?:a\s+|normal\s+)?(?:paragraph|body text|normal text|plain text|text)$/, { blockType: 'paragraph' }],
  [/^(?:a\s+)?(?:bullet(?:ed)? list|bullets?|list|bullet points?)$/, { blockType: 'bullet', level: 0 }],
  [/^(?:a\s+)?(?:numbered list|ordered list|numbers|steps)$/, { blockType: 'numbered', level: 0 }],
  [/^(?:a\s+)?(?:quote|block ?quote|callout)$/, { blockType: 'quote' }],
  [/^(?:a\s+)?(?:checklist|to-?do(?: list)?|tasks?)$/, { blockType: 'todo', level: 0 }],
  [/^(?:a\s+)?code(?: block)?$/, { blockType: 'code' }],
];

const documentHandler: Handler = async (c) => {
  const doc = c.state.nodes[c.env.documentId];
  if (doc?.type !== 'document') return null;
  const m = /^(?:turn|convert|change|make)\s+(.+?)\s+(?:in)?to\s+(?:an?\s+)?(.+)$/.exec(c.low) ?? /^(?:make)\s+(.+?)\s+(?:an?\s+)(.+)$/.exec(c.low);
  if (!m) return null;
  const kind = BLOCK_KINDS.find(([re]) => re.test(m[2]!.trim()));
  if (!kind) return null;
  const ts = targetsOf(c, m[1]!);
  const blocks = ts.targets.filter((t) => t.kind === 'block').map((t) => node<'block'>(c, (t as { id: string }).id));
  if (!blocks.length) throw new Miss(`Point at a paragraph, for example "turn the second paragraph into a quote".`);
  const ops: Operation[] = blocks.map((b) => ({ kind: 'update', id: b.id, set: { blockType: kind[1].blockType, ...(kind[1].level !== undefined ? { level: kind[1].level } : {}) } }));
  return step(c.raw, `Turn ${ts.label} into ${m[2]}`, ops, blocks.map((b) => b.id));
};

const HANDLERS: Handler[] = [slideHandler, documentHandler, addHandler, videoHandler, opacityHandler, visibilityHandler, renameHandler, duplicateHandler, deleteHandler, moveHandler, sizeHandler, fontHandler, filterHandler, textHandler, colorHandler, toneHandler];

/** Turn a command into reviewable steps. Each step sees the project as the previous steps left it. */
export async function planCommand(text: string, state0: ProjectState, env: CommandEnv): Promise<CommandPlan> {
  const plan: CommandPlan = { steps: [], unmatched: [] };
  let state = state0;
  let last: TargetSet | null = env.selection.length ? null : null;
  const pixels: Ctx['pixels'] = {};
  const queue = splitClauses(text);
  while (queue.length) {
    const rawClause = queue.shift()!;
    const raw = normalize(rawClause);
    if (!raw) continue;
    const attempt = async (clause: string): Promise<{ result: CommandStep | null; reason: string | null }> => {
      const c: Ctx = { env, state, raw: clause, low: clause.toLowerCase(), pixels, scope: { state, documentId: env.documentId, selection: env.selection, slideId: env.slideId, time: env.time, last } };
      for (const h of HANDLERS) {
        try {
          const r = await h(c);
          if (r) return { result: r, reason: null };
        } catch (e) {
          return { result: null, reason: e instanceof Error ? e.message : String(e) };
        }
      }
      return { result: null, reason: null };
    };
    let { result, reason } = await attempt(raw);
    if (!result && / and /i.test(raw)) {
      // "remove the background and tidy up the edges": the second verb was not one we split on.
      const parts = raw.split(/ and /i);
      for (let i = 1; i < parts.length && !result; i++) {
        const left = parts.slice(0, i).join(' and ');
        const tried = await attempt(left);
        if (tried.result) {
          result = tried.result;
          reason = null;
          queue.unshift(parts.slice(i).join(' and '));
        }
      }
    }
    if (!result) {
      plan.unmatched.push({ clause: rawClause.trim(), reason: reason ?? `I didn't understand "${rawClause.trim()}".` });
      continue;
    }
    if (!result.ops.length) {
      plan.unmatched.push({ clause: rawClause.trim(), reason: 'Nothing to change.' });
      continue;
    }
    try {
      state = applyOp(state, { kind: 'batch', ops: result.ops }).state;
    } catch (e) {
      plan.unmatched.push({ clause: rawClause.trim(), reason: `That change doesn't apply: ${(e as Error).message}` });
      continue;
    }
    plan.steps.push(result);
    // Pixel results depend on the state; later clauses recompute them.
    delete pixels.composite;
    const ids = result.nodeIds.filter((id) => state.nodes[id]);
    if (ids.length) last = { targets: ids.map((id) => targetFor(state, id)).filter((t): t is Target => !!t), label: 'it' };
  }
  return plan;
}

function targetFor(state: ProjectState, id: string): Target | null {
  const n = state.nodes[id];
  if (!n) return null;
  switch (n.type) {
    case 'layer':
      return { kind: 'layer', id };
    case 'clip':
      return { kind: 'clip', id };
    case 'animLayer':
      return { kind: 'animLayer', id };
    case 'slideElement':
      return { kind: 'element', id };
    case 'slide':
      return { kind: 'slide', id };
    case 'block':
      return { kind: 'block', id };
    case 'deck':
      return { kind: 'deck', id };
    case 'document':
      return { kind: 'document', id };
    case 'canvas':
      return { kind: 'canvas', id };
    case 'sequence':
      return { kind: 'sequence', id };
    default:
      return null;
  }
}

/** Examples shown in the command bar and in error hints, per editor. */
export const COMMAND_EXAMPLES: Record<string, string[]> = {
  image: ['Make the sky warmer and move the title to the lower third', 'Remove the background', 'Make the background navy', 'Add a title "Spring sale"', 'Blur the photo a little'],
  video: ['Make clip 2 warmer', 'Add a title "Coming soon" and move it to the lower third', 'Add crossfades between all clips', 'Turn the music down', 'Speed up the first clip to 2x'],
  animation: ['Make the ball layer bigger', 'Move the logo to the center'],
  slides: ['Use the Midnight theme', 'Add a slide titled "Q3 results"', 'Make the title on slide 2 blue', 'Add fade transitions to all slides'],
  document: ['Make the headings blue', 'Turn the second paragraph into a quote', 'Add a heading "Next steps"', 'Use Georgia for the body text'],
};

