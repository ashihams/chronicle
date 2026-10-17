import { describe, expect, it } from 'vitest';
import { linksFingerprint, parseIndexLinks } from '../src/index-links.js';
import { buildIndexSnapshotAttrs, buildIndexSnapshotPayload } from '../src/index-snapshot.js';
import { docIdFor, canonicalizeUrl } from '../src/url.js';

describe('parseIndexLinks', () => {
  it('resolves relative hrefs and dedupes by doc id', () => {
    const html = `<html><body>
      <a class="notice-link" href="/circulars/001">First notice</a>
      <a class="notice-link" href="http://example.test/circulars/001">dup</a>
      <a class="notice-link" href="/circulars/002">Second</a>
      <a href="/other">ignored</a>
    </body></html>`;
    const links = parseIndexLinks(html, 'a.notice-link', 'http://example.test/circulars/');
    expect(links).toHaveLength(2);
    expect(links[0]?.title).toBe('First notice');
    expect(links[0]?.docId).toBe(docIdFor(canonicalizeUrl('http://example.test/circulars/001')));
    expect(links[1]?.title).toBe('Second');
  });
});

describe('index snapshot builders', () => {
  it('builds attrs with links_sha256 and a sorted payload', () => {
    const links = [
      { docId: docIdFor('http://example.test/b'), title: 'B' },
      { docId: docIdFor('http://example.test/a'), title: 'A' },
    ];
    const attrs = buildIndexSnapshotAttrs({
      indexId: 'demo-index',
      indexMode: 'archive',
      observedAt: 1_800_000_000,
      links,
    });
    expect(attrs).toMatchObject({
      type: 'index_snapshot',
      schema_v: 1,
      index_id: 'demo-index',
      index_mode: 'archive',
      link_count: 2,
    });
    expect(typeof attrs.links_sha256).toBe('string');
    expect(attrs.links_sha256).toHaveLength(64);
    const again = buildIndexSnapshotAttrs({
      indexId: 'demo-index',
      indexMode: 'archive',
      observedAt: 1_800_000_001,
      links: [...links].reverse(),
    });
    expect(again.links_sha256).toBe(attrs.links_sha256);
    expect(linksFingerprint(links)).toContain('\t');
    const payload = buildIndexSnapshotPayload(links);
    const ids = payload.links.map((l) => l.doc_id);
    expect(ids).toEqual([...ids].sort());
    expect(payload.links).toHaveLength(2);
  });
});
