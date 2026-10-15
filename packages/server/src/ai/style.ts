import { clipsOf, deckSlides, layerProps, makeNode, newId, normalizeColor, rgbToHsl, slideElements, toHex, tracksOf, walk, applyThemeOp, type ClipEffect, type Easing, type Operation, type ProjectState, type SceneNode, type StyleSheet, type ThemeTokens, type Transition } from '@omnix/core';
import { COLOR_GRADE_DEFAULTS, dominantColors, formatCubeLut, grainLevel, labStats, styleLut, type Raster } from '@omnix/imaging';
import { renderSlide } from '@omnix/render';
import type { Services } from '../services.js';
import { canvasIdOf, canvasToRaster, compositeRaster, decodeRaster, layerAlphaMaskAsset, layerRaster } from '../render/pixels.js';
import { extractFrame } from '../util/media.js';

/**
 * Style reference (feature 47): take a reference image, clip, slideshow or document and apply its
 * color, tone, texture, typography or motion feel to a target in any editor. Everything lands as
 * ordinary, editable settings: a LUT adjustment layer or color grade (color, tone), a grain filter
 * (texture), theme and text styles (color, typography), and easing and timing (motion).
 */

export type StyleAspect = 'color' | 'tone' | 'texture' | 'typography' | 'motion';
export const STYLE_ASPECTS: StyleAspect[] = ['color', 'tone', 'texture', 'typography', 'motion'];

export interface MotionProfile {
  easing: Easing;
  /** Typical transition length in seconds, and the transition kind used most. */
  transitionDuration: number | null;
  videoTransition: Transition['kind'] | null;
  slideTransition: 'fade' | 'push' | 'wipe' | 'zoom' | 'none' | null;
  /** Typical element animation length (slides). */
  animationDuration: number | null;
}

export interface StyleReference {
  label: string;
  raster: Raster | null;
  theme: ThemeTokens | null;
  docStyles: StyleSheet | null;
  motion: MotionProfile | null;
}

const easingKey = (e: Easing) => (typeof e === 'string' ? e : `bezier(${e.bezier.join(',')})`);

function mostCommon<T>(items: T[], key: (x: T) => string): T | null {
  const counts = new Map<string, { item: T; n: number }>();
  for (const it of items) {
    const k = key(it);
    const c = counts.get(k);
    if (c) c.n++;
    else counts.set(k, { item: it, n: 1 });
  }
  let best: { item: T; n: number } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best?.item ?? null;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/** The motion feel of a sequence (keyframe easing, transitions) or deck (slide transitions, animations). */
export function motionProfile(state: ProjectState, nodeId: string): MotionProfile | null {
  const n = state.nodes[nodeId];
  if (!n) return null;
  const easings: Easing[] = [];
  const durations: number[] = [];
  const kinds: Transition['kind'][] = [];
  const slideKinds: string[] = [];
  const animDur: number[] = [];
  walk(state, nodeId, (x) => {
    const p = x.props as Record<string, unknown>;
    const kfs = p.keyframes as Record<string, { easing: Easing }[] | undefined> | undefined;
    if (kfs) for (const list of Object.values(kfs)) for (const k of list ?? []) easings.push(k.easing);
    if (x.type === 'clip') {
      for (const t of [p.transitionIn, p.transitionOut] as (Transition | null)[]) {
        if (!t) continue;
        kinds.push(t.kind);
        durations.push(t.duration);
        easings.push(t.easing);
      }
    }
    if (x.type === 'animLayer') {
      const al = x as SceneNode<'animLayer'>;
      if (al.props.motionPath) easings.push(al.props.motionPath.easing);
      for (const pose of al.props.rig?.poses ?? []) easings.push(pose.easing);
    }
    if (x.type === 'slide') {
      const t = (x as SceneNode<'slide'>).props.transition;
      slideKinds.push(t.kind);
      if (t.kind !== 'none') durations.push(t.duration);
      easings.push(t.easing);
    }
    if (x.type === 'slideElement') for (const a of (x as SceneNode<'slideElement'>).props.animations) {
      easings.push(a.easing);
      animDur.push(a.duration);
    }
  });
  if (!easings.length && !durations.length && !slideKinds.length) return null;
  return {
    easing: mostCommon(easings.filter((e) => e !== 'linear' && e !== 'hold'), easingKey) ?? mostCommon(easings, easingKey) ?? 'ease-in-out',
    transitionDuration: median(durations),
    videoTransition: mostCommon(kinds, String),
    slideTransition: (mostCommon(slideKinds.filter((k) => k !== 'none'), String) as MotionProfile['slideTransition']) ?? null,
    animationDuration: median(animDur),
  };
}

async function limited(r: Raster, max = 1024): Promise<Raster> {
  if (Math.max(r.width, r.height) <= max) return r;
  const f = max / Math.max(r.width, r.height);
  const w = Math.max(1, Math.round(r.width * f));
  const h = Math.max(1, Math.round(r.height * f));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const si = (Math.min(r.height - 1, Math.floor(y / f)) * r.width + Math.min(r.width - 1, Math.floor(x / f))) * 4;
      out.set(r.data.subarray(si, si + 4), (y * w + x) * 4);
    }
  return { width: w, height: h, data: out };
}

async function videoFrame(services: Services, assetId: string, time: number): Promise<Raster | null> {
  try {
    const png = await extractFrame(services.config.ffmpegPath, await services.blobs.localPath(assetId), Math.max(0, time), 1024);
    return decodeRaster(png);
  } catch {
    return null;
  }
}

/** Read whatever a reference offers: pixels, a theme, text styles, a motion feel. */
export async function loadReference(services: Services, state: ProjectState, ref: { assetId?: string; nodeId?: string }): Promise<StyleReference> {
  if (ref.assetId) {
    const a = await services.assets.get(ref.assetId);
    if (!a) throw new Error('Reference asset not found.');
    let raster: Raster | null = null;
    if (a.kind === 'image') {
      const data = await services.blobs.get(a.id);
      if (data) raster = await decodeRaster(data);
    } else if (a.kind === 'video') raster = await videoFrame(services, a.id, (a.duration ?? 0) / 2);
    else throw new Error('Use an image or a video as a style reference.');
    return { label: a.name, raster: raster && (await limited(raster)), theme: null, docStyles: null, motion: null };
  }
  const n = ref.nodeId ? state.nodes[ref.nodeId] : undefined;
  if (!n) throw new Error('Reference not found in this project.');
  const name = String((n.props as { name?: string }).name ?? n.type);
  const host = services.renderHost();
  switch (n.type) {
    case 'canvas':
      return { label: name, raster: await limited(await compositeRaster(host, state, n.id)), theme: null, docStyles: null, motion: null };
    case 'layer': {
      const canvasId = canvasIdOf(state, n.id)!;
      return { label: name, raster: await limited(await layerRaster(host, state, canvasId, n.id)), theme: null, docStyles: null, motion: null };
    }
    case 'clip': {
      const c = n as SceneNode<'clip'>;
      const raster = c.props.assetId ? await videoFrame(services, c.props.assetId, (c.props.in + c.props.out) / 2) : null;
      return { label: name, raster: raster && (await limited(raster)), theme: null, docStyles: null, motion: motionProfile(state, n.id) };
    }
    case 'sequence': {
      const seq = n as SceneNode<'sequence'>;
      const clip = tracksOf(state, seq.id).flatMap((t) => (t.props.trackType === 'video' ? clipsOf(state, t.id) : [])).find((c) => c.props.assetId);
      const raster = clip?.props.assetId ? await videoFrame(services, clip.props.assetId, (clip.props.in + clip.props.out) / 2) : null;
      return { label: name, raster: raster && (await limited(raster)), theme: null, docStyles: null, motion: motionProfile(state, n.id) };
    }
    case 'deck': {
      const deck = n as SceneNode<'deck'>;
      const first = deckSlides(state, deck.id)[0];
      let raster: Raster | null = null;
      if (first) {
        await host.prepare(state, first.id);
        raster = canvasToRaster(renderSlide(host, state, first.id, { scale: Math.min(1, 960 / deck.props.width) }));
      }
      return { label: name, raster, theme: deck.props.theme, docStyles: null, motion: motionProfile(state, deck.id) };
    }
    case 'slide': {
      const deck = state.nodes[n.parentId!] as SceneNode<'deck'>;
      await host.prepare(state, n.id);
      return { label: name, raster: canvasToRaster(renderSlide(host, state, n.id, { scale: Math.min(1, 960 / deck.props.width) })), theme: deck.props.theme, docStyles: null, motion: motionProfile(state, n.id) };
    }
    case 'document':
      return { label: name, raster: null, theme: null, docStyles: (n as SceneNode<'document'>).props.styles, motion: null };
    default:
      throw new Error('Use an image, layer, clip, video, animation, slideshow, slide or document as a reference.');
  }
}

/* Palettes ------------------------------------------------------------------------- */

const hex = (c: [number, number, number]) => toHex({ r: c[0], g: c[1], b: c[2], a: 1 });
const lum = (c: [number, number, number]) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
const sat = (c: [number, number, number]) => rgbToHsl(c[0], c[1], c[2])[1];

/** A slide theme's colors from an image: background, readable text, and the boldest colors as accents. */
export function themeColorsFrom(r: Raster): ThemeTokens['colors'] {
  const pal = dominantColors(r, 6).map((x) => x.color);
  const bg = pal[0] ?? [255, 255, 255];
  const dark = lum(bg) < 0.45;
  const text: [number, number, number] = dark ? [245, 245, 242] : [28, 30, 34];
  const accents = pal.slice(1).filter((c) => Math.abs(lum(c) - lum(bg)) > 0.12).sort((a, b) => sat(b) - sat(a));
  const accent = accents[0] ?? (dark ? [124, 156, 255] : [29, 63, 214]);
  const accent2 = accents[1] ?? accent;
  const shift = (c: [number, number, number], k: number): [number, number, number] => c.map((v) => Math.max(0, Math.min(255, Math.round(v + (dark ? 1 : -1) * k)))) as [number, number, number];
  const muted: [number, number, number] = text.map((v, i) => Math.round(v * 0.55 + bg[i]! * 0.45)) as [number, number, number];
  return { background: hex(bg), surface: hex(shift(bg, 14)), text: hex(text), muted: hex(muted), accent: hex(accent as [number, number, number]), accent2: hex(accent2 as [number, number, number]) };
}

/* Applying a reference --------------------------------------------------------------- */

export interface StyleMatchResult {
  ops: Operation[];
  /** What was matched, in plain words. */
  applied: string[];
  /** Aspects that did not apply to this target/reference pair, with why. */
  skipped: string[];
}

async function uploadLut(services: Services, target: Raster, ref: Raster, aspects: Set<StyleAspect>, label: string, projectId: string, ownerId: string): Promise<string> {
  const lut = styleLut(labStats(target), labStats(ref), { color: aspects.has('color'), tone: aspects.has('tone'), strength: 1 });
  const text = formatCubeLut({ ...lut, title: `Look from ${label}` });
  const a = await services.assets.ingestBuffer(Buffer.from(text), { name: `Look from ${label}.cube`.slice(0, 120), ownerId, projectId, mimeHint: 'application/x-cube-lut', tags: ['look', 'style reference'], source: { kind: 'generated', projectId } });
  return a.id;
}

function grainAmount(target: Raster, ref: Raster, strength: number): number | null {
  const want = grainLevel(ref);
  const have = grainLevel(target);
  if (want <= have + 0.5) return null;
  return Math.round(Math.min(60, (want - have) * 2.2 * strength) * 10) / 10;
}

function gradeEffect(lutId: string | null, strength: number): ClipEffect {
  return { id: newId('fx'), effect: 'colorGrade', params: { ...COLOR_GRADE_DEFAULTS, intensity: Math.round(strength * 100) / 100 }, enabled: true, assetId: lutId };
}

export async function styleMatch(
  services: Services,
  state: ProjectState,
  input: { targetId: string; reference: StyleReference; aspects: StyleAspect[]; strength: number; projectId: string; ownerId: string },
): Promise<StyleMatchResult> {
  const target = state.nodes[input.targetId];
  if (!target) throw new Error('Target not found.');
  const ref = input.reference;
  const aspects = new Set(input.aspects.length ? input.aspects : STYLE_ASPECTS);
  const strength = Math.max(0, Math.min(1, input.strength));
  const ops: Operation[] = [];
  const applied: string[] = [];
  const skipped: string[] = [];
  const wantsLook = aspects.has('color') || aspects.has('tone');
  const host = services.renderHost();
  const lookName = `Look: ${ref.label}`.slice(0, 80);

  const needRaster = (what: string) => {
    if (!ref.raster) skipped.push(`${what}: the reference has no image to read colors from`);
    return !!ref.raster;
  };

  switch (target.type) {
    case 'canvas':
    case 'layer': {
      const canvasId = target.type === 'canvas' ? target.id : canvasIdOf(state, target.id)!;
      const canvas = state.nodes[canvasId] as SceneNode<'canvas'>;
      const tr = target.type === 'canvas' ? await compositeRaster(host, state, canvasId) : await layerRaster(host, state, canvasId, target.id);
      if (wantsLook && needRaster('Color and tone')) {
        const lutId = await uploadLut(services, await limited(tr), ref.raster!, aspects, ref.label, input.projectId, input.ownerId);
        const mask = target.type === 'layer' ? await layerAlphaMaskAsset(services, state, canvasId, target.id, input.projectId, input.ownerId) : null;
        const layer = makeNode('layer', layerProps('adjustment', { name: lookName, adjustment: { kind: 'lut', assetId: lutId, intensity: strength }, ...(mask ? { mask: { source: { kind: 'mask', assetId: mask }, inverted: false, enabled: true } } : {}) }));
        const parent = target.type === 'layer' ? state.nodes[target.parentId!]! : canvas;
        const index = target.type === 'layer' ? parent.children.indexOf(target.id) + 1 : parent.children.length;
        ops.push({ kind: 'create', parentId: parent.id, index, nodes: [layer] });
        applied.push('color and tone (a look adjustment layer you can tune or hide)');
      }
      if (aspects.has('texture') && ref.raster) {
        const amount = grainAmount(tr, ref.raster, strength);
        const photo = target.type === 'layer' ? (target as SceneNode<'layer'>) : [...canvas.children].reverse().map((id) => state.nodes[id] as SceneNode<'layer'>).find((l) => l.props.layerType === 'raster');
        if (amount && photo && photo.props.layerType === 'raster') {
          ops.push({ kind: 'listInsert', id: photo.id, prop: 'filters', items: [{ id: newId('flt'), filter: 'noise', params: { amount, seed: 7 }, enabled: true, opacity: 1 }] });
          applied.push('texture (film grain)');
        } else skipped.push('Texture: the target is already as textured as the reference');
      }
      if (aspects.has('typography')) {
        const fonts = ref.theme?.fonts ?? (ref.docStyles ? { heading: ref.docStyles.h1?.fontFamily ?? ref.docStyles.title?.fontFamily, body: ref.docStyles.body?.fontFamily } : null);
        const texts: SceneNode<'layer'>[] = [];
        walk(state, canvasId, (x) => {
          if (x.type === 'layer' && (x as SceneNode<'layer'>).props.layerType === 'text') texts.push(x as SceneNode<'layer'>);
        });
        if (fonts?.heading && texts.length) {
          const biggest = Math.max(...texts.map((t) => t.props.fontSize ?? 0));
          for (const t of texts) ops.push({ kind: 'update', id: t.id, set: { fontFamily: (t.props.fontSize ?? 0) >= biggest * 0.8 ? fonts.heading : (fonts.body ?? fonts.heading) } });
          applied.push('typography (fonts on text layers)');
        } else if (aspects.size === 1 || input.aspects.includes('typography')) skipped.push('Typography: use a slideshow or document as the reference for fonts');
      }
      if (aspects.has('motion') && input.aspects.includes('motion')) skipped.push('Motion: still images have no motion');
      break;
    }
    case 'clip':
    case 'sequence': {
      const seq = (target.type === 'sequence' ? target : (() => {
        let cur: SceneNode | undefined = target;
        while (cur && cur.type !== 'sequence') cur = cur.parentId ? state.nodes[cur.parentId] : undefined;
        return cur;
      })()) as SceneNode<'sequence'>;
      const isAnimation = seq.props.purpose === 'animation';
      if (wantsLook && !isAnimation && needRaster('Color and tone')) {
        const clip = target.type === 'clip' ? (target as SceneNode<'clip'>) : tracksOf(state, seq.id).flatMap((t) => (t.props.trackType === 'video' ? clipsOf(state, t.id) : [])).find((c) => c.props.assetId);
        const frame = clip?.props.assetId ? await videoFrame(services, clip.props.assetId, (clip.props.in + clip.props.out) / 2) : null;
        if (frame) {
          const lutId = await uploadLut(services, await limited(frame), ref.raster!, aspects, ref.label, input.projectId, input.ownerId);
          if (target.type === 'clip') ops.push({ kind: 'listInsert', id: target.id, prop: 'effects', items: [gradeEffect(lutId, strength)] });
          else {
            let track = tracksOf(state, seq.id).find((t) => t.props.trackType === 'effect');
            if (!track) {
              track = makeNode('track', { name: 'Effects', trackType: 'effect' });
              ops.push({ kind: 'create', parentId: seq.id, index: 0, nodes: [track] });
            }
            const grade = makeNode('clip', { name: lookName, start: 0, in: 0, out: seq.props.duration, effects: [gradeEffect(lutId, strength)] });
            ops.push({ kind: 'create', parentId: track.id, nodes: [grade] });
          }
          applied.push('color and tone (a color grade with the reference look)');
          if (aspects.has('texture')) {
            const amount = grainAmount(frame, ref.raster!, strength);
            if (amount && target.type === 'clip') {
              ops.push({ kind: 'listInsert', id: target.id, prop: 'effects', items: [{ id: newId('fx'), effect: 'noise', params: { amount, seed: 7 }, enabled: true }] });
              applied.push('texture (grain)');
            }
          }
        } else skipped.push('Color and tone: no video frame to compare against');
      }
      if (aspects.has('motion')) {
        if (!ref.motion) {
          if (input.aspects.includes('motion')) skipped.push('Motion: use an animation, video or slideshow as the reference for motion');
        } else {
          const m = ref.motion;
          let n = 0;
          walk(state, target.id, (x) => {
            const p = x.props as Record<string, unknown>;
            const kfs = p.keyframes as Record<string, { easing: Easing }[] | undefined> | undefined;
            if (kfs && Object.values(kfs).some((l) => l?.length)) {
              const next = Object.fromEntries(Object.entries(kfs).map(([k, list]) => [k, (list ?? []).map((kf) => ({ ...kf, easing: m.easing }))]));
              ops.push({ kind: 'update', id: x.id, set: { keyframes: next } });
              n++;
            }
            if (x.type === 'animLayer') {
              const al = x as SceneNode<'animLayer'>;
              if (al.props.motionPath) ops.push({ kind: 'update', id: al.id, set: { motionPath: { ...al.props.motionPath, easing: m.easing } } });
              if (al.props.rig?.poses.length) ops.push({ kind: 'update', id: al.id, set: { rig: { ...al.props.rig, poses: al.props.rig.poses.map((q) => ({ ...q, easing: m.easing })) } } });
            }
            if (x.type === 'clip' && (m.videoTransition || m.transitionDuration)) {
              const c = x as SceneNode<'clip'>;
              const fix = (t: Transition | null) => (t ? { ...t, kind: m.videoTransition ?? t.kind, duration: m.transitionDuration ?? t.duration, easing: m.easing } : t);
              if (c.props.transitionIn || c.props.transitionOut) {
                ops.push({ kind: 'update', id: c.id, set: { transitionIn: fix(c.props.transitionIn), transitionOut: fix(c.props.transitionOut) } });
                n++;
              }
            }
          });
          if (n) applied.push(`motion (easing${m.videoTransition ? ` and ${m.videoTransition} transitions` : ''} from the reference)`);
          else skipped.push('Motion: nothing in the target is animated yet');
        }
      }
      break;
    }
    case 'deck':
    case 'slide': {
      const deck = (target.type === 'deck' ? target : state.nodes[target.parentId!]) as SceneNode<'deck'>;
      const slides = target.type === 'deck' ? deckSlides(state, deck.id) : [target as SceneNode<'slide'>];
      let theme: ThemeTokens = structuredClone(deck.props.theme);
      let themeChanged = false;
      if (wantsLook) {
        if (ref.theme && target.type === 'deck') {
          theme = { ...theme, colors: { ...ref.theme.colors } };
          themeChanged = true;
          applied.push('colors (the reference theme)');
        } else if (ref.raster) {
          const colors = themeColorsFrom(ref.raster);
          if (target.type === 'deck') {
            theme = { ...theme, colors };
            themeChanged = true;
            applied.push('colors (a theme built from the reference palette)');
          } else {
            ops.push({ kind: 'update', id: target.id, set: { background: colors.background } });
            for (const e of slideElements(state, target.id)) if (e.props.elementType === 'text') ops.push({ kind: 'update', id: e.id, set: { color: e.props.role === 'title' ? colors.accent : colors.text } });
            applied.push('colors (slide background and text from the reference palette)');
          }
        } else skipped.push('Color: the reference has no colors to read');
      }
      if (aspects.has('typography')) {
        const fonts = ref.theme?.fonts ?? (ref.docStyles ? { heading: ref.docStyles.h1?.fontFamily ?? theme.fonts.heading, body: ref.docStyles.body?.fontFamily ?? theme.fonts.body, mono: theme.fonts.mono } : null);
        if (fonts) {
          theme = { ...theme, fonts: { ...theme.fonts, ...fonts } };
          themeChanged = true;
          applied.push('typography (heading and body fonts)');
        } else if (input.aspects.includes('typography')) skipped.push('Typography: use a slideshow or document as the reference for fonts');
      }
      if (themeChanged) ops.push(applyThemeOp(state, deck.id, theme));
      if (aspects.has('motion')) {
        const m = ref.motion;
        if (!m) {
          if (input.aspects.includes('motion')) skipped.push('Motion: use an animation, video or slideshow as the reference for motion');
        } else {
          for (const s of slides) {
            const kind = m.slideTransition ?? (m.videoTransition ? (m.videoTransition === 'crossfade' || m.videoTransition === 'dip-to-black' ? 'fade' : m.videoTransition.startsWith('wipe') ? 'wipe' : m.videoTransition === 'zoom' ? 'zoom' : 'push') : s.props.transition.kind);
            ops.push({ kind: 'update', id: s.id, set: { transition: { kind, duration: m.transitionDuration ?? s.props.transition.duration, easing: m.easing } } });
            for (const e of slideElements(state, s.id))
              if (e.props.animations.length) ops.push({ kind: 'update', id: e.id, set: { animations: e.props.animations.map((a) => ({ ...a, easing: m.easing, duration: m.animationDuration ?? a.duration })) } });
          }
          applied.push('motion (transitions, easing and animation timing)');
        }
      }
      if (aspects.has('texture') && input.aspects.includes('texture')) skipped.push('Texture: slides have no grain setting');
      break;
    }
    case 'document': {
      const doc = target as SceneNode<'document'>;
      const styles: StyleSheet = structuredClone(doc.props.styles);
      let changed = false;
      if (aspects.has('typography') || wantsLook) {
        if (ref.docStyles) {
          for (const [k, st] of Object.entries(ref.docStyles)) {
            if (!styles[k]) continue;
            styles[k] = { ...styles[k]!, ...(aspects.has('typography') ? { fontFamily: st.fontFamily, fontWeight: st.fontWeight, fontSize: st.fontSize, lineHeight: st.lineHeight } : {}), ...(wantsLook ? { color: st.color } : {}) };
          }
          changed = true;
          applied.push(aspects.has('typography') ? 'typography and colors (text styles)' : 'colors (text styles)');
        } else if (ref.theme) {
          for (const k of ['title', 'h1', 'h2', 'h3']) if (styles[k]) styles[k] = { ...styles[k]!, ...(aspects.has('typography') ? { fontFamily: ref.theme.fonts.heading } : {}), ...(wantsLook ? { color: normalizeColor(ref.theme.colors.accent) } : {}) };
          if (styles.body && aspects.has('typography')) styles.body = { ...styles.body, fontFamily: ref.theme.fonts.body };
          changed = true;
          applied.push('typography and colors (from the slideshow theme)');
        } else if (ref.raster && wantsLook) {
          const colors = themeColorsFrom(ref.raster);
          const accent = lum(dominantColors(ref.raster, 1)[0]?.color ?? [255, 255, 255]) < 0.45 ? colors.accent2 : colors.accent;
          for (const k of ['title', 'h1', 'h2', 'h3']) if (styles[k]) styles[k] = { ...styles[k]!, color: accent };
          changed = true;
          applied.push('colors (headings take the reference accent color)');
        }
      }
      if (changed) ops.push({ kind: 'update', id: doc.id, set: { styles } });
      if (aspects.has('motion') && input.aspects.includes('motion')) skipped.push('Motion: documents have no motion');
      if (aspects.has('texture') && input.aspects.includes('texture')) skipped.push('Texture: documents have no texture');
      break;
    }
    default:
      throw new Error('Match style works on an image, layer, clip, video, animation, slideshow, slide or document.');
  }
  return { ops, applied, skipped };
}
