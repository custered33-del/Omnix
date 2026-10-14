/** The six tools in Omnix. Every project has a primary tool, but may contain documents for all six. */
export type ToolKind = 'image' | 'video' | 'animation' | 'code' | 'document' | 'slides';
export const TOOL_KINDS: readonly ToolKind[] = ['image', 'video', 'animation', 'code', 'document', 'slides'];

export type AuthorType = 'human' | 'ai' | 'system';

/** Who made a change. Every operation in the log is attributed to an author. */
export interface Author {
  type: AuthorType;
  id: string;
  name: string;
}

export const SYSTEM_AUTHOR: Author = { type: 'system', id: 'system', name: 'Omnix' };

/** Colors are stored as CSS-compatible hex strings (#rrggbb or #rrggbbaa). */
export type Color = string;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

export const BLEND_MODES: readonly BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
];
