import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Point, ShapeKind, Selection } from '@omnix/core';

export type ImageTool = 'move' | 'marquee' | 'ellipse' | 'lasso' | 'wand' | 'quick' | 'object' | 'brush' | 'eraser' | 'clone' | 'heal' | 'text' | 'shape' | 'eyedropper' | 'hand' | 'zoom';

export const TOOL_KEYS: Record<string, ImageTool> = {
  v: 'move',
  m: 'marquee',
  l: 'lasso',
  w: 'wand',
  q: 'quick',
  o: 'object',
  b: 'brush',
  e: 'eraser',
  s: 'clone',
  j: 'heal',
  t: 'text',
  u: 'shape',
  i: 'eyedropper',
  h: 'hand',
  z: 'zoom',
};

export interface BrushSettings {
  size: number;
  hardness: number;
  opacity: number;
  spacing: number;
  stabilizer: number;
  tip: 'round' | 'square';
}

/** Live, uncommitted interaction state drawn on the overlay (never stored in the project). */
export interface LivePreview {
  stroke: { points: { x: number; y: number; pressure: number }[]; tool: string; size: number; color: string; opacity: number; hardness: number } | null;
  rect: { x: number; y: number; width: number; height: number; kind: 'rect' | 'ellipse' | 'shape' | 'object' } | null;
  lasso: Point[] | null;
  quick: Point[] | null;
  cursor: Point | null;
}

export interface ImageEditorState {
  tool: ImageTool;
  /** Tool held temporarily (space = hand). */
  springTool: ImageTool | null;
  zoom: number;
  pan: Point;
  selectedLayerId: string | null;
  color: string;
  secondaryColor: string;
  brush: BrushSettings;
  eraser: BrushSettings;
  clone: BrushSettings & { source: Point | null };
  wand: { tolerance: number; contiguous: boolean; sampleAll: boolean };
  select: { feather: number; mode: 'replace' | 'add' | 'subtract' };
  shape: { kind: ShapeKind; fill: string | null; stroke: string | null; strokeWidth: number; radius: number };
  text: { fontFamily: string; fontSize: number; fontWeight: number };
  busy: string | null;
  editingTextLayer: string | null;
  /** Bumped to request an overlay redraw after live changes. */
  liveVersion: number;
  set(patch: Partial<ImageEditorState>): void;
}

export type ImageEditorStore = StoreApi<ImageEditorState>;

const defaultBrush: BrushSettings = { size: 24, hardness: 0.7, opacity: 1, spacing: 0.12, stabilizer: 0.3, tip: 'round' };

export function createImageEditorStore(): ImageEditorStore {
  return createStore<ImageEditorState>((set) => ({
    tool: 'move',
    springTool: null,
    zoom: 1,
    pan: { x: 0, y: 0 },
    selectedLayerId: null,
    color: '#1d1f24',
    secondaryColor: '#ffffff',
    brush: { ...defaultBrush },
    eraser: { ...defaultBrush, hardness: 0.9 },
    clone: { ...defaultBrush, source: null },
    wand: { tolerance: 32, contiguous: true, sampleAll: true },
    select: { feather: 0, mode: 'replace' },
    shape: { kind: 'rect', fill: '#3b5bdb', stroke: null, strokeWidth: 2, radius: 0 },
    text: { fontFamily: 'Inter', fontSize: 72, fontWeight: 650 },
    busy: null,
    editingTextLayer: null,
    liveVersion: 0,
    set: (patch) => set(patch),
  }));
}

export function emptyLive(): LivePreview {
  return { stroke: null, rect: null, lasso: null, quick: null, cursor: null };
}

/** Combine a new geometric selection with the existing one (add/subtract need raster masks). */
export function isEmptySelection(sel: Selection | null): boolean {
  if (!sel) return true;
  if (sel.kind === 'rect' || sel.kind === 'ellipse') return Math.abs(sel.width) < 1 || Math.abs(sel.height) < 1;
  if (sel.kind === 'polygon') return sel.points.length < 3;
  return false;
}
