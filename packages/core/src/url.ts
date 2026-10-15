import { sha256Hex } from './hash.js';

export class InvalidUrlError extends Error {
  constructor(input: string, reason: string) {
    super(`invalid URL "${input}": ${reason}`);
    this.name = 'InvalidUrlError';
  }
}

const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'ref', 'source']);

function isTrackingParam(rawKey: string): boolean {
  let key = rawKey;
  try {
    key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
  } catch {
    // keep the raw key
  }
  key = key.toLowerCase();
  return key.startsWith('utm_') || TRACKING_PARAMS.has(key);
}

function paramKey(pair: string): string {
  const i = pair.indexOf('=');
  return i === -1 ? pair : pair.slice(0, i);
}

/**
 * Canonical form used for doc ids. Scheme and host are lowercased, the fragment and default port
 * are dropped, tracking parameters are removed, the remaining parameters are sorted by key (stable,
 * raw encoding kept), and a trailing slash is removed except for the root path. `http` stays `http`.
 */
export function canonicalizeUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new InvalidUrlError(input, 'cannot be parsed');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new InvalidUrlError(input, `unsupported scheme ${u.protocol}`);
  }
  if (u.username !== '' || u.password !== '') throw new InvalidUrlError(input, 'credentials are not allowed');

  const pairs = u.search
    .slice(1)
    .split('&')
    .filter((p) => p !== '' && !isTrackingParam(paramKey(p)));
  const sorted = pairs
    .map((p, i) => ({ p, i, k: paramKey(p) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i))
    .map((x) => x.p);

  let path = u.pathname;
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/';

  const port = u.port === '' ? '' : `:${u.port}`;
  const query = sorted.length > 0 ? `?${sorted.join('&')}` : '';
  return `${u.protocol}//${u.hostname}${port}${path}${query}`;
}

export function docIdFor(url: string): string {
  return sha256Hex(canonicalizeUrl(url));
}

/** Equality used by the redirect rule: ignores http vs https and a trailing slash. */
export function sameDocumentUrl(a: string, b: string): boolean {
  const strip = (s: string): string => canonicalizeUrl(s).replace(/^https?:/, '');
  return strip(a) === strip(b);
}
