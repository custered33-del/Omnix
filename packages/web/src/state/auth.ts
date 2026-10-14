import { create } from 'zustand';
import { api, patch, post } from '../lib/api.js';
import { setLocale } from '../i18n/index.js';

export type Theme = 'system' | 'light' | 'dark' | 'high-contrast';

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'member';
  preferences: { theme: Theme; reducedMotion: 'system' | 'on' | 'off'; locale: string; pressureGamma: number };
  setup: { completed: string[]; current: string; dismissed: boolean; preset?: 'view' | 'approve' | 'autonomous'; testProjectId?: string | null; updatedAt: string };
  createdAt: string;
}

interface AuthState {
  user: User | null;
  status: 'loading' | 'signedOut' | 'signedIn';
  needsFirstAccount: boolean;
  load(): Promise<void>;
  login(email: string, password: string): Promise<void>;
  signup(email: string, name: string, password: string): Promise<void>;
  logout(): Promise<void>;
  updatePreferences(p: Partial<User['preferences']>): Promise<void>;
  updateSetup(s: Partial<User['setup']>): Promise<void>;
  setUser(u: User): void;
}

export function applyAppearance(prefs: Partial<User['preferences']> | undefined): void {
  const root = document.documentElement;
  const theme = prefs?.theme ?? 'system';
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  const motion = prefs?.reducedMotion ?? 'system';
  if (motion === 'system') root.removeAttribute('data-motion');
  else root.setAttribute('data-motion', motion === 'on' ? 'reduced' : 'full');
  try {
    localStorage.setItem('omnix.appearance', JSON.stringify({ theme, reducedMotion: motion }));
  } catch {
    // storage unavailable
  }
}

// Apply the last known appearance immediately so the first paint has the right theme.
try {
  const saved = JSON.parse(localStorage.getItem('omnix.appearance') ?? 'null');
  if (saved) applyAppearance(saved);
} catch {
  // ignore
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  status: 'loading',
  needsFirstAccount: false,
  async load() {
    try {
      const status = await api<{ needsFirstAccount: boolean; signedIn: boolean }>('/api/auth/status');
      if (!status.signedIn) {
        set({ status: 'signedOut', user: null, needsFirstAccount: status.needsFirstAccount });
        return;
      }
      const { user } = await api<{ user: User }>('/api/auth/me');
      applyAppearance(user.preferences);
      setLocale(user.preferences.locale || navigator.language);
      set({ user, status: 'signedIn', needsFirstAccount: false });
    } catch {
      set({ status: 'signedOut', user: null });
    }
  },
  async login(email, password) {
    const { user } = await post<{ user: User }>('/api/auth/login', { email, password });
    applyAppearance(user.preferences);
    set({ user, status: 'signedIn' });
  },
  async signup(email, name, password) {
    const { user } = await post<{ user: User }>('/api/auth/signup', { email, name, password });
    applyAppearance(user.preferences);
    set({ user, status: 'signedIn', needsFirstAccount: false });
  },
  async logout() {
    await post('/api/auth/logout');
    set({ user: null, status: 'signedOut' });
  },
  async updatePreferences(p) {
    const cur = get().user;
    if (!cur) return;
    const optimistic = { ...cur, preferences: { ...cur.preferences, ...p } };
    applyAppearance(optimistic.preferences);
    if (p.locale) setLocale(p.locale);
    set({ user: optimistic });
    const { user } = await patch<{ user: User }>('/api/auth/me', { preferences: p });
    set({ user });
  },
  async updateSetup(s) {
    const { user } = await patch<{ user: User }>('/api/auth/me', { setup: s });
    set({ user });
  },
  setUser(u) {
    set({ user: u });
  },
}));
