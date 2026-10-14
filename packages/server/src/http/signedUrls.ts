import crypto from 'node:crypto';
import type { Services } from '../services.js';
import { C } from '../storage/store.js';

/**
 * Short-lived signed links for files, so Claude (or anyone the person hands the link to) can
 * download an export without an Omnix session. The signing key is generated once per server.
 */
async function signingKey(services: Services): Promise<Buffer> {
  const cached = services.ext.signingKey as Buffer | undefined;
  if (cached) return cached;
  let rec = await services.store.get<{ id: string; key: string }>(C.meta, 'signing-key');
  if (!rec) {
    rec = { id: 'signing-key', key: crypto.randomBytes(32).toString('base64') };
    await services.store.put(C.meta, rec.id, rec);
  }
  const key = Buffer.from(rec.key, 'base64');
  services.ext.signingKey = key;
  return key;
}

const mac = (key: Buffer, assetId: string, exp: number) => crypto.createHmac('sha256', key).update(`${assetId}.${exp}`).digest('base64url');

export async function signedFileUrl(services: Services, assetId: string, ttlSeconds = 24 * 3600): Promise<{ url: string; expiresAt: string }> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = mac(await signingKey(services), assetId, exp);
  return { url: `${services.config.publicUrl}/api/files/${assetId}?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export async function verifyFileSignature(services: Services, assetId: string, exp: string, sig: string): Promise<boolean> {
  const e = Number(exp);
  if (!Number.isFinite(e) || e * 1000 < Date.now() || !sig) return false;
  const expected = Buffer.from(mac(await signingKey(services), assetId, e));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
