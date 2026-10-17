import { FakeArkivClient, FakeArkivNetwork, canonicalizeUrl, docIdFor } from '@chronicle/core';
import { describe, expect, it } from 'vitest';
import { WatcherDb } from '../src/db.js';
import { IndexSnapshotter } from '../src/index-snapshot.js';
import { pino } from 'pino';

const log = pino({ level: 'silent' });

describe('IndexSnapshotter', () => {
  it('writes an index_snapshot when archive links change, then skips', async () => {
    const network = new FakeArkivNetwork({ clock: () => 1_800_000_000 });
    const arkiv = new FakeArkivClient('0x00000000000000000000000000000000000000aa', network);
    const db = new WatcherDb(':memory:');
    let html =
      '<html><body><a class="notice-link" href="/circulars/001">One</a><a class="notice-link" href="/circulars/002">Two</a></body></html>';
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('robots.txt')) return new Response('User-agent: *\nAllow: /\n', { status: 200 });
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const snapper = new IndexSnapshotter({
      settings: {
        vantage: 'in-vps',
        userAgent: 'test',
        fetchTimeoutMs: 5_000,
        requestDelayMsPerHost: 0,
        observationTtlDays: 180,
      },
      arkiv,
      db,
      log,
      fetch: fetchFn,
      now: () => 1_800_000_000,
    });
    const ix = {
      index_id: 'demo-index',
      url: 'http://example.test/circulars/',
      mode: 'archive' as const,
      link_selector: 'a.notice-link',
      max_pages: 1,
    };
    const first = await snapper.check(ix);
    expect(first.status).toBe('written');
    expect(first.linkCount).toBe(2);
    const second = await snapper.check(ix);
    expect(second.status).toBe('skipped');

    html = '<html><body><a class="notice-link" href="/circulars/002">Two</a></body></html>';
    const third = await snapper.check(ix);
    expect(third.status).toBe('written');
    expect(third.linkCount).toBe(1);

    const q = await arkiv.query({ where: [{ attr: 'type', op: 'eq', value: 'index_snapshot' }], limit: 10 });
    expect(q.items).toHaveLength(2);
    const payload = q.items[0]?.payload as { links: { doc_id: string }[] };
    expect(payload.links.some((l) => l.doc_id === docIdFor(canonicalizeUrl('http://example.test/circulars/001')))).toBe(
      true,
    );
    db.close();
  });
});
