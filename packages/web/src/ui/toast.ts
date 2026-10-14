import { create } from 'zustand';

export interface ToastItem {
  id: number;
  kind: 'info' | 'success' | 'error' | 'ai';
  message: string;
  action?: { label: string; run: () => void };
}

interface ToastState {
  items: ToastItem[];
  push(t: Omit<ToastItem, 'id'>, ms?: number): number;
  dismiss(id: number): void;
}

let counter = 0;

export const useToasts = create<ToastState>((set, get) => ({
  items: [],
  push(t, ms = 4500) {
    const id = ++counter;
    set({ items: [...get().items.slice(-4), { ...t, id }] });
    if (ms > 0) setTimeout(() => get().dismiss(id), ms);
    return id;
  },
  dismiss(id) {
    set({ items: get().items.filter((x) => x.id !== id) });
  },
}));

export const toast = {
  info: (message: string, action?: ToastItem['action']) => useToasts.getState().push({ kind: 'info', message, ...(action ? { action } : {}) }),
  success: (message: string, action?: ToastItem['action']) => useToasts.getState().push({ kind: 'success', message, ...(action ? { action } : {}) }),
  error: (message: string) => useToasts.getState().push({ kind: 'error', message }, 8000),
  ai: (message: string, action?: ToastItem['action']) => useToasts.getState().push({ kind: 'ai', message, ...(action ? { action } : {}) }, 7000),
};
