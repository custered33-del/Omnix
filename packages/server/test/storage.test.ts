import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { FileStore } from '../src/storage/fileStore.js';
import { MemoryStore } from '../src/storage/memoryStore.js';
import { PostgresStore } from '../src/storage/postgresStore.js';
import { LocalBlobStore, sha256 } from '../src/storage/blobs.js';
import { signV4 } from '../src/storage/s3.js';
import type { DocStore } from '../src/storage/store.js';

async function exerciseStore(store: DocStore) {
  await store.put('things', 'a', { n: 1, nested: { x: [1, 2] } });
  await store.put('things', 'b/../evil', { n: 2 });
  expect(await store.get('things', 'a')).toEqual({ n: 1, nested: { x: [1, 2] } });
  expect(await store.get('things', 'b/../evil')).toEqual({ n: 2 });
  expect((await store.list<{ n: number }>('things')).map((t) => t.n).sort()).toEqual([1, 2]);
  // Returned objects are copies
  const got = (await store.get<{ n: number }>('things', 'a'))!;
  got.n = 99;
  expect((await store.get<{ n: number }>('things', 'a'))!.n).toBe(1);
  await store.delete('things', 'a');
  expect(await store.get('things', 'a')).toBeUndefined();
  for (let i = 0; i < 25; i++) await store.append('commits/p1', { i });
  const log = await store.readLog<{ i: number }>('commits/p1');
  expect(log.map((e) => e.i)).toEqual([...Array(25).keys()]);
  expect((await store.readLog<{ i: number }>('commits/p1', { tail: 3 })).map((e) => e.i)).toEqual([22, 23, 24]);
  expect(await store.readLog('nothing')).toEqual([]);
  await store.deleteLog('commits/p1');
  expect(await store.readLog('commits/p1')).toEqual([]);
}

describe('document stores', () => {
  it('memory store', async () => {
    await exerciseStore(new MemoryStore());
  });

  it('file store, including persistence across instances and concurrent writes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnix-fs-'));
    try {
      const s = new FileStore(dir);
      await exerciseStore(s);
      await Promise.all(Array.from({ length: 50 }, (_, i) => s.put('race', 'k', { i })));
      await Promise.all(Array.from({ length: 50 }, (_, i) => s.append('log', { i })));
      await s.close();
      const s2 = new FileStore(dir);
      const v = await s2.get<{ i: number }>('race', 'k');
      expect(v).toBeDefined();
      expect((await s2.readLog('log')).length).toBe(50);
      // A torn last line is ignored
      await fs.appendFile(path.join(dir, 'logs', 'log.jsonl'), '{"i": 5');
      expect((await new FileStore(dir).readLog('log')).length).toBe(50);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

const PG_BIN = '/usr/lib/postgresql/16/bin';
const hasPg = spawnSync('test', ['-x', `${PG_BIN}/initdb`]).status === 0;

describe.runIf(hasPg)('postgres store', () => {
  let dir = '';
  let proc: ChildProcess | null = null;
  let url = '';
  const asUser = (cmd: string, args: string[]) => {
    // initdb refuses to run as root; use the postgres system user when we are root.
    if (process.getuid?.() === 0) return spawnSync('su', ['postgres', '-s', '/bin/sh', '-c', [cmd, ...args].map((a) => `'${a}'`).join(' ')], { encoding: 'utf8' });
    return spawnSync(cmd, args, { encoding: 'utf8' });
  };

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnix-pg-'));
    if (process.getuid?.() === 0) spawnSync('chown', ['-R', 'postgres:postgres', dir]);
    const init = asUser(`${PG_BIN}/initdb`, ['-D', `${dir}/data`, '-U', 'omnix', '--auth=trust']);
    if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr}`);
    const port = 55432 + Math.floor(Math.random() * 1000);
    const args = ['-D', `${dir}/data`, '-p', String(port), '-k', dir, '-c', 'listen_addresses=127.0.0.1'];
    proc = process.getuid?.() === 0 ? spawn('su', ['postgres', '-s', '/bin/sh', '-c', `${PG_BIN}/postgres ${args.map((a) => `'${a}'`).join(' ')}`]) : spawn(`${PG_BIN}/postgres`, args);
    url = `postgres://omnix@127.0.0.1:${port}/postgres`;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const s = new PostgresStore(url);
      try {
        await s.list('probe');
        await s.close();
        return;
      } catch {
        await s.close().catch(() => {});
      }
    }
    throw new Error('postgres did not start');
  }, 60_000);

  afterAll(async () => {
    proc?.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 500));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('implements the store contract', async () => {
    const s = new PostgresStore(url);
    try {
      await exerciseStore(s);
    } finally {
      await s.close();
    }
  });
});

describe('blob store', () => {
  it('stores content-addressed and deduplicated', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnix-blob-'));
    try {
      const b = new LocalBlobStore(dir);
      const data = Buffer.from('hello omnix');
      const id = await b.put(data);
      expect(id).toBe(sha256(data));
      expect(await b.put(Buffer.from('hello omnix'))).toBe(id);
      expect((await b.get(id))!.toString()).toBe('hello omnix');
      expect(await b.size(id)).toBe(11);
      const tmp = path.join(dir, 'tmpfile');
      await fs.writeFile(tmp, 'other');
      const id2 = await b.putFile(tmp);
      expect(await b.has(id2)).toBe(true);
      await b.delete(id2);
      expect(await b.has(id2)).toBe(false);
      expect(await b.get('../../etc/passwd')).toBeNull();
      await expect(b.localPath('../../etc/passwd')).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('S3 SigV4 signer', () => {
  it('matches the AWS documented GET Object example', () => {
    const r = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        range: 'bytes=0-9',
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date': '20130524T000000Z',
      },
      region: 'us-east-1',
      service: 's3',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      amzDate: '20130524T000000Z',
    });
    expect(r.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});
