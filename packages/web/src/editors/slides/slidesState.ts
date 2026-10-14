import { createStore, type StoreApi } from 'zustand/vanilla';
import type { SlideElementProps } from '@omnix/core';

export interface SlidesEditorState {
  slideId: string | null;
  selected: string[];
  editingText: string | null;
  inspectorTab: 'element' | 'slide' | 'deck';
  /** Build preview in the editor: which click step is shown and when it started. */
  preview: { step: number; startedAt: number } | null;
  presenting: null | { mode: 'present' | 'rehearse'; startSlide: string | null };
  /** Copied elements (props only), pasted with new ids. */
  clipboard: SlideElementProps[];
  set(patch: Partial<SlidesEditorState>): void;
}

export type SlidesEditorStore = StoreApi<SlidesEditorState>;

export function createSlidesStore(firstSlide: string | null): SlidesEditorStore {
  return createStore<SlidesEditorState>((set) => ({
    slideId: firstSlide,
    selected: [],
    editingText: null,
    inspectorTab: 'element',
    preview: null,
    presenting: null,
    clipboard: [],
    set: (patch) => set(patch),
  }));
}
