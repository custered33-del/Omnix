import { useEffect } from 'react';
import { create } from 'zustand';

/** A command available in the command palette (and optionally bound to a shortcut). */
export interface Command {
  id: string;
  label: string;
  section: string;
  keywords?: string;
  shortcut?: string;
  icon?: React.ReactNode;
  run: () => void;
}

/** What the palette offers for free text that matches no command (inside a project: run it as a command). */
export interface FreeTextAction {
  label: (text: string) => string;
  run: (text: string) => void;
}

interface CommandState {
  scopes: Record<string, Command[]>;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  freeText: FreeTextAction | null;
  setFreeText(a: FreeTextAction | null): void;
  setScope(scope: string, commands: Command[] | null): void;
  openPalette(open: boolean): void;
  openShortcuts(open: boolean): void;
}

export const useCommandStore = create<CommandState>((set, get) => ({
  scopes: {},
  paletteOpen: false,
  shortcutsOpen: false,
  freeText: null,
  setFreeText(freeText) {
    set({ freeText });
  },
  setScope(scope, commands) {
    const scopes = { ...get().scopes };
    if (commands) scopes[scope] = commands;
    else delete scopes[scope];
    set({ scopes });
  },
  openPalette(open) {
    set({ paletteOpen: open });
  },
  openShortcuts(open) {
    set({ shortcutsOpen: open });
  },
}));

/** Register commands for as long as the component is mounted. */
export function useCommands(scope: string, commands: Command[], deps: unknown[]): void {
  useEffect(() => {
    useCommandStore.getState().setScope(scope, commands);
    return () => useCommandStore.getState().setScope(scope, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function allCommands(): Command[] {
  return Object.values(useCommandStore.getState().scopes).flat();
}
