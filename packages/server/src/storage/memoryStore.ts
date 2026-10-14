import type { DocStore } from './store.js';

/** In-memory store (tests and ephemeral demos). */
export class MemoryStore implements DocStore {
  readonly kind = 'memory' as const;
  private cols = new Map<string, Map<string, unknown>>();
  private logs = new Map<string, unknown[]>();

  private col(name: string): Map<string, unknown> {
    let c = this.cols.get(name);
    if (!c) {
      c = new Map();
      this.cols.set(name, c);
    }
    return c;
  }
  async get<T>(collection: string, id: string): Promise<T | undefined> {
    const v = this.col(collection).get(id);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put<T>(collection: string, id: string, doc: T): Promise<void> {
    this.col(collection).set(id, structuredClone(doc));
  }
  async delete(collection: string, id: string): Promise<void> {
    this.col(collection).delete(id);
  }
  async list<T>(collection: string): Promise<T[]> {
    return [...this.col(collection).values()].map((v) => structuredClone(v) as T);
  }
  async append(log: string, entry: unknown): Promise<void> {
    let l = this.logs.get(log);
    if (!l) {
      l = [];
      this.logs.set(log, l);
    }
    l.push(structuredClone(entry));
  }
  async readLog<T>(log: string, options: { tail?: number } = {}): Promise<T[]> {
    const l = this.logs.get(log) ?? [];
    const slice = options.tail ? l.slice(-options.tail) : l;
    return slice.map((v) => structuredClone(v) as T);
  }
  async deleteLog(log: string): Promise<void> {
    this.logs.delete(log);
  }
  async close(): Promise<void> {}
}
