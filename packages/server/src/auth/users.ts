import crypto from 'node:crypto';
import { newId, type Author } from '@omnix/core';
import type { DocStore } from '../storage/store.js';
import { C } from '../storage/store.js';

export type ThemePreference = 'system' | 'light' | 'dark' | 'high-contrast';

export interface SetupProgress {
  /** Completed step ids of the Claude setup guide. */
  completed: string[];
  /** Step the user was on last (resume point). */
  current: string;
  dismissed: boolean;
  /** Permission preset chosen in step 5; the default on the connector consent screen. */
  preset?: 'view' | 'approve' | 'autonomous';
  /** The small project the connection test writes its blank note into. */
  testProjectId?: string | null;
  updatedAt: string;
}

export interface UserPreferences {
  theme: ThemePreference;
  reducedMotion: 'system' | 'on' | 'off';
  locale: string;
  /** Pressure curve for brushes: 1 = linear. */
  pressureGamma: number;
}

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: string;
  role: 'owner' | 'member';
  preferences: UserPreferences;
  setup: SetupProgress;
}

export type PublicUser = Omit<User, 'passwordHash'>;

export interface LoginSession {
  id: string; // sha256 of the cookie token
  userId: string;
  createdAt: string;
  expiresAt: string;
}

/** Personal access token (API scripts and the stdio MCP bridge). */
export interface AccessToken {
  id: string; // sha256 of the secret
  userId: string;
  name: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  prefix: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, n, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !n || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export const tokenHash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function publicUser(u: User): PublicUser {
  const { passwordHash: _ignored, ...rest } = u;
  return rest;
}

export function authorOf(u: Pick<User, 'id' | 'name'>): Author {
  return { type: 'human', id: u.id, name: u.name };
}

const SESSION_DAYS = 30;

export const SETUP_STEPS = ['account', 'open-connectors', 'add-connector', 'oauth', 'scope', 'test', 'first-project'] as const;

export class UserService {
  constructor(
    private readonly store: DocStore,
    private readonly options: { openSignup: boolean },
  ) {}

  async count(): Promise<number> {
    return (await this.store.list<User>(C.users)).length;
  }

  async byId(id: string): Promise<User | undefined> {
    return this.store.get<User>(C.users, id);
  }

  async byEmail(email: string): Promise<User | undefined> {
    const e = email.trim().toLowerCase();
    return (await this.store.list<User>(C.users)).find((u) => u.email === e);
  }

  async list(): Promise<PublicUser[]> {
    return (await this.store.list<User>(C.users)).map(publicUser);
  }

  async signup(input: { email: string; name: string; password: string }): Promise<User> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError('Enter a valid email address', 400);
    if (input.password.length < 8) throw new AuthError('Use a password with at least 8 characters', 400);
    const name = input.name.trim() || email.split('@')[0]!;
    const existingCount = await this.count();
    if (existingCount > 0 && !this.options.openSignup) {
      throw new AuthError('Sign-up is closed on this Omnix server. Ask the owner to invite you, or set OMNIX_OPEN_SIGNUP=true.', 403);
    }
    if (await this.byEmail(email)) throw new AuthError('An account with this email already exists', 409);
    const now = new Date().toISOString();
    const user: User = {
      id: newId('usr'),
      email,
      name,
      passwordHash: hashPassword(input.password),
      createdAt: now,
      role: existingCount === 0 ? 'owner' : 'member',
      preferences: { theme: 'system', reducedMotion: 'system', locale: 'en', pressureGamma: 1 },
      setup: { completed: ['account'], current: 'open-connectors', dismissed: false, updatedAt: now },
    };
    await this.store.put(C.users, user.id, user);
    return user;
  }

  async login(email: string, password: string): Promise<User> {
    const u = await this.byEmail(email);
    // Same message either way so account existence is not revealed.
    if (!u || !verifyPassword(password, u.passwordHash)) throw new AuthError('Email or password is incorrect');
    return u;
  }

  async update(id: string, patch: Partial<Pick<User, 'name' | 'preferences' | 'setup'>>): Promise<User> {
    const u = await this.byId(id);
    if (!u) throw new AuthError('User not found', 404);
    const next: User = {
      ...u,
      ...(patch.name ? { name: patch.name.trim().slice(0, 100) } : {}),
      preferences: { ...u.preferences, ...(patch.preferences ?? {}) },
      setup: patch.setup ? { ...u.setup, ...patch.setup, updatedAt: new Date().toISOString() } : u.setup,
    };
    await this.store.put(C.users, id, next);
    return next;
  }

  async changePassword(id: string, current: string, next: string): Promise<void> {
    const u = await this.byId(id);
    if (!u || !verifyPassword(current, u.passwordHash)) throw new AuthError('Current password is incorrect', 400);
    if (next.length < 8) throw new AuthError('Use a password with at least 8 characters', 400);
    await this.store.put(C.users, id, { ...u, passwordHash: hashPassword(next) });
  }

  /* Sessions ------------------------------------------------------- */

  async createSession(userId: string): Promise<string> {
    const token = randomToken();
    const now = new Date();
    const s: LoginSession = {
      id: tokenHash(token),
      userId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_DAYS * 86400_000).toISOString(),
    };
    await this.store.put(C.sessions, s.id, s);
    return token;
  }

  async userForSession(token: string | undefined): Promise<User | undefined> {
    if (!token) return undefined;
    const s = await this.store.get<LoginSession>(C.sessions, tokenHash(token));
    if (!s) return undefined;
    if (new Date(s.expiresAt).getTime() < Date.now()) {
      await this.store.delete(C.sessions, s.id);
      return undefined;
    }
    return this.byId(s.userId);
  }

  async destroySession(token: string | undefined): Promise<void> {
    if (token) await this.store.delete(C.sessions, tokenHash(token));
  }

  /* Personal access tokens ---------------------------------------- */

  async createAccessToken(userId: string, name: string, scopes: string[]): Promise<{ token: string; record: AccessToken }> {
    const token = `omx_${randomToken(24)}`;
    const record: AccessToken = { id: tokenHash(token), userId, name, scopes, createdAt: new Date().toISOString(), lastUsedAt: null, prefix: token.slice(0, 8) };
    await this.store.put(C.tokens, record.id, record);
    return { token, record };
  }

  async listAccessTokens(userId: string): Promise<AccessToken[]> {
    return (await this.store.list<AccessToken>(C.tokens)).filter((t) => t.userId === userId);
  }

  async revokeAccessToken(userId: string, id: string): Promise<void> {
    const t = await this.store.get<AccessToken>(C.tokens, id);
    if (t && t.userId === userId) await this.store.delete(C.tokens, id);
  }

  async resolveAccessToken(token: string): Promise<{ user: User; token: AccessToken } | undefined> {
    if (!token.startsWith('omx_')) return undefined;
    const t = await this.store.get<AccessToken>(C.tokens, tokenHash(token));
    if (!t) return undefined;
    const user = await this.byId(t.userId);
    if (!user) return undefined;
    t.lastUsedAt = new Date().toISOString();
    await this.store.put(C.tokens, t.id, t);
    return { user, token: t };
  }
}
