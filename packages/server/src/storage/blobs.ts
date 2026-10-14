import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { s3Request } from './s3.js';
import type { OmnixConfig } from '../config.js';

/**
 * Content-addressed binary storage. A blob's id is the SHA-256 of its bytes, so identical
 * uploads are stored once (automatic deduplication).
 */
export interface BlobStore {
  readonly kind: 'local' | 's3';
  put(data: Buffer): Promise<string>;
  /** Move a local temp file into the store (avoids loading large videos into memory). */
  putFile(tempPath: string, sha256?: string): Promise<string>;
  get(id: string): Promise<Buffer | null>;
  has(id: string): Promise<boolean>;
  size(id: string): Promise<number | null>;
  /** A local file path for tools like ffmpeg. Remote stores download into a cache. */
  localPath(id: string): Promise<string>;
  delete(id: string): Promise<void>;
}

export function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

/** Stream a request body to a temp file while hashing it. */
export async function streamToTemp(input: Readable, maxBytes: number): Promise<{ path: string; sha256: string; size: number }> {
  const tmp = path.join(os.tmpdir(), `omnix-upload-${crypto.randomBytes(8).toString('hex')}`);
  const h = crypto.createHash('sha256');
  let size = 0;
  input.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxBytes) input.destroy(new Error(`Upload exceeds ${Math.round(maxBytes / 1024 / 1024)} MB limit`));
    h.update(chunk);
  });
  await pipeline(input, createWriteStream(tmp));
  return { path: tmp, sha256: h.digest('hex'), size };
}

const isBlobId = (id: string) => /^[0-9a-f]{64}$/.test(id);

export class LocalBlobStore implements BlobStore {
  readonly kind = 'local' as const;
  constructor(private readonly root: string) {}

  private file(id: string): string {
    if (!isBlobId(id)) throw new Error(`Invalid blob id: ${id}`);
    return path.join(this.root, id.slice(0, 2), id.slice(2, 4), id);
  }

  async put(data: Buffer): Promise<string> {
    const id = sha256(data);
    const file = this.file(id);
    try {
      await fs.access(file);
      return id;
    } catch {
      // not stored yet
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
    return id;
  }

  async putFile(tempPath: string, hash?: string): Promise<string> {
    const id = hash ?? (await sha256File(tempPath));
    const file = this.file(id);
    if (await this.has(id)) {
      await fs.rm(tempPath, { force: true });
      return id;
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      await fs.rename(tempPath, file);
    } catch {
      // Cross-device: copy then remove.
      await fs.copyFile(tempPath, file);
      await fs.rm(tempPath, { force: true });
    }
    return id;
  }

  async get(id: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.file(id));
    } catch {
      return null;
    }
  }

  async has(id: string): Promise<boolean> {
    try {
      await fs.access(this.file(id));
      return true;
    } catch {
      return false;
    }
  }

  async size(id: string): Promise<number | null> {
    try {
      return (await fs.stat(this.file(id))).size;
    } catch {
      return null;
    }
  }

  async localPath(id: string): Promise<string> {
    const f = this.file(id);
    await fs.access(f);
    return f;
  }

  async delete(id: string): Promise<void> {
    await fs.rm(this.file(id), { force: true });
  }
}

/** S3-compatible storage (AWS S3, R2, MinIO...). Large media is cached locally for ffmpeg. */
export class S3BlobStore implements BlobStore {
  readonly kind = 's3' as const;
  constructor(
    private readonly cfg: NonNullable<OmnixConfig['s3']>,
    private readonly cacheDir: string,
  ) {}

  private key(id: string): string {
    if (!isBlobId(id)) throw new Error(`Invalid blob id: ${id}`);
    return `blobs/${id.slice(0, 2)}/${id}`;
  }

  async put(data: Buffer): Promise<string> {
    const id = sha256(data);
    if (await this.has(id)) return id;
    const r = await s3Request(this.cfg, 'PUT', this.key(id), data);
    if (!r.ok) throw new Error(`S3 PUT failed: ${r.status} ${await r.text()}`);
    return id;
  }

  async putFile(tempPath: string, hash?: string): Promise<string> {
    const data = await fs.readFile(tempPath);
    const id = await this.put(data);
    if (hash && hash !== id) throw new Error('Hash mismatch while storing blob');
    await fs.rm(tempPath, { force: true });
    return id;
  }

  async get(id: string): Promise<Buffer | null> {
    const r = await s3Request(this.cfg, 'GET', this.key(id));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`S3 GET failed: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  async has(id: string): Promise<boolean> {
    const r = await s3Request(this.cfg, 'HEAD', this.key(id));
    return r.ok;
  }

  async size(id: string): Promise<number | null> {
    const r = await s3Request(this.cfg, 'HEAD', this.key(id));
    return r.ok ? Number(r.headers.get('content-length') ?? 0) : null;
  }

  async localPath(id: string): Promise<string> {
    const file = path.join(this.cacheDir, id);
    try {
      await fs.access(file);
      return file;
    } catch {
      const data = await this.get(id);
      if (!data) throw new Error(`Blob not found: ${id}`);
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(file, data);
      return file;
    }
  }

  async delete(id: string): Promise<void> {
    await s3Request(this.cfg, 'DELETE', this.key(id));
    await fs.rm(path.join(this.cacheDir, id), { force: true });
  }
}
