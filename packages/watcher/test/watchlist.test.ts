import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docIdFor } from '@chronicle/core';
import { describe, expect, it } from 'vitest';
import { TODO_URL, WatchlistError, enabledSources, loadWatchlist, parseWatchlist } from '../src/watchlist.js';
import { stubFetch } from './helpers.js';

const repoWatchlist = fileURLToPath(new URL('../../../watchlist.json', import.meta.url));

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    notice_id: 'syn-001',
    department: 'synthetic-dept',
    lang: 'en',
    sources: [{ url: 'http://example.test/notices/1', kind: 'page' }],
    enabled: true,
    ...overrides,
  };
}

function wl(items: unknown[], indexes: unknown[] = []): unknown {
  return { version: 1, indexes, items };
}

describe('parseWatchlist', () => {
  it('accepts the repo watchlist with demo entries and disabled TODO placeholders', () => {
    const parsed = parseWatchlist(JSON.parse(readFileSync(repoWatchlist, 'utf8')));
    const todo = parsed.items.filter((i) => i.sources.some((s) => s.url === TODO_URL));
    expect(todo.length).toBeGreaterThanOrEqual(10);
    expect(todo.length).toBeLessThanOrEqual(20);
    expect(todo.every((i) => !i.enabled)).toBe(true);
    const demo = parsed.items.filter((i) => i.enabled);
    expect(demo.map((i) => i.notice_id)).toEqual(['demo-001', 'demo-002', 'demo-003']);
    expect(parsed.indexes[0]?.link_selector).toBe('a.notice-link');
  });

  it('defaults enabled to true and indexes to empty', () => {
    const parsed = parseWatchlist({ version: 1, items: [{ ...item(), enabled: undefined }] });
    expect(parsed.items[0]?.enabled).toBe(true);
    expect(parsed.indexes).toEqual([]);
  });

  it.each([
    ['a TODO url on an enabled item', wl([item({ sources: [{ url: TODO_URL, kind: 'page' }] })]), 'http(s) URL'],
    ['a non-http url', wl([item({ sources: [{ url: 'ftp://example.test/x', kind: 'page' }] })]), 'http(s) URL'],
    [
      'duplicate notice ids',
      wl([item(), item({ sources: [{ url: 'http://example.test/2', kind: 'page' }] })]),
      'duplicate notice_id',
    ],
    ['the same url twice', wl([item(), item({ notice_id: 'syn-002' })]), 'already watched by syn-001'],
    ['an unknown index', wl([item({ index_id: 'nope' })]), 'unknown index_id'],
    [
      'duplicate index ids',
      wl(
        [],
        [
          { index_id: 'ix', url: 'http://example.test/', mode: 'archive', link_selector: 'a', max_pages: 1 },
          { index_id: 'ix', url: 'http://example.test/', mode: 'archive', link_selector: 'a', max_pages: 1 },
        ],
      ),
      'duplicate index_id',
    ],
    ['a bad department slug', wl([item({ department: 'Synthetic Dept' })]), 'department must be a lowercase slug'],
    ['an unknown field', wl([item({ extra: 1 })]), 'Unrecognized key'],
    ['a wrong version', { version: 2, items: [] }, 'version'],
    ['a bad source kind', wl([item({ sources: [{ url: 'http://example.test/1', kind: 'doc' }] })]), 'kind'],
  ])('rejects %s', (_name, json, message) => {
    expect(() => parseWatchlist(json)).toThrow(WatchlistError);
    expect(() => parseWatchlist(json)).toThrow(message);
  });

  it('allows TODO urls and duplicates on disabled items', () => {
    const disabled = item({ sources: [{ url: TODO_URL, kind: 'page' }], enabled: false });
    expect(() => parseWatchlist(wl([disabled, { ...disabled, notice_id: 'syn-002' }]))).not.toThrow();
  });
});

describe('enabledSources', () => {
  it('flattens enabled items, canonicalizes urls and applies the default poll interval', () => {
    const parsed = parseWatchlist(
      wl([
        item({
          scheme: 'syn-scheme',
          sources: [
            {
              url: 'HTTP://Example.test/notices/1/',
              kind: 'page',
              content_selector: 'main',
              must_contain: ['circular'],
            },
            { url: 'http://example.test/notices/1.pdf', kind: 'pdf', poll_hours: 2 },
          ],
        }),
        item({ notice_id: 'syn-off', enabled: false, sources: [{ url: TODO_URL, kind: 'page' }] }),
      ]),
    );
    const sources = enabledSources(parsed, 6);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      url: 'HTTP://Example.test/notices/1/',
      canonicalUrl: 'http://example.test/notices/1',
      docId: docIdFor('http://example.test/notices/1'),
      kind: 'page',
      contentSelector: 'main',
      mustContain: ['circular'],
      pollHours: 6,
      noticeId: 'syn-001',
      department: 'synthetic-dept',
      scheme: 'syn-scheme',
      lang: 'en',
    });
    expect(sources[1]).toMatchObject({ kind: 'pdf', pollHours: 2, contentSelector: undefined });
  });
});

describe('loadWatchlist', () => {
  const valid = JSON.stringify(wl([item()]));

  it('reads WATCHLIST_PATH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronicle-wl-'));
    const path = join(dir, 'watchlist.json');
    writeFileSync(path, valid);
    expect((await loadWatchlist({ path })).items).toHaveLength(1);
  });

  it('prefers WATCHLIST_URL when set', async () => {
    const { fetch, calls } = stubFetch({ 'http://config.test/wl.json': { status: 200, body: valid } });
    const parsed = await loadWatchlist({ path: '/does/not/exist.json', url: 'http://config.test/wl.json', fetch });
    expect(parsed.items).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('fails on an http error or invalid JSON', async () => {
    const { fetch } = stubFetch({
      'http://config.test/missing': { status: 404 },
      'http://config.test/bad': { status: 200, body: '{not json' },
    });
    await expect(loadWatchlist({ path: '', url: 'http://config.test/missing', fetch })).rejects.toThrow('http 404');
    await expect(loadWatchlist({ path: '', url: 'http://config.test/bad', fetch })).rejects.toThrow('not valid JSON');
  });
});
