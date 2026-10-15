import { clipsOf, deckSlides, documentBlocks, inlineToPlain, slideElements, tracksOf, walk, type ProjectState, type SceneNode } from '@omnix/core';
import { ordinalFrom } from './vocab.js';

/** What a phrase in a command refers to. */
export type Target =
  | { kind: 'layer'; id: string }
  | { kind: 'canvas'; id: string }
  | { kind: 'region'; canvasId: string; region: 'sky' | 'subject' | 'background' }
  | { kind: 'clip'; id: string }
  | { kind: 'animLayer'; id: string }
  | { kind: 'sequence'; id: string }
  | { kind: 'element'; id: string }
  | { kind: 'slide'; id: string }
  | { kind: 'slideBackground'; id: string }
  | { kind: 'deck'; id: string }
  | { kind: 'block'; id: string }
  | { kind: 'textStyle'; documentId: string; styles: string[] }
  | { kind: 'document'; id: string };

export interface TargetSet {
  targets: Target[];
  /** Short human name used in step labels ("the title", "clip 2"). */
  label: string;
}

export interface TargetScope {
  state: ProjectState;
  documentId: string;
  selection: string[];
  slideId: string | null;
  time: number | null;
  /** What the previous step changed or created ("it", "them"). */
  last: TargetSet | null;
}

const ARTICLE = /^(?:the|this|that|these|those|my|our|a|an)\s+/;

function clean(phrase: string): { text: string; all: boolean } {
  let p = phrase.trim().toLowerCase().replace(/[“”"]/g, '').replace(/\s+/g, ' ');
  let all = false;
  const a = /^(?:all(?: of)?(?: the)?|every|each|both(?: of)?(?: the)?)\s+/.exec(p);
  if (a) {
    all = true;
    p = p.slice(a[0].length);
  }
  p = p.replace(ARTICLE, '');
  return { text: p, all };
}

const set = (targets: Target[], label: string): TargetSet | null => (targets.length ? { targets, label } : null);

/** Score how well a node name matches the phrase (0 = no match). */
function nameScore(name: string, phrase: string): number {
  const n = name.toLowerCase().trim();
  if (!n || !phrase) return 0;
  if (n === phrase) return 3;
  if (n.startsWith(phrase) || n.endsWith(phrase)) return 2;
  const words = phrase.split(' ').filter((w) => w.length > 2);
  if (words.length && words.every((w) => n.includes(w))) return 1;
  return 0;
}

function best<T>(items: T[], score: (x: T) => number): T[] {
  let top = 0;
  for (const it of items) top = Math.max(top, score(it));
  return top ? items.filter((it) => score(it) === top) : [];
}

function pick<T>(items: T[], ord: number | 'last'): T | undefined {
  return ord === 'last' ? items[items.length - 1] : items[ord - 1];
}

/** Split "the title on slide 3" into the element phrase and a slide scope. */
function slideScope(phrase: string): { phrase: string; slide: number | 'last' | 'this' | null } {
  const m = /^(.*?)\s+(?:on|of|in|from)\s+(?:the\s+)?(?:slide\s+(\d+)|(\w+)\s+slide|(?:this|current) slide)$/.exec(phrase);
  if (!m) return { phrase, slide: null };
  if (m[2]) return { phrase: m[1]!, slide: Number(m[2]) };
  if (m[3]) {
    const o = ordinalFrom(m[3]);
    if (o) return { phrase: m[1]!, slide: o };
  }
  return { phrase: m[1]!, slide: 'this' };
}

export function resolveTargets(phrase: string, scope: TargetScope): TargetSet | null {
  const { text, all } = clean(phrase);
  if (/^(?:it|them|that|those|these|this one|the same)$/.test(text) && scope.last) return scope.last;
  const doc = scope.state.nodes[scope.documentId];
  if (!doc) return null;
  switch (doc.type) {
    case 'canvas':
      return imageTargets(text, all, doc as SceneNode<'canvas'>, scope);
    case 'sequence':
      return (doc as SceneNode<'sequence'>).props.purpose === 'animation' ? animationTargets(text, all, doc as SceneNode<'sequence'>, scope) : videoTargets(text, all, doc as SceneNode<'sequence'>, scope);
    case 'deck':
      return slideTargets(text, all, doc as SceneNode<'deck'>, scope);
    case 'document':
      return documentTargets(text, all, doc as SceneNode<'document'>, scope);
    default:
      return null;
  }
}

/* Image ------------------------------------------------------------- */

export function canvasLayers(state: ProjectState, canvasId: string): SceneNode<'layer'>[] {
  const out: SceneNode<'layer'>[] = [];
  walk(state, canvasId, (n) => {
    if (n.type === 'layer') out.push(n as SceneNode<'layer'>);
  });
  return out;
}

function imageTargets(text: string, all: boolean, canvas: SceneNode<'canvas'>, scope: TargetScope): TargetSet | null {
  const layers = canvasLayers(scope.state, canvas.id);
  const sel = layers.filter((l) => scope.selection.includes(l.id));
  const byName = (re: RegExp) => layers.filter((l) => re.test(l.props.name.toLowerCase()));
  const texts = layers.filter((l) => l.props.layerType === 'text');
  const rasters = layers.filter((l) => l.props.layerType === 'raster');
  const cp = canvas.props;
  const coversCanvas = (l: SceneNode<'layer'>) => ((l.props.width ?? 0) * l.props.scaleX * (l.props.height ?? 0) * l.props.scaleY) / (cp.width * cp.height) > 0.5;
  const layerSet = (ls: SceneNode<'layer'>[], label: string) => set(ls.map((l) => ({ kind: 'layer', id: l.id }) as Target), label);

  if (/^(?:selection|selected(?: layers?)?|(?:this|current) layer|layers? i selected)$/.test(text) || (text === 'layer' && sel.length)) return layerSet(sel, 'the selected layer');
  if (/^(?:image|whole image|entire image|everything|canvas|whole canvas|whole thing|picture|whole picture|overall image|scene|composition|poster|design)$/.test(text)) return set([{ kind: 'canvas', id: canvas.id }], 'the image');
  if (/^(?:sky|skies|clouds)$/.test(text)) {
    const named = byName(/\bsky\b/);
    return named.length ? layerSet(named, 'the sky') : set([{ kind: 'region', canvasId: canvas.id, region: 'sky' }], 'the sky');
  }
  if (/^(?:subject|person|people|man|woman|model|product|foreground|main subject|object)$/.test(text)) return set([{ kind: 'region', canvasId: canvas.id, region: 'subject' }], `the ${text}`);
  if (/^(?:background|backdrop|bg)$/.test(text)) {
    const named = byName(/\b(?:background|backdrop|bg)\b/).filter((l) => l.props.layerType !== 'fill' || !rasters.some(coversCanvas));
    if (named.length) return layerSet(named, 'the background');
    return rasters.some(coversCanvas) ? set([{ kind: 'region', canvasId: canvas.id, region: 'background' }], 'the background') : layerSet(layers.slice(0, 1), 'the background');
  }
  if (/^(?:title|headline|heading|main text|big text)s?$/.test(text)) {
    const named = texts.filter((l) => /title|headline|heading/.test(l.props.name.toLowerCase()));
    if (named.length) return layerSet(all ? named : named.slice(-1), 'the title');
    const largest = [...texts].sort((a, b) => (b.props.fontSize ?? 0) - (a.props.fontSize ?? 0))[0];
    return largest ? layerSet([largest], 'the title') : null;
  }
  if (/^(?:subtitle|subheading|tagline|caption|strapline)s?$/.test(text)) {
    const named = texts.filter((l) => /sub|tagline|caption|strap/.test(l.props.name.toLowerCase()));
    if (named.length) return layerSet(named.slice(-1), `the ${text}`);
    const sorted = [...texts].sort((a, b) => (b.props.fontSize ?? 0) - (a.props.fontSize ?? 0));
    return sorted[1] ? layerSet([sorted[1]], `the ${text}`) : null;
  }
  if (/^(?:text|texts|words|text layers?|type|lettering|copy)$/.test(text)) return layerSet(texts, 'the text');
  if (/^(?:photo|photograph|image layer|picture layer|shot|pixels?)$/.test(text)) {
    const named = byName(/photo|picture|image|shot/).filter((l) => l.props.layerType === 'raster');
    const target = named.length ? named : [...rasters].sort((a, b) => (b.props.width ?? 0) * (b.props.height ?? 0) - (a.props.width ?? 0) * (a.props.height ?? 0)).slice(0, 1);
    return target.length ? layerSet(all ? rasters : target, 'the photo') : set([{ kind: 'canvas', id: canvas.id }], 'the image');
  }
  const ord = /^(?:layer\s+(\d+)|(\w+)\s+layer)$/.exec(text);
  if (ord) {
    const o = ord[1] ? Number(ord[1]) : ordinalFrom(ord[2]!);
    // Layers are counted from the top, the way the layers panel lists them.
    const top = [...layers].reverse();
    const l = o ? pick(top, o) : undefined;
    if (l) return layerSet([l], ord[1] ? `layer ${ord[1]}` : `the ${ord[2]} layer`);
  }
  const phrase = text.replace(/\s+layers?$/, '');
  const matches = best(layers, (l) => Math.max(nameScore(l.props.name, phrase), l.props.layerType === 'text' ? nameScore(l.props.text ?? '', phrase) : 0));
  if (matches.length) return layerSet(all ? matches : matches.slice(-1), `"${matches[matches.length - 1]!.props.name}"`);
  if (/^layers?$/.test(text) && all) return layerSet(layers, 'all layers');
  return null;
}

/* Video -------------------------------------------------------------- */

function allClips(state: ProjectState, seqId: string): { clip: SceneNode<'clip'>; track: SceneNode<'track'> }[] {
  return tracksOf(state, seqId).flatMap((track) => clipsOf(state, track.id).map((clip) => ({ clip, track })));
}

function videoTargets(text: string, all: boolean, seq: SceneNode<'sequence'>, scope: TargetScope): TargetSet | null {
  const clips = allClips(scope.state, seq.id);
  const picture = clips.filter((c) => c.track.props.trackType === 'video').sort((a, b) => a.clip.props.start - b.clip.props.start);
  const titles = clips.filter((c) => c.clip.props.title && !c.clip.props.title.caption);
  const captions = clips.filter((c) => c.clip.props.title?.caption);
  const audio = clips.filter((c) => c.track.props.trackType === 'audio');
  const clipSet = (cs: typeof clips, label: string) => set(cs.map((c) => ({ kind: 'clip', id: c.clip.id }) as Target), label);
  const sel = clips.filter((c) => scope.selection.includes(c.clip.id));

  if (/^(?:selection|selected(?: clips?)?|(?:this|current) clip|clips? i selected)$/.test(text)) return clipSet(sel, 'the selected clip');
  if (/^(?:video|whole video|entire video|everything|sequence|footage|film|movie|edit|whole thing|timeline|picture)$/.test(text) || (all && /^clips?$/.test(text))) return set([{ kind: 'sequence', id: seq.id }], 'the video');
  if (/^(?:clip|shot) (?:at|under) (?:the )?playhead$|^current (?:clip|shot)$/.test(text) && scope.time !== null) {
    const t = scope.time;
    const under = picture.filter((c) => c.clip.props.start <= t && t < c.clip.props.start + (c.clip.props.out - c.clip.props.in) / c.clip.props.speed);
    return clipSet(under.slice(0, 1), 'the current clip');
  }
  const ord = /^(?:(?:clip|shot|scene)\s+(\d+)|(\w+)\s+(?:clip|shot|scene))$/.exec(text);
  if (ord) {
    const o = ord[1] ? Number(ord[1]) : ordinalFrom(ord[2]!);
    const c = o ? pick(picture, o) : undefined;
    if (c) return clipSet([c], ord[1] ? `clip ${ord[1]}` : `the ${ord[2]} clip`);
  }
  if (/^(?:title|titles|title card|headline|lower third|name tag)s?$/.test(text)) return clipSet(all || text.endsWith('s') ? titles : titles.slice(0, 1), 'the title');
  if (/^(?:captions?|subtitles?)$/.test(text)) return clipSet(captions, 'the captions');
  if (/^(?:music|song|soundtrack|audio|sound|track|score|background music|voice ?over|narration|dialogue)$/.test(text)) {
    const named = audio.filter((c) => nameScore(c.clip.props.name, text) || nameScore(c.track.props.name, text));
    return clipSet(named.length ? named : audio, `the ${text}`);
  }
  if (/^clips?$/.test(text) && sel.length) return clipSet(sel, 'the selected clip');
  const matches = best(clips, (c) => Math.max(nameScore(c.clip.props.name, text), nameScore(c.clip.props.title?.text ?? '', text)));
  if (matches.length) return clipSet(all ? matches : matches.slice(0, 1), `"${matches[0]!.clip.props.title?.text ?? matches[0]!.clip.props.name}"`);
  return null;
}

/* Animation ---------------------------------------------------------- */

function animationTargets(text: string, all: boolean, seq: SceneNode<'sequence'>, scope: TargetScope): TargetSet | null {
  const layers: SceneNode<'animLayer'>[] = [];
  walk(scope.state, seq.id, (n) => {
    if (n.type === 'animLayer') layers.push(n as SceneNode<'animLayer'>);
  });
  const lset = (ls: SceneNode<'animLayer'>[], label: string) => set(ls.map((l) => ({ kind: 'animLayer', id: l.id }) as Target), label);
  if (/^(?:selection|selected(?: layers?)?|(?:this|current) layer)$/.test(text)) return lset(layers.filter((l) => scope.selection.includes(l.id)), 'the selected layer');
  if (/^(?:animation|everything|whole animation|scene|sequence)$/.test(text) || (all && /^layers?$/.test(text))) return lset(layers, 'the animation');
  const ord = /^(?:layer\s+(\d+)|(\w+)\s+layer)$/.exec(text);
  if (ord) {
    const o = ord[1] ? Number(ord[1]) : ordinalFrom(ord[2]!);
    const l = o ? pick(layers, o) : undefined;
    if (l) return lset([l], `layer ${o}`);
  }
  const matches = best(layers, (l) => nameScore(l.props.name, text.replace(/\s+layer$/, '')));
  return matches.length ? lset(all ? matches : matches.slice(0, 1), `"${matches[0]!.props.name}"`) : null;
}

/* Slides -------------------------------------------------------------- */

function slideTargets(text0: string, all: boolean, deck: SceneNode<'deck'>, scope: TargetScope): TargetSet | null {
  const slides = deckSlides(scope.state, deck.id);
  const { phrase: text, slide: slideRef } = slideScope(text0);
  const current = slides.find((s) => s.id === scope.slideId) ?? slides[0];
  const slideOf = (ref: typeof slideRef) => (ref === null || ref === 'this' ? current : pick(slides, ref));
  const sset = (ss: (SceneNode<'slide'> | undefined)[], label: string) => set(ss.filter((s): s is SceneNode<'slide'> => !!s).map((s) => ({ kind: 'slide', id: s.id }) as Target), label);

  if (/^(?:deck|presentation|slideshow|slide deck|whole deck|everything|talk)$/.test(text)) return set([{ kind: 'deck', id: deck.id }], 'the deck');
  if (/^slides?$/.test(text) && all) return sset(slides, 'every slide');
  if (/^(?:this|current) slide$|^slide$/.test(text0.replace(ARTICLE, ''))) return sset([current], 'this slide');
  const so = /^(?:slide\s+(\d+)|(\w+)\s+slide)$/.exec(text);
  if (so) {
    const o = so[1] ? Number(so[1]) : ordinalFrom(so[2]!);
    if (o) return sset([pick(slides, o)], so[1] ? `slide ${so[1]}` : `the ${so[2]} slide`);
  }
  if (/^(?:slide )?backgrounds?$/.test(text)) {
    const targets = all ? slides : [slideOf(slideRef)].filter((s): s is SceneNode<'slide'> => !!s);
    return set(targets.map((s) => ({ kind: 'slideBackground', id: s.id }) as Target), all ? 'every slide background' : 'the slide background');
  }
  const scopeSlides = all ? slides : [slideOf(slideRef)].filter((s): s is SceneNode<'slide'> => !!s);
  const elements = scopeSlides.flatMap((s) => slideElements(scope.state, s.id));
  const eset = (es: SceneNode<'slideElement'>[], label: string) => set(es.map((e) => ({ kind: 'element', id: e.id }) as Target), label);
  const sel = elements.filter((e) => scope.selection.includes(e.id));
  if (/^(?:selection|selected(?: elements?| boxe?s?| items?)?|(?:this|current) (?:element|box))$/.test(text)) return eset(sel, 'the selected element');
  const role = (r: string) => elements.filter((e) => e.props.role === r);
  if (/^(?:titles?|headlines?|headings?)$/.test(text)) return eset(role('title'), 'the title');
  if (/^(?:subtitles?|subheadings?|taglines?)$/.test(text)) return eset(role('subtitle'), 'the subtitle');
  if (/^(?:body|body text|text|bullets?|bullet points?|list|content|points)$/.test(text)) {
    const body = role('body');
    return eset(body.length ? body : elements.filter((e) => e.props.elementType === 'text' && e.props.role !== 'title'), 'the body text');
  }
  if (/^footers?$/.test(text)) return eset(role('footer'), 'the footer');
  if (/^(?:images?|photos?|pictures?)$/.test(text)) return eset(elements.filter((e) => e.props.elementType === 'image'), 'the image');
  if (/^(?:charts?|graphs?)$/.test(text)) return eset(elements.filter((e) => e.props.elementType === 'chart'), 'the chart');
  if (/^(?:videos?|clips?)$/.test(text)) return eset(elements.filter((e) => e.props.elementType === 'video'), 'the video');
  if (/^(?:shapes?|boxe?s|rectangles?|circles?)$/.test(text)) return eset(elements.filter((e) => e.props.elementType === 'shape'), 'the shape');
  const matches = best(elements, (e) => nameScore(inlineToPlain(e.props.text ?? ''), text));
  return matches.length ? eset(all ? matches : matches.slice(0, 1), `"${inlineToPlain(matches[0]!.props.text ?? '').slice(0, 30)}"`) : null;
}

/* Documents ------------------------------------------------------------- */

function documentTargets(text: string, all: boolean, doc: SceneNode<'document'>, scope: TargetScope): TargetSet | null {
  const blocks = documentBlocks(scope.state, doc.id);
  const bset = (bs: SceneNode<'block'>[], label: string) => set(bs.map((b) => ({ kind: 'block', id: b.id }) as Target), label);
  const sel = blocks.filter((b) => scope.selection.includes(b.id));
  if (/^(?:selection|selected(?: text| blocks?| paragraphs?)?|(?:this|current) (?:paragraph|block|line))$/.test(text)) return bset(sel, 'the selection');
  if (/^(?:document|doc|whole document|everything|page|report|essay|text)$/.test(text)) return set([{ kind: 'document', id: doc.id }], 'the document');
  if (/^headings?$/.test(text) || /^(?:section )?headers?$/.test(text)) {
    if (all || text.endsWith('s')) return set([{ kind: 'textStyle', documentId: doc.id, styles: ['h1', 'h2', 'h3'] }], 'the headings');
  }
  if (/^(?:body(?: text)?|paragraphs|normal text|body copy)$/.test(text)) return set([{ kind: 'textStyle', documentId: doc.id, styles: ['body'] }], 'the body text');
  if (/^quotes$/.test(text)) return set([{ kind: 'textStyle', documentId: doc.id, styles: ['quote'] }], 'the quotes');
  if (/^(?:title|document title)$/.test(text)) {
    const t = blocks.find((b) => b.props.blockType === 'heading' && (b.props.level ?? 1) <= 1) ?? blocks[0];
    return t ? bset([t], 'the title') : null;
  }
  const kindWords: [RegExp, (b: SceneNode<'block'>) => boolean, string][] = [
    // Empty lines are not paragraphs to a reader.
    [/^(?:paragraph|para)$/, (b) => b.props.blockType === 'paragraph' && !!b.props.text.trim(), 'paragraph'],
    [/^(?:heading|header|section)$/, (b) => b.props.blockType === 'heading', 'heading'],
    [/^(?:bullet|bullet point|list item|item)$/, (b) => b.props.blockType === 'bullet' || b.props.blockType === 'numbered', 'bullet'],
    [/^(?:quote|blockquote)$/, (b) => b.props.blockType === 'quote', 'quote'],
    [/^(?:table)$/, (b) => b.props.blockType === 'table', 'table'],
    [/^(?:image|picture|figure|chart)$/, (b) => b.props.blockType === 'image' || b.props.blockType === 'embed', 'figure'],
    [/^(?:code block|code)$/, (b) => b.props.blockType === 'code', 'code block'],
  ];
  const ordered = /^(?:(\w+)\s+([a-z ]+?)|([a-z ]+?)\s+(\d+))$/.exec(text);
  if (ordered) {
    const word = (ordered[2] ?? ordered[3])!;
    const o = ordered[1] ? ordinalFrom(ordered[1]) : Number(ordered[4]);
    const kind = kindWords.find(([re]) => re.test(word));
    if (kind && o) {
      const b = pick(blocks.filter(kind[1]), o);
      if (b) return bset([b], `the ${ordered[1] ?? ''} ${kind[2]}${ordered[4] ? ` ${ordered[4]}` : ''}`.replace(/\s+/g, ' '));
    }
  }
  for (const [re, test, word] of kindWords) {
    const plural = new RegExp(re.source.replace(/\)\$$/, ')s$'));
    if (plural.test(text) || (all && re.test(text))) return bset(blocks.filter(test), `the ${word}s`);
  }
  const about = /^(?:(?:paragraph|section|part|bit|heading|line)\s+(?:about|on|that mentions|mentioning|with)\s+)(.+)$/.exec(text);
  const needle = (about ? about[1]! : text).replace(/^["']|["']$/g, '');
  if (needle.length >= 3) {
    const hits = blocks.filter((b) => inlineToPlain(b.props.text).toLowerCase().includes(needle));
    if (hits.length) return bset(all ? hits : hits.slice(0, 1), `the ${about ? 'paragraph' : 'block'} about "${needle}"`);
  }
  return null;
}

/** Ids that a step's targets refer to (for "it" and AI attribution). */
export function targetIds(t: TargetSet): string[] {
  return t.targets.flatMap((x) => ('id' in x ? [x.id] : 'canvasId' in x ? [x.canvasId] : [x.documentId]));
}

export function nodeOf<T extends SceneNode['type']>(state: ProjectState, id: string, type: T): SceneNode<T> | null {
  const n = state.nodes[id];
  return n && n.type === type ? (n as SceneNode<T>) : null;
}

