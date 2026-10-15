import { describe, expect, it } from 'vitest';
import { classify, type ClassifyInput, type FetchResult } from '../src/classify.js';
import { sha256Hex } from '../src/hash.js';

const URL_A = 'https://demo.gov.example/notices/scholarship';
const LONG_TEXT = 'synthetic scholarship notice. the last date to apply is 30 october 2026. '.repeat(5);
const HASH_A = sha256Hex(LONG_TEXT);
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7 synthetic');

function fetchOk(over: Partial<FetchResult> = {}): FetchResult {
  return { status: 200, finalUrl: URL_A, redirectChainLen: 0, contentType: 'text/html', bytes: null, ...over };
}

function input(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    fetch: fetchOk(),
    source: { url: URL_A, kind: 'page' },
    content: { text: LONG_TEXT, normSha256: HASH_A, textExtracted: true },
    prev: { normSha256: HASH_A, textExtracted: true },
    ...over,
  };
}

describe('classify: unreachable', () => {
  it.each([
    ['network error', { status: 0, error: 'ECONNRESET' }],
    ['status 0 without an error', { status: 0 }],
    ['a timeout', { status: 0, error: 'timeout after 20000 ms' }],
    ['http 500', { status: 500 }],
    ['http 503', { status: 503 }],
    ['http 403', { status: 403 }],
    ['http 429', { status: 429 }],
    ['an unfollowed 301', { status: 301 }],
  ])('%s', (_n, f) => {
    expect(classify(input({ fetch: fetchOk(f) })).state).toBe('unreachable');
  });

  it('reports the error as the reason', () => {
    expect(classify(input({ fetch: fetchOk({ status: 0, error: 'ENOTFOUND' }) })).reason).toBe('ENOTFOUND');
  });

  it('is unreachable when a 200 arrives without normalized content', () => {
    expect(classify(input({ content: null })).state).toBe('unreachable');
  });
});

describe('classify: removal', () => {
  it('404 and 410', () => {
    expect(classify(input({ fetch: fetchOk({ status: 404 }) })).state).toBe('removed_404');
    expect(classify(input({ fetch: fetchOk({ status: 410 }) })).state).toBe('removed_410');
  });

  it.each([
    ['another host', 'https://other.example/notices/scholarship'],
    ['the home page', 'https://demo.gov.example/'],
    ['a search page', 'https://demo.gov.example/search?q=scholarship'],
    ['a 404 page', 'https://demo.gov.example/404.html'],
    ['an error page', 'https://demo.gov.example/error/notfound'],
  ])('redirected to %s', (_n, finalUrl) => {
    const r = classify(input({ fetch: fetchOk({ finalUrl, redirectChainLen: 1 }) }));
    expect(r.state).toBe('redirected');
    expect(r.reason).toContain(finalUrl);
  });

  it('is not redirected for http to https, a trailing slash, or a same-host move', () => {
    for (const finalUrl of [
      'http://demo.gov.example/notices/scholarship/',
      'https://demo.gov.example/notices/scholarship?utm_source=x',
      'https://demo.gov.example/notices/scholarship-2026',
    ]) {
      expect(classify(input({ fetch: fetchOk({ finalUrl, redirectChainLen: 1 }) })).state).toBe('present');
    }
  });

  it('ignores an unparseable final URL', () => {
    expect(classify(input({ fetch: fetchOk({ finalUrl: 'not a url' }) })).state).toBe('present');
  });

  it('soft_removed: short page', () => {
    const r = classify(input({ content: { text: 'welcome', normSha256: sha256Hex('welcome'), textExtracted: true } }));
    expect(r).toEqual({ state: 'soft_removed', reason: 'page text is 7 chars' });
  });

  it.each([
    'not found',
    'no longer available',
    'the page you requested',
    'this notice has been removed',
    'this circular is withdrawn',
    'पृष्ठ नहीं मिला',
    'இந்த பக்கம் கிடைக்கவில்லை',
  ])('soft_removed: pattern "%s"', (phrase) => {
    const text = `${phrase} ${'x'.repeat(250)}`;
    expect(classify(input({ content: { text, normSha256: sha256Hex(text), textExtracted: true } })).state).toBe(
      'soft_removed',
    );
  });

  it('ignores soft-removal phrases on long pages', () => {
    const text = `the earlier circular was withdrawn. ${'notice text. '.repeat(100)}`;
    expect(classify(input({ content: { text, normSha256: sha256Hex(text), textExtracted: true } })).state).toBe(
      'changed',
    );
  });

  it('soft_removed: none of mustContain present', () => {
    const r = classify(input({ source: { url: URL_A, kind: 'page', mustContain: ['Merit Scholarship'] } }));
    expect(r.state).toBe('soft_removed');
    expect(classify(input({ source: { url: URL_A, kind: 'page', mustContain: ['30 OCTOBER'] } })).state).toBe(
      'present',
    );
    expect(classify(input({ source: { url: URL_A, kind: 'page', mustContain: [] } })).state).toBe('present');
  });

  it('soft_removed: a PDF URL that returns something other than a PDF', () => {
    const html = new TextEncoder().encode('<html>not found</html>');
    const r = classify(input({ source: { url: URL_A, kind: 'pdf' }, fetch: fetchOk({ bytes: html }) }));
    expect(r).toEqual({ state: 'soft_removed', reason: 'response is not a PDF' });
    expect(classify(input({ source: { url: URL_A, kind: 'pdf' }, fetch: fetchOk({ bytes: null }) })).state).toBe(
      'soft_removed',
    );
  });

  it('soft_removed: a PDF that lost its text layer', () => {
    const r = classify(
      input({
        source: { url: URL_A, kind: 'pdf' },
        fetch: fetchOk({ bytes: PDF_BYTES }),
        content: { text: '', normSha256: sha256Hex(PDF_BYTES), textExtracted: false },
      }),
    );
    expect(r.state).toBe('soft_removed');
  });
});

describe('classify: content states', () => {
  it('first_seen without a previous observation', () => {
    expect(classify(input({ prev: null })).state).toBe('first_seen');
    expect(classify(input({ prev: { normSha256: null, textExtracted: false } })).state).toBe('first_seen');
  });

  it('present when the hash matches', () => {
    expect(classify(input())).toEqual({ state: 'present', reason: 'normalized hash unchanged' });
  });

  it('changed when the hash differs', () => {
    expect(classify(input({ prev: { normSha256: sha256Hex('old'), textExtracted: true } })).state).toBe('changed');
  });

  it('a scanned PDF is first_seen, then present, not soft_removed', () => {
    const scanned = {
      source: { url: URL_A, kind: 'pdf' as const },
      fetch: fetchOk({ bytes: PDF_BYTES, contentType: 'application/pdf' }),
      content: { text: '', normSha256: sha256Hex(PDF_BYTES), textExtracted: false },
    };
    expect(classify(input({ ...scanned, prev: null })).state).toBe('first_seen');
    expect(
      classify(input({ ...scanned, prev: { normSha256: sha256Hex(PDF_BYTES), textExtracted: false } })).state,
    ).toBe('present');
  });

  it('a short PDF with text is not judged by the page length rule', () => {
    const text = 'short but real pdf notice text with more than fifty characters in it';
    const r = classify(
      input({
        source: { url: URL_A, kind: 'pdf' },
        fetch: fetchOk({ bytes: PDF_BYTES }),
        content: { text, normSha256: sha256Hex(text), textExtracted: true },
        prev: null,
      }),
    );
    expect(r.state).toBe('first_seen');
  });
});
