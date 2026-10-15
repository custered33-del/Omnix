import pg from 'pg';
import type { DocStore } from './store.js';

/**
 * Postgres backend. Documents live in one JSONB table keyed by (collection, id);
 * logs in an append-only table ordered by a sequence.
 */
export class PostgresStore implements DocStore {
  readonly kind = 'postgres' as const;
  private pool: pg.Pool;
  private ready: Promise<void>;

  constructor(connectionString: string) {
    // Hosted databases (Supabase, Neon and the like) need TLS; a local server usually does not.
    let remote = false;
    try {
      const u = new URL(connectionString);
      remote = !!u.hostname && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname) && !u.searchParams.get('host')?.startsWith('/') && !/sslmode=disable/.test(connectionString);
    } catch {
      remote = false;
    }
    this.pool = new pg.Pool({ connectionString, max: 10, ...(remote ? { ssl: { rejectUnauthorized: false } } : {}) });
    this.ready = this.migrate();
  }

  private async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS omnix_docs (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        doc JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (collection, id)
      );
      CREATE TABLE IF NOT EXISTS omnix_logs (
        seq BIGSERIAL PRIMARY KEY,
        log TEXT NOT NULL,
        entry JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS omnix_logs_log_seq ON omnix_logs (log, seq);
    `);
  }

  async get<T>(collection: string, id: string): Promise<T | undefined> {
    await this.ready;
    const r = await this.pool.query('SELECT doc FROM omnix_docs WHERE collection = $1 AND id = $2', [collection, id]);
    return r.rows[0]?.doc as T | undefined;
  }

  async put<T>(collection: string, id: string, doc: T): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO omnix_docs (collection, id, doc, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (collection, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
      [collection, id, JSON.stringify(doc)],
    );
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.ready;
    await this.pool.query('DELETE FROM omnix_docs WHERE collection = $1 AND id = $2', [collection, id]);
  }

  async list<T>(collection: string): Promise<T[]> {
    await this.ready;
    const r = await this.pool.query('SELECT doc FROM omnix_docs WHERE collection = $1 ORDER BY id', [collection]);
    return r.rows.map((row) => row.doc as T);
  }

  async append(log: string, entry: unknown): Promise<void> {
    await this.ready;
    await this.pool.query('INSERT INTO omnix_logs (log, entry) VALUES ($1, $2)', [log, JSON.stringify(entry)]);
  }

  async readLog<T>(log: string, options: { tail?: number } = {}): Promise<T[]> {
    await this.ready;
    if (options.tail) {
      const r = await this.pool.query('SELECT entry FROM (SELECT seq, entry FROM omnix_logs WHERE log = $1 ORDER BY seq DESC LIMIT $2) t ORDER BY seq ASC', [log, options.tail]);
      return r.rows.map((row) => row.entry as T);
    }
    const r = await this.pool.query('SELECT entry FROM omnix_logs WHERE log = $1 ORDER BY seq ASC', [log]);
    return r.rows.map((row) => row.entry as T);
  }

  async deleteLog(log: string): Promise<void> {
    await this.ready;
    await this.pool.query('DELETE FROM omnix_logs WHERE log = $1', [log]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
