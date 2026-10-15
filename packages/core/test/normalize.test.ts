import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeHtml, cleanTitle } from '../src/normalize/html.js';
import { normalizeText, normHash, VOLATILE_PATTERNS } from '../src/normalize/text.js';
import { sha256Hex } from '../src/hash.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../../../fixtures/html/${name}`, import.meta.url), 'utf8');

describe('normalizeText', () => {
  it('applies NFKC, collapses whitespace, trims and lowercases', () => {
    expect(normalizeText('  Ｆｕｌｌ\u00a0Width\t\tTEXT \n\n here ')).toBe('full width text here');
  });

  it('normalizes line endings before matching patterns', () => {
    expect(normalizeText('Last updated today\r\nDeadline is 30 October')).toBe('deadline is 30 october');
  });

  it.each([
    ['Last updated: 12 Oct 2026 10:32', ''],
    ['Visitors: 10234', ''],
    ['Visitor count 9', ''],
    ['Page hits: 99812', ''],
    ['Page views 12', ''],
    ['Printed on 15/10/2026 at 10:00', ''],
    ['Timestamp: 1760551200', ''],
    ['timestamp 1760551200123', ''],
    ['1760551200 timestamp', ''],
    ['Session ID: 8f3a0c2e', ''],
    ['session_id=abc', ''],
    ['csrf_token=tok-1', ''],
  ])('removes the volatile pattern in "%s"', (input, expected) => {
    expect(normalizeText(input)).toBe(expected);
  });

  it('stops a volatile pattern at the end of the sentence or line', () => {
    expect(normalizeText('Last updated 12 Oct. Apply by 30 Oct.')).toBe('. apply by 30 oct.');
    expect(normalizeText('Last updated 12 Oct\nApply by 30 Oct')).toBe('apply by 30 oct');
  });

  it('keeps ordinary numbers', () => {
    expect(normalizeText('Circular 1760551200 issued')).toBe('circular 1760551200 issued');
  });

  it('accepts a custom pattern list, including non-global patterns', () => {
    expect(normalizeText('Ref ABC-1 and ABC-2', { volatilePatterns: [/abc-\d/i] })).toBe('ref and');
    expect(VOLATILE_PATTERNS.length).toBeGreaterThanOrEqual(7);
  });

  it('normHash is the sha256 of the normalized text', () => {
    expect(normHash('abc')).toBe(sha256Hex('abc'));
  });
});

describe('normalizeHtml', () => {
  const v1 = normalizeHtml(fixture('notice-v1.html'));

  it('extracts the main content without chrome or noise', () => {
    expect(v1.text).toContain('the last date to apply is 30 october 2026.');
    expect(v1.text).toContain('download the notice (pdf)');
    for (const gone of [
      'cookies',
      'home / notices',
      'share on social',
      'copyright',
      'visitors',
      '10234',
      'sessiontoken',
    ]) {
      expect(v1.text).not.toContain(gone);
    }
  });

  it('takes the title from <title>', () => {
    expect(v1.title).toBe('Synthetic Scholarship Notice 2026 | Demo Department');
  });

  it('gives the same hash when only timestamps, counters and chrome change', () => {
    const volatile = normalizeHtml(fixture('notice-v1-volatile.html'));
    expect(volatile.text).toBe(v1.text);
    expect(normHash(volatile.text)).toBe(normHash(v1.text));
  });

  it('gives a different hash when the deadline changes', () => {
    const v2 = normalizeHtml(fixture('notice-v2-deadline.html'));
    expect(v2.text).toContain('20 october 2026');
    expect(normHash(v2.text)).not.toBe(normHash(v1.text));
  });

  it('uses contentSelector when it matches and falls back when it does not', () => {
    const html =
      '<body><main><div id="notice-body"><p>Notice body text.</p></div><p>Other main text.</p></main></body>';
    expect(normalizeHtml(html, { contentSelector: '#notice-body' }).text).toBe('notice body text.');
    expect(normalizeHtml(html, { contentSelector: '#missing' }).text).toBe('notice body text. other main text.');
  });

  it('falls back from main to article to body', () => {
    expect(normalizeHtml('<body><article><p>In article.</p></article><p>Outside.</p></body>').text).toBe('in article.');
    expect(normalizeHtml('<body><p>Only body.</p></body>').text).toBe('only body.');
    expect(normalizeHtml('plain text').text).toBe('plain text');
  });

  it('separates block elements so patterns do not swallow the next block', () => {
    const html = '<main><div>Last updated 12 Oct</div><div>Apply by 30 Oct</div>a<br>b</main>';
    expect(normalizeHtml(html).text).toBe('apply by 30 oct a b');
  });

  it('keeps classes that only contain "ad-" inside a word', () => {
    const html =
      '<main><p class="download-link">Keep me</p><p class="lead-in">Me too</p><p class="ad-box">Drop</p><p id="top_ad-1">Drop</p></main>';
    expect(normalizeHtml(html).text).toBe('keep me me too');
  });

  it('removes aria-hidden, iframes and svg', () => {
    const html = '<main><p>Text</p><span aria-hidden="true">x</span><iframe></iframe><svg><text>s</text></svg></main>';
    expect(normalizeHtml(html).text).toBe('text');
  });

  it('falls back to the first h1 for the title and truncates long titles', () => {
    expect(normalizeHtml('<body><h1> Heading  One </h1></body>').title).toBe('Heading One');
    expect(normalizeHtml('<p>no title</p>').title).toBeNull();
    expect(normalizeHtml(`<title>${'x'.repeat(200)}</title>`).title).toHaveLength(160);
  });

  it('cleanTitle handles empty values', () => {
    expect(cleanTitle(undefined)).toBeNull();
    expect(cleanTitle(null)).toBeNull();
    expect(cleanTitle('   ')).toBeNull();
  });
});
