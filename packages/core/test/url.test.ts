import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/hash.js';
import { canonicalizeUrl, docIdFor, InvalidUrlError, sameDocumentUrl } from '../src/url.js';

describe('canonicalizeUrl', () => {
  it.each([
    ['lowercases scheme and host', 'HTTPS://Example.GOV.in/Notices/A', 'https://example.gov.in/Notices/A'],
    ['drops the fragment', 'https://example.gov.in/a#section-2', 'https://example.gov.in/a'],
    ['drops the default https port', 'https://example.gov.in:443/a', 'https://example.gov.in/a'],
    ['drops the default http port', 'http://example.gov.in:80/a', 'http://example.gov.in/a'],
    ['keeps a non-default port', 'https://example.gov.in:8443/a', 'https://example.gov.in:8443/a'],
    ['removes utm_* params', 'https://e.in/a?utm_source=x&utm_medium=y&id=5', 'https://e.in/a?id=5'],
    ['removes fbclid and gclid', 'https://e.in/a?fbclid=1&gclid=2&page=3', 'https://e.in/a?page=3'],
    ['removes ref and source', 'https://e.in/a?ref=home&source=tw&q=1', 'https://e.in/a?q=1'],
    ['removes tracking params case-insensitively', 'https://e.in/a?UTM_Source=x&id=1', 'https://e.in/a?id=1'],
    ['sorts remaining params by key', 'https://e.in/a?z=1&b=2&a=3', 'https://e.in/a?a=3&b=2&z=1'],
    ['keeps the order of repeated keys', 'https://e.in/a?t=2&a=1&t=1', 'https://e.in/a?a=1&t=2&t=1'],
    ['keeps raw param encoding', 'https://e.in/a?q=a%20b&r=1,2', 'https://e.in/a?q=a%20b&r=1,2'],
    ['drops an empty query', 'https://e.in/a?', 'https://e.in/a'],
    ['drops a query of only tracking params', 'https://e.in/a/?utm_campaign=x', 'https://e.in/a'],
    ['strips a trailing slash', 'https://e.in/notices/', 'https://e.in/notices'],
    ['strips repeated trailing slashes', 'https://e.in/notices//', 'https://e.in/notices'],
    ['keeps the root slash', 'https://e.in/', 'https://e.in/'],
    ['adds the root slash', 'https://e.in', 'https://e.in/'],
    ['keeps http as given', 'http://e.in/a', 'http://e.in/a'],
    ['trims surrounding whitespace', '  https://e.in/a  ', 'https://e.in/a'],
    ['converts unicode hosts to punycode', 'https://सरकार.भारत/a', 'https://xn--11b7cb3a6a.xn--h2brj9c/a'],
    [
      'keeps params that only look like tracking',
      'https://e.in/a?referrer=1&sourcefile=2',
      'https://e.in/a?referrer=1&sourcefile=2',
    ],
  ])('%s', (_name, input, expected) => {
    expect(canonicalizeUrl(input)).toBe(expected);
  });

  it.each(['not a url', 'ftp://e.in/a', 'javascript:alert(1)', 'https://user:pw@e.in/a'])('rejects %s', (input) => {
    expect(() => canonicalizeUrl(input)).toThrow(InvalidUrlError);
  });

  it('is idempotent', () => {
    const once = canonicalizeUrl('HTTPS://E.in:443/a/b/?z=1&utm_x=2&a=%41#f');
    expect(canonicalizeUrl(once)).toBe(once);
  });
});

describe('docIdFor', () => {
  it('hashes the canonical URL', () => {
    expect(docIdFor('https://E.in/a/?utm_source=x')).toBe(sha256Hex('https://e.in/a'));
    expect(docIdFor('https://e.in/a')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives equivalent URLs the same id', () => {
    expect(docIdFor('https://e.in/a?b=1&a=2#x')).toBe(docIdFor('https://e.in:443/a/?a=2&b=1&fbclid=z'));
  });
});

describe('sameDocumentUrl', () => {
  it('ignores http vs https and a trailing slash', () => {
    expect(sameDocumentUrl('http://e.in/a/', 'https://e.in/a')).toBe(true);
  });

  it('distinguishes different paths and hosts', () => {
    expect(sameDocumentUrl('https://e.in/a', 'https://e.in/b')).toBe(false);
    expect(sameDocumentUrl('https://e.in/a', 'https://www.e.in/a')).toBe(false);
  });
});
