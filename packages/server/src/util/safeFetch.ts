import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Readable } from 'node:stream';

/**
 * Fetching URLs that people (or Claude) give us. The address is checked where the connection is
 * made, inside the DNS lookup, so a name cannot point somewhere public when checked and somewhere
 * internal when used. Redirects are followed one hop at a time, each checked the same way.
 */
export class BlockedUrlError extends Error {
  constructor(message = 'Importing from private network addresses is not allowed') {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

const blocked = new net.BlockList();
for (const [net4, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(net4, bits, 'ipv4');
for (const [net6, bits] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
  ['2001:db8::', 32],
] as const)
  blocked.addSubnet(net6, bits, 'ipv6');

/** Whether an IP address is loopback, private, link-local, multicast or otherwise not on the public internet. */
export function isInternalAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(ip)) return blocked.check(ip, 'ipv4');
  if (!net.isIPv6(ip)) return true;
  // IPv4 written inside IPv6 (::ffff:127.0.0.1, ::ffff:7f00:1) is checked as IPv4.
  const mapped = /^::ffff:(?:0:)?(.+)$/.exec(ip);
  if (mapped) {
    const rest = mapped[1]!;
    if (net.isIPv4(rest)) return blocked.check(rest, 'ipv4');
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hex) {
      const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
      return blocked.check([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'), 'ipv4');
    }
  }
  return blocked.check(ip, 'ipv6');
}

const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as (e: Error) => void)(err);
    const list = addresses as dns.LookupAddress[];
    if (!list.length || list.some((a) => isInternalAddress(a.address))) return (callback as (e: Error) => void)(new BlockedUrlError());
    if ((options as dns.LookupOptions).all) (callback as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  });
};

export interface SafeResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Readable;
  url: string;
}

/** GET a public http(s) URL, following up to `maxRedirects` redirects. */
export async function safeFetch(url: string, options: { timeoutMs?: number; maxRedirects?: number; allowInternal?: boolean } = {}): Promise<SafeResponse> {
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    if (!['http:', 'https:'].includes(current.protocol)) throw new BlockedUrlError('Only http and https addresses can be fetched');
    const host = current.hostname.replace(/^\[|\]$/g, '');
    if (!options.allowInternal && net.isIP(host) && isInternalAddress(host)) throw new BlockedUrlError();
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = (current.protocol === 'https:' ? https : http).get(current, { ...(options.allowInternal ? {} : { lookup: guardedLookup }), timeout: options.timeoutMs ?? 60_000, headers: { 'user-agent': 'Omnix' } }, resolve);
      req.on('timeout', () => req.destroy(new Error('The download timed out')));
      req.on('error', reject);
    });
    const location = res.headers.location;
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
      res.resume();
      if (hop >= (options.maxRedirects ?? 5)) throw new Error('Too many redirects');
      current = new URL(location, current);
      continue;
    }
    return { status: res.statusCode ?? 0, headers: res.headers, body: res, url: current.toString() };
  }
}
