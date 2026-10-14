import type { DeckProps, EmbedRef, MasterSlide, SceneNode, SlideElementProps, SlideProps, ThemeTokens } from './nodes.js';
import type { Operation } from './ops.js';
import { OpError } from './ops.js';
import { childrenOf, requireNodeOfType, subtreeIds, type ProjectState } from './state.js';
import { DEFAULT_THEME, makeNode } from './defaults.js';

/**
 * Slideshow helpers shared by the editor, importers and MCP tools: layouts from master
 * slides, theme presets, and slide creation, duplication and re-layout.
 */

export type SlideLayout = SlideProps['layout'];

/** Which master each layout uses (blank and full-bleed image have none). */
export const LAYOUT_MASTER: Record<SlideLayout, string | null> = {
  title: 'master-title',
  'title-body': 'master-title-body',
  'two-column': 'master-two-column',
  section: 'master-section',
  'image-full': null,
  blank: null,
};

export const LAYOUT_LABELS: Record<SlideLayout, string> = {
  title: 'Title',
  'title-body': 'Title and body',
  'two-column': 'Two columns',
  section: 'Section header',
  'image-full': 'Full-bleed image',
  blank: 'Blank',
};

/** Theme presets. Text and background pairs keep at least 4.5:1 contrast. */
export const THEME_PRESETS: ThemeTokens[] = [
  DEFAULT_THEME,
  {
    name: 'Midnight',
    colors: { background: '#14161c', surface: '#1e212a', text: '#f2f2f0', muted: '#a3a7b3', accent: '#7c9cff', accent2: '#ffb35c' },
    fonts: { heading: 'Inter', body: 'Inter', mono: 'JetBrains Mono' },
    sizes: { title: 72, heading: 52, body: 34, caption: 22 },
  },
  {
    name: 'Paper',
    colors: { background: '#ffffff', surface: '#f5f3ee', text: '#22201c', muted: '#6f6a60', accent: '#b4452f', accent2: '#2f6fb4' },
    fonts: { heading: 'Georgia', body: 'Georgia', mono: 'JetBrains Mono' },
    sizes: { title: 76, heading: 54, body: 34, caption: 22 },
  },
  {
    name: 'Bold',
    colors: { background: '#ffe14d', surface: '#fff2a6', text: '#111111', muted: '#4a4520', accent: '#1d3fd6', accent2: '#d6291d' },
    fonts: { heading: 'Inter', body: 'Inter', mono: 'JetBrains Mono' },
    sizes: { title: 88, heading: 58, body: 36, caption: 24 },
  },
  {
    name: 'Forest',
    colors: { background: '#f3f6f1', surface: '#ffffff', text: '#1b2a1f', muted: '#5b6b5e', accent: '#2f7a46', accent2: '#c2722b' },
    fonts: { heading: 'Inter', body: 'Inter', mono: 'JetBrains Mono' },
    sizes: { title: 72, heading: 52, body: 34, caption: 22 },
  },
];

export function deckSlides(state: ProjectState, deckId: string): SceneNode<'slide'>[] {
  requireNodeOfType(state, deckId, 'deck');
  return childrenOf(state, deckId).filter((n): n is SceneNode<'slide'> => n.type === 'slide');
}

export function slideElements(state: ProjectState, slideId: string): SceneNode<'slideElement'>[] {
  return childrenOf(state, slideId).filter((n): n is SceneNode<'slideElement'> => n.type === 'slideElement');
}

const SAMPLE: Record<string, string> = { title: 'Title', subtitle: 'Subtitle', body: '- First point\n- Second point', footer: 'Footer' };

/** Element props for each placeholder of a master, scaled to the deck. */
export function placeholderElements(deck: Pick<DeckProps, 'width' | 'height'>, master: MasterSlide | undefined, text: Partial<Record<string, string>> = {}): Partial<SlideElementProps>[] {
  if (!master) return [];
  return master.placeholders.map((p) => {
    const box = { x: Math.round(p.x * deck.width), y: Math.round(p.y * deck.height), w: Math.round(p.w * deck.width), h: Math.round(p.h * deck.height) };
    if (p.role === 'image') return { elementType: 'image', role: 'image', ...box, assetId: null };
    return { elementType: 'text', role: p.role, ...box, text: text[p.role] ?? SAMPLE[p.role] ?? '', ...(p.role === 'title' ? { bold: true } : {}) };
  });
}

/** Ops creating a new slide from a layout, at `index` (default: end). */
export function newSlideOps(state: ProjectState, deckId: string, layout: SlideLayout, options: { index?: number; name?: string; text?: Partial<Record<string, string>> } = {}): { op: Operation; slideId: string } {
  const deck = requireNodeOfType(state, deckId, 'deck');
  const masterId = LAYOUT_MASTER[layout];
  const master = deck.props.masters.find((m) => m.id === masterId);
  const slide = makeNode('slide', { name: options.name ?? LAYOUT_LABELS[layout], layout, masterId: master ? master.id : null });
  const els = placeholderElements(deck.props, master, options.text).map((p) => makeNode('slideElement', p));
  if (layout === 'image-full') els.push(makeNode('slideElement', { elementType: 'image', role: 'image', x: 0, y: 0, w: deck.props.width, h: deck.props.height, assetId: null }));
  slide.children = els.map((e) => e.id);
  for (const e of els) e.parentId = slide.id;
  const index = options.index ?? deck.children.length;
  return { op: { kind: 'create', parentId: deckId, index, nodes: [slide, ...els] }, slideId: slide.id };
}

/** Switch a slide to another layout: role elements move to the new placeholders, missing ones are added. */
export function applyLayoutOps(state: ProjectState, slideId: string, layout: SlideLayout): Operation {
  const slide = requireNodeOfType(state, slideId, 'slide');
  const deck = requireNodeOfType(state, slide.parentId!, 'deck');
  const masterId = LAYOUT_MASTER[layout];
  const master = deck.props.masters.find((m) => m.id === masterId);
  const ops: Operation[] = [{ kind: 'update', id: slide.id, set: { layout, masterId: master ? master.id : null } }];
  const els = slideElements(state, slideId);
  const used = new Set<string>();
  for (const ph of placeholderElements(deck.props, master)) {
    const existing = els.find((e) => e.props.role === ph.role && !used.has(e.id));
    if (existing) {
      used.add(existing.id);
      ops.push({ kind: 'update', id: existing.id, set: { x: ph.x, y: ph.y, w: ph.w, h: ph.h } });
    } else {
      const node = makeNode('slideElement', ph);
      ops.push({ kind: 'create', parentId: slide.id, nodes: [node] });
    }
  }
  return { kind: 'batch', ops };
}

/** Deep copy a slide (with its elements) right after the original. */
export function duplicateSlideOps(state: ProjectState, slideId: string): { op: Operation; slideId: string } {
  const slide = requireNodeOfType(state, slideId, 'slide');
  const deck = state.nodes[slide.parentId!]!;
  const copy = makeNode('slide', { ...structuredClone(slide.props), name: `${slide.props.name} copy`, rehearsalSeconds: null });
  const els = slideElements(state, slideId).map((e) => {
    const n = makeNode('slideElement', structuredClone(e.props));
    n.parentId = copy.id;
    return n;
  });
  copy.children = els.map((e) => e.id);
  return { op: { kind: 'create', parentId: deck.id, index: deck.children.indexOf(slide.id) + 1, nodes: [copy, ...els] }, slideId: copy.id };
}

/** Apply a theme to the deck. Slides keep their own background overrides. */
export function applyThemeOp(state: ProjectState, deckId: string, theme: ThemeTokens): Operation {
  requireNodeOfType(state, deckId, 'deck');
  if (!theme.colors || !theme.fonts || !theme.sizes) throw new OpError('A theme needs colors, fonts and sizes');
  return { kind: 'update', id: deckId, set: { theme: structuredClone(theme) } };
}

/** Total rehearsed time in seconds, or null when no slide has been rehearsed. */
export function rehearsalTotal(state: ProjectState, deckId: string): number | null {
  const times = deckSlides(state, deckId).filter((s) => !s.props.hidden).map((s) => s.props.rehearsalSeconds);
  return times.some((t) => t !== null) ? times.reduce<number>((a, t) => a + (t ?? 0), 0) : null;
}

/**
 * Everything a deck needs to render on its own: its slides and elements, plus whatever live
 * links point at (a canvas, a sequence, a code cell, a slide of another deck), followed
 * recursively, and every asset those use. Used for public presentation links and exports.
 */
export function deckDependencies(state: ProjectState, deckId: string): { nodeIds: Set<string>; assetIds: Set<string>; embedRoots: { id: string; time?: number }[] } {
  requireNodeOfType(state, deckId, 'deck');
  const nodeIds = new Set<string>();
  const assetIds = new Set<string>();
  const embedRoots: { id: string; time?: number }[] = [];
  const scan = (v: unknown, key?: string): void => {
    if (!v || typeof v !== 'object') {
      if (key === 'assetId' && typeof v === 'string' && v) assetIds.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) scan(x);
      return;
    }
    const rec = v as Record<string, unknown>;
    if (key === 'embed' && typeof rec.kind === 'string' && typeof rec.ref === 'string') follow(rec as unknown as EmbedRef);
    for (const [k, x] of Object.entries(rec)) scan(x, k);
  };
  const addNode = (id: string) => {
    const n = state.nodes[id];
    if (!n || nodeIds.has(id)) return false;
    nodeIds.add(id);
    scan(n.props);
    return true;
  };
  const addSubtree = (id: string) => {
    for (const sid of subtreeIds(state, id)) addNode(sid);
  };
  const follow = (e: EmbedRef) => {
    if (e.kind === 'asset') {
      assetIds.add(e.ref);
      return;
    }
    const target = state.nodes[e.ref];
    if (!target) return;
    if (!nodeIds.has(target.id)) embedRoots.push({ id: target.id, ...(e.time !== undefined ? { time: e.time } : {}) });
    if (e.kind === 'slide') {
      // The slide's deck supplies size and theme; only this slide comes along.
      if (target.parentId) addNode(target.parentId);
      addSubtree(target.id);
    } else if (e.kind === 'cell-output' || e.kind === 'chart') {
      addNode(target.id);
    } else {
      addSubtree(target.id);
    }
  };
  addSubtree(deckId);
  return { nodeIds, assetIds, embedRoots };
}
