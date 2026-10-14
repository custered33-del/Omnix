import crypto from 'node:crypto';

/**
 * Minimal AWS Signature Version 4 signer for S3-compatible object storage.
 * Covers the four calls Omnix needs (PUT, GET, HEAD, DELETE) without the full AWS SDK.
 */
export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

const hmac = (key: Buffer | string, data: string) => crypto.createHmac('sha256', key).update(data).digest();
const hashHex = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');

export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

export interface SignInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: Buffer;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** ISO basic format, e.g. 20130524T000000Z */
  amzDate: string;
  /** Use UNSIGNED-PAYLOAD instead of hashing the body. */
  unsignedPayload?: boolean;
}

function encodePath(p: string): string {
  return p
    .split('/')
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('/');
}

/** Produce the Authorization header (and the canonical pieces, for tests). */
export function signV4(input: SignInput): { authorization: string; signedHeaders: string; canonicalRequest: string; stringToSign: string; payloadHash: string } {
  const date = input.amzDate.slice(0, 8);
  const payloadHash = input.unsignedPayload ? 'UNSIGNED-PAYLOAD' : hashHex(input.body ?? Buffer.alloc(0));
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${headers[k]}\n`).join('');
  const query = [...input.url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [input.method, encodePath(input.url.pathname), query, canonicalHeaders, signedHeaderNames.join(';'), payloadHash].join('\n');
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, hashHex(canonicalRequest)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(input.secretAccessKey, date, input.region, input.service)).update(stringToSign).digest('hex');
  const signedHeaders = signedHeaderNames.join(';');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signedHeaders,
    canonicalRequest,
    stringToSign,
    payloadHash,
  };
}

export async function s3Request(cfg: S3Config, method: 'GET' | 'PUT' | 'HEAD' | 'DELETE', key: string, body?: Buffer): Promise<Response> {
  const base = new URL(cfg.endpoint);
  const url = cfg.forcePathStyle ? new URL(`${base.origin}/${cfg.bucket}/${key}`) : new URL(`${base.protocol}//${cfg.bucket}.${base.host}/${key}`);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const payloadHash = body ? hashHex(body) : hashHex('');
  const headers: Record<string, string> = { host: url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  const { authorization } = signV4({ method, url, headers, body, region: cfg.region, service: 's3', accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, amzDate });
  const reqHeaders: Record<string, string> = { 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, authorization };
  return fetch(url, { method, headers: reqHeaders, body: body ? new Uint8Array(body) : undefined });
}
