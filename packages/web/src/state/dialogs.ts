import { create } from 'zustand';

/**
 * Project-level dialogs that any editor can open: the command bar, Match style, Run with Claude,
 * Find in project and generative fill/extend. ProjectPage renders them.
 */
interface DialogState {
  command: { text: string; autoRun: boolean } | null;
  style: { targetId: string | null } | null;
  agent: { goal: string } | null;
  find: boolean;
  generative: { mode: 'fill' | 'extend'; canvasId: string; replaceLayerId?: string; prompt?: string } | null;
  openCommand(text?: string, autoRun?: boolean): void;
  openStyle(targetId?: string | null): void;
  openAgent(goal?: string): void;
  openFind(open: boolean): void;
  openGenerative(g: DialogState['generative']): void;
  close(which: 'command' | 'style' | 'agent' | 'generative'): void;
}

export const useDialogs = create<DialogState>((set) => ({
  command: null,
  style: null,
  agent: null,
  find: false,
  generative: null,
  openCommand: (text = '', autoRun = false) => set({ command: { text, autoRun } }),
  openStyle: (targetId = null) => set({ style: { targetId } }),
  openAgent: (goal = '') => set({ agent: { goal } }),
  openFind: (find) => set({ find }),
  openGenerative: (generative) => set({ generative }),
  close: (which) => set({ [which]: null } as Partial<DialogState>),
}));
