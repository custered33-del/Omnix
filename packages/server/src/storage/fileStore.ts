import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { DocStore } from './store.js';

/** Encode ids/names into safe file names (no path traversal, stable round trip). */
export function safeName(s: string): string {
  return encodeURIComponent(s).replace(/\./g, '%2E').replace(/\*/g, '%2A');
}

/**
 * Zero-configuration local storage: one JSON file per document, JSON Lines for logs.
 * Writes are atomic (write to a temp file, then rename) and serialized per file, and
 * collections are cached in memory after first read.
 */
export class FileStore implements DocStore {
  readonly kind = 'file' as const;
  private cache = new Map<string, Promise<Map<string, unknown>>>();
  private chains = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  private colDir(collection: string): string {
    return path.join(this.root, 'collections', safeName(collection));
  }
  private logFile(log: string): string {
    return path.join(this.root, 'logs', ...log.split('/').map(safeName)) + '.jsonl';
  }

  /** Serialize async work per key so concurrent writes to one file never interleave. */
  private serial(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(key, next.catch(() => {}));
    return next;
  }

  /** The collection's documents, read from disk once. Concurrent first reads share one load, so no write lands in a map that is then replaced. */
  private loadCollection(collection: string): Promise<Map<string, unknown>> {
    let loading = this.cache.get(collection);
    if (!loading) {
      loading = this.readCollection(collection);
      this.cache.set(collection, loading);
      loading.catch(() => this.cache.delete(collection));
    }
    return loading;
  }

  private async readCollection(collection: string): Promise<Map<string, unknown>> {
    const map = new Map<string, unknown>();
    const dir = this.colDir(collection);
    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      files = [];
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf8');
        map.set(decodeURIComponent(f.slice(0, -5)), JSON.parse(raw));
      } catch {
        // A torn or corrupt file is skipped rather than taking the whole store down.
      }
    }
    return map;
  }

  async get<T>(collection: string, id: string): Promise<T | undefined> {
    const map = await this.loadCollection(collection);
    const v = map.get(id);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }

  async put<T>(collection: string, id: string, doc: T): Promise<void> {
    const map = await this.loadCollection(collection);
    const copy = structuredClone(doc);
    map.set(id, copy);
    const dir = this.colDir(collection);
    const file = path.join(dir, safeName(id) + '.json');
    const json = JSON.stringify(copy);
    await this.serial(file, async () => {
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.writeFile(tmp, json);
      await fs.rename(tmp, file);
    });
  }

  async delete(collection: string, id: string): Promise<void> {
    const map = await this.loadCollection(collection);
    map.delete(id);
    const file = path.join(this.colDir(collection), safeName(id) + '.json');
    await this.serial(file, async () => {
      await fs.rm(file, { force: true });
    });
  }

  async list<T>(collection: string): Promise<T[]> {
    const map = await this.loadCollection(collection);
    return [...map.values()].map((v) => structuredClone(v) as T);
  }

  async append(log: string, entry: unknown): Promise<void> {
    const file = this.logFile(log);
    const line = JSON.stringify(entry) + '\n';
    await this.serial(file, async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, line);
    });
  }

  async readLog<T>(log: string, options: { tail?: number } = {}): Promise<T[]> {
    const file = this.logFile(log);
    await (this.chains.get(file) ?? Promise.resolve());
    try {
      await fs.access(file);
    } catch {
      return [];
    }
    const out: T[] = [];
    const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // A partially written last line (crash mid-append) is ignored.
      }
      if (options.tail && out.length > options.tail * 2) out.splice(0, out.length - options.tail);
    }
    return options.tail ? out.slice(-options.tail) : out;
  }

  async deleteLog(log: string): Promise<void> {
    const file = this.logFile(log);
    await this.serial(file, async () => {
      await fs.rm(file, { force: true });
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }
}
