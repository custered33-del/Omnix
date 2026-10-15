import sharp from 'sharp';
import { assetRefs, replaceAssetOps, type Operation } from '@omnix/core';
import { colorWord, differenceHash, dominantColors, hammingDistance } from '@omnix/imaging';
import type { Services } from '../services.js';
import type { BlobStore } from '../storage/blobs.js';
import type { AssetRecord } from './pipeline.js';

/**
 * The asset library beyond storage (feature 53): automatic tags and a perceptual fingerprint for
 * every picture and video, search across everything known about a file, near-duplicate groups
 * (resized or re-encoded copies, which exact content hashing cannot catch), merging duplicates
 * across projects, and where each asset is used.
 */

/** Hashes within this many bits (of 64) are treated as the same picture. */
export const SIMILAR_BITS = 6;

/** Fingerprint and automatic tags, computed from the thumbnail and metadata. */
export async function analyzeAsset(blobs: BlobStore, a: AssetRecord): Promise<Pick<AssetRecord, 'phash' | 'autoTags'>> {
  const tags = new Set<string>();
  if (a.width && a.height) {
    const r = a.width / a.height;
    tags.add(r > 1.05 ? 'landscape' : r < 0.95 ? 'portrait' : 'square');
    const long = Math.max(a.width, a.height);
    if (long >= 3800) tags.add('4k');
    else if (long >= 1900) tags.add('full-hd');
    else if (long < 600) tags.add('small');
  }
  if (a.kind === 'video' || a.kind === 'audio') {
    const d = a.duration ?? 0;
    tags.add(d < 15 ? 'short' : d > 120 ? 'long' : 'medium-length');
    if (a.kind === 'video' && a.hasAudio === false) tags.add('silent');
  }
  if (a.source.kind === 'generated') tags.add('generated');
  if (a.source.kind === 'export') tags.add('export');
  if (a.mime === 'image/gif') tags.add('animated');
  let phash: string | undefined;
  if (a.thumbnailBlob && (a.kind === 'image' || a.kind === 'video')) {
    const thumb = await blobs.get(a.thumbnailBlob);
    if (thumb) {
      const gray = await sharp(thumb, { failOn: 'none' }).flatten({ background: '#ffffff' }).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
      phash = differenceHash(new Uint8Array(gray));
      const { data, info } = await sharp(thumb, { failOn: 'none' }).ensureAlpha().resize(64, 64, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
      const raster = { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
      let transparent = 0;
      for (let i = 3; i < raster.data.length; i += 4) if (raster.data[i]! < 250) transparent++;
      if (a.kind === 'image' && transparent > (raster.width * raster.height) / 50) tags.add('transparent');
      for (const c of dominantColors(raster, 4).filter((c) => c.share > 0.18).slice(0, 2)) tags.add(colorWord(...c.color));
    }
  }
  return { ...(phash ? { phash } : {}), autoTags: [...tags] };
}

/** Make sure a record has its fingerprint and automatic tags (older assets get them on first need). */
export async function ensureAnalyzed(services: Services, a: AssetRecord): Promise<AssetRecord> {
  if (a.autoTags) return a;
  try {
    return await services.assets.update(a.id, await analyzeAsset(services.blobs, a));
  } catch {
    return services.assets.update(a.id, { autoTags: [] });
  }
}

/* ------------------------------------------------------------------ */
/* Where assets are used                                              */
/* ------------------------------------------------------------------ */

export interface AssetUse {
  projectId: string;
  projectName: string;
  nodeIds: string[];
}

const refCache = new Map<string, { head: string | null; refs: Map<string, string[]> }>();

/** Every asset used in the given projects (cached per project version). */
export async function assetUsage(services: Services, projects: { id: string; name: string }[]): Promise<Map<string, AssetUse[]>> {
  const out = new Map<string, AssetUse[]>();
  for (const p of projects) {
    const session = await services.projects.session(p.id);
    let hit = refCache.get(p.id);
    if (!hit || hit.head !== session.head) {
      hit = { head: session.head, refs: assetRefs(session.state) };
      refCache.set(p.id, hit);
    }
    for (const [assetId, nodeIds] of hit.refs) {
      const list = out.get(assetId) ?? [];
      list.push({ projectId: p.id, projectName: p.name, nodeIds });
      out.set(assetId, list);
    }
  }
  return out;
}

/** Whether any project at all (anyone's) still uses an asset. */
export async function usedAnywhere(services: Services, assetId: string): Promise<boolean> {
  return (await assetUsage(services, await services.projects.listMeta())).has(assetId);
}

/**
 * Take an asset out of one person's library. The bytes are deleted only when nobody else owns
 * it and no project uses it; otherwise the record stays for the projects that need it.
 */
export async function releaseAsset(services: Services, a: AssetRecord, userId: string, projectIds = a.projectIds): Promise<'deleted' | 'kept'> {
  const owners = a.owners.filter((o) => o !== userId);
  if (owners.length === 0 && projectIds.length === 0 && !(await usedAnywhere(services, a.id))) {
    await services.store.delete('assets', a.id);
    await services.blobs.delete(a.id);
    if (a.thumbnailBlob) await services.blobs.delete(a.thumbnailBlob);
    if (a.proxyBlob) await services.blobs.delete(a.proxyBlob);
    return 'deleted';
  }
  await services.assets.update(a.id, { owners, projectIds });
  return 'kept';
}

/* ------------------------------------------------------------------ */
/* Search                                                             */
/* ------------------------------------------------------------------ */

export interface SearchOptions {
  query?: string;
  kind?: string;
  tag?: string;
  projectId?: string;
  sort?: 'newest' | 'oldest' | 'name' | 'size' | 'relevance';
  usage?: Map<string, AssetUse[]>;
}

function haystack(a: AssetRecord, uses: AssetUse[] | undefined): string {
  return [
    a.name,
    a.kind,
    a.mime.split('/')[1] ?? '',
    a.name.split('.').pop() ?? '',
    ...a.tags,
    ...(a.autoTags ?? []),
    a.width && a.height ? `${a.width}x${a.height}` : '',
    a.source.prompt ?? '',
    a.source.url ?? '',
    a.colorProfile ?? '',
    ...Object.values(a.exif ?? {}).map(String),
    ...(uses ?? []).map((u) => u.projectName),
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * Search the library: every word must match something about the file (name, tags, automatic
 * tags such as colors and orientation, size like 1920x1080, a generation prompt, camera EXIF or
 * the projects it is used in). `kind:video`, `tag:logo` and `unused` work as filters inside the
 * query. Results rank name matches first.
 */
export function searchAssets(list: AssetRecord[], o: SearchOptions): AssetRecord[] {
  let out = list;
  const words: string[] = [];
  let kind = o.kind;
  const tags = o.tag ? [o.tag] : [];
  let unused = false;
  for (const raw of (o.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)) {
    if (raw.startsWith('kind:')) kind = raw.slice(5);
    else if (raw.startsWith('tag:')) tags.push(raw.slice(4));
    else if (raw === 'unused') unused = true;
    else words.push(raw);
  }
  if (kind) out = out.filter((a) => a.kind === kind);
  for (const t of tags) out = out.filter((a) => a.tags.some((x) => x.toLowerCase() === t.toLowerCase()) || (a.autoTags ?? []).includes(t.toLowerCase()));
  if (o.projectId) out = out.filter((a) => a.projectIds.includes(o.projectId!) || o.usage?.get(a.id)?.some((u) => u.projectId === o.projectId));
  if (unused && o.usage) out = out.filter((a) => !o.usage!.get(a.id)?.length);
  const scored = out
    .map((a) => {
      if (!words.length) return { a, score: 0 };
      const hay = haystack(a, o.usage?.get(a.id));
      const name = a.name.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (!hay.includes(w)) return null;
        score += name.startsWith(w) ? 4 : name.includes(w) ? 3 : a.tags.some((t) => t.toLowerCase() === w) ? 2 : 1;
      }
      return { a, score };
    })
    .filter((x): x is { a: AssetRecord; score: number } => !!x);
  const sort = o.sort ?? (words.length ? 'relevance' : 'newest');
  scored.sort((x, y) => {
    if (sort === 'relevance' && x.score !== y.score) return y.score - x.score;
    if (sort === 'name') return x.a.name.localeCompare(y.a.name);
    if (sort === 'size') return y.a.size - x.a.size;
    if (sort === 'oldest') return x.a.createdAt.localeCompare(y.a.createdAt);
    return y.a.createdAt.localeCompare(x.a.createdAt);
  });
  return scored.map((x) => x.a);
}

/* ------------------------------------------------------------------ */
/* Near duplicates                                                    */
/* ------------------------------------------------------------------ */

/** Assets that look like `a` (same kind, close fingerprint, similar shape), closest first. */
export function similarTo(a: AssetRecord, list: AssetRecord[]): { asset: AssetRecord; distance: number }[] {
  if (!a.phash) return [];
  const ratio = a.width && a.height ? a.width / a.height : null;
  return list
    .filter((b) => b.id !== a.id && b.kind === a.kind && b.phash)
    .map((b) => ({ asset: b, distance: hammingDistance(a.phash!, b.phash!) }))
    .filter(({ asset: b, distance }) => {
      if (distance > SIMILAR_BITS) return false;
      if (ratio && b.width && b.height) return Math.abs(ratio - b.width / b.height) / ratio < 0.03;
      return true;
    })
    .sort((x, y) => x.distance - y.distance);
}

/** Groups of near-duplicates, each with the copy worth keeping first (largest picture, then largest file). */
export function similarGroups(list: AssetRecord[]): AssetRecord[][] {
  const parent = new Map(list.map((a) => [a.id, a.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const withHash = list.filter((a) => a.phash);
  for (let i = 0; i < withHash.length; i++) {
    for (const { asset } of similarTo(withHash[i]!, withHash.slice(i + 1))) parent.set(find(asset.id), find(withHash[i]!.id));
  }
  const groups = new Map<string, AssetRecord[]>();
  for (const a of withHash) {
    const r = find(a.id);
    groups.set(r, [...(groups.get(r) ?? []), a]);
  }
  const score = (a: AssetRecord) => (a.width ?? 0) * (a.height ?? 0) * 1e6 + a.size;
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort((x, y) => score(y) - score(x)));
}

export interface MergeResult {
  kept: string;
  merged: string[];
  /** Projects whose layers, clips and slides now use the kept file. */
  projects: { projectId: string; projectName: string; replaced: number; status: 'committed' | 'proposed' | 'skipped'; reason?: string }[];
}

/**
 * Merge near-duplicates into one: every use of the other copies, in every project the person
 * can edit, now points at the kept file, and the copies leave their library. Projects they
 * cannot edit keep their copy. `apply` lets callers commit or propose (Claude in approve mode).
 */
export async function mergeAssets(services: Services, userId: string, keepId: string, dropIds: string[], apply: (projectId: string, ops: Operation[], label: string) => Promise<'committed' | 'proposed'>): Promise<MergeResult> {
  let keep = await services.assets.get(keepId);
  if (!keep) throw new Error('The asset to keep no longer exists');
  const projects = await services.projects.listForUser(userId, { includeArchived: true });
  const result: MergeResult = { kept: keepId, merged: [], projects: [] };
  const touched = new Set<string>();
  for (const dropId of dropIds.filter((d) => d !== keepId)) {
    const drop = await services.assets.get(dropId);
    if (!drop) continue;
    let blocked = false;
    for (const p of projects) {
      const state = await services.projects.state(p.id);
      const ops = replaceAssetOps(state, dropId, keepId);
      if (!ops.length) continue;
      const role = p.ownerId === userId ? 'owner' : p.members.find((m) => m.userId === userId)?.role;
      if (role === 'viewer' || p.archived) {
        blocked = true;
        result.projects.push({ projectId: p.id, projectName: p.name, replaced: ops.length, status: 'skipped', reason: p.archived ? 'archived' : 'view only' });
        continue;
      }
      let status: 'committed' | 'proposed';
      try {
        status = await apply(p.id, ops, `Use "${keep.name}" instead of a duplicate`);
      } catch (e) {
        // For example a Claude connection that may not reach this project.
        blocked = true;
        result.projects.push({ projectId: p.id, projectName: p.name, replaced: ops.length, status: 'skipped', reason: e instanceof Error ? e.message : String(e) });
        continue;
      }
      if (status === 'proposed') blocked = true;
      touched.add(p.id);
      result.projects.push({ projectId: p.id, projectName: p.name, replaced: ops.length, status });
    }
    if (!blocked) {
      // The copy leaves this person's library; its bytes go once nobody else has it.
      await releaseAsset(services, drop, userId, drop.projectIds.filter((id) => !touched.has(id)));
      result.merged.push(drop.id);
    }
    keep = await services.assets.update(keep.id, {
      owners: [...new Set([...keep.owners, userId])],
      projectIds: [...new Set([...keep.projectIds, ...touched])],
      tags: [...new Set([...keep.tags, ...drop.tags])],
    });
  }
  return result;
}
