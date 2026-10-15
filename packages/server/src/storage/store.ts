/**
 * Omnix persists two kinds of data:
 *  - documents: small JSON records in named collections (users, projects, assets, tokens...)
 *  - logs: append-only JSON entries (project commits, the activity feed)
 *
 * Every backend (file system, Postgres, memory) implements this one interface,
 * so the rest of the server never knows where data lives.
 */
export interface DocStore {
  readonly kind: 'file' | 'postgres' | 'memory';
  get<T>(collection: string, id: string): Promise<T | undefined>;
  put<T>(collection: string, id: string, doc: T): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  list<T>(collection: string): Promise<T[]>;
  append(log: string, entry: unknown): Promise<void>;
  /** Read a log. `tail` returns only the last N entries. */
  readLog<T>(log: string, options?: { tail?: number }): Promise<T[]>;
  deleteLog(log: string): Promise<void>;
  close(): Promise<void>;
}

/** Collection names used across the server (kept in one place for discoverability). */
export const C = {
  users: 'users',
  sessions: 'sessions',
  tokens: 'tokens',
  projects: 'projects',
  checkpoints: 'checkpoints',
  assets: 'assets',
  jobs: 'jobs',
  oauthClients: 'oauth_clients',
  oauthCodes: 'oauth_codes',
  oauthTokens: 'oauth_tokens',
  connections: 'connections',
  templates: 'templates',
  presets: 'presets',
  plugins: 'plugins',
  shares: 'shares',
  meta: 'meta',
  agentTranscripts: 'agent_transcripts',
} as const;

export const commitLog = (projectId: string) => `commits/${projectId}`;
export const ACTIVITY_LOG = 'activity';
