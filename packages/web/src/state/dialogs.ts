import { create } from 'zustand';

/**
 * Project-level dialogs that any editor can open: the command bar, Match style, Run with Claude,
 * Find in project, generative fill/extend and Compare versions. ProjectPage renders them.
 */
interface DialogState {
  command: { text: string; autoRun: boolean } | null;
  style: { targetId: string | null } | null;
  agent: { goal: string } | null;
  find: boolean;
  generative: { mode: 'fill' | 'extend'; canvasId: string; replaceLayerId?: string; prompt?: string } | null;
  compare: { from?: string; to?: string; documentId?: string | null } | null;
  openCommand(text?: string, autoRun?: boolean): void;
  openStyle(targetId?: string | null): void;
  openAgent(goal?: string): void;
  openFind(open: boolean): void;
  openGenerative(g: DialogState['generative']): void;
  openCompare(c?: NonNullable<DialogState['compare']>): void;
  close(which: 'command' | 'style' | 'agent' | 'generative' | 'compare'): void;
}

export const useDialogs = create<DialogState>((set) => ({
  command: null,
  style: null,
  agent: null,
  find: false,
  generative: null,
  compare: null,
  openCommand: (text = '', autoRun = false) => set({ command: { text, autoRun } }),
  openStyle: (targetId = null) => set({ style: { targetId } }),
  openAgent: (goal = '') => set({ agent: { goal } }),
  openFind: (find) => set({ find }),
  openGenerative: (generative) => set({ generative }),
  openCompare: (compare = {}) => set({ compare }),
  close: (which) => set({ [which]: null } as Partial<DialogState>),
}));
