import { computeBundleSha256, parseAndCheckBundle } from '@chronicle/core';
import { describe, expect, it } from 'vitest';
import { buildEvidenceBundle } from '../src/bundle-build.js';
import { IndexerDb } from '../src/db.js';
import { Indexer } from '../src/indexer.js';
import { buildApi } from '../src/api.js';
import { ADDR_A, Chain, DOC_ID, H, SETTINGS, silentLog } from './helpers.js';

describe('buildEvidenceBundle', () => {
  it('builds a sealed bundle from the mirror in chain order', async () => {
    const chain = new Chain();
    const db = new IndexerDb(':memory:');
    const docKey = await chain.doc(chain.a);
    const obsKey = await chain.observe(chain.a, { state: 'first_seen', hash: H(1) });
    await new Indexer(chain.a, db, SETTINGS, silentLog).sync();

    const bundle = buildEvidenceBundle(db, DOC_ID, {
      chainId: 7738577,
      rpc: 'https://rpc.example.test',
      generatedAt: 1_900_000_000,
    });
    expect(bundle).not.toBeNull();
    const b = bundle!;
    expect(b.bundle_version).toBe(1);
    expect(b.doc.doc_id).toBe(DOC_ID);
    expect(b.entries.map((e) => e.entity_key)).toEqual([docKey, obsKey]);
    expect(b.entries[1]?.creator).toBe(ADDR_A);
    expect(b.versions[0]).toMatchObject({ seq: 1, norm_sha256: H(1), status: 'current' });
    const { bundle_sha256: _hash, ...rest } = b;
    expect(b.bundle_sha256).toBe(computeBundleSha256(rest));
    expect(parseAndCheckBundle(b).bundle_sha256).toBe(b.bundle_sha256);
    expect(buildEvidenceBundle(db, 'f'.repeat(64), { chainId: 1, rpc: 'https://x.test', generatedAt: 1 })).toBeNull();
  });

  it('serves GET /api/bundle/:docId', async () => {
    const chain = new Chain();
    const db = new IndexerDb(':memory:');
    await chain.doc(chain.a);
    await chain.observe(chain.a, { hash: H(1) });
    await new Indexer(chain.a, db, SETTINGS, silentLog).sync();
    const app = await buildApi({
      db,
      arkiv: chain.a,
      explorerBase: 'https://explorer.example.test',
      log: silentLog,
      chainId: 7738577,
      rpcHttp: 'https://rpc.example.test',
      now: () => chain.t,
    });
    try {
      const res = await app.inject({ method: 'GET', url: `/api/bundle/${DOC_ID}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/chronicle-/);
      const body = res.json() as { bundle_version: number; bundle_sha256: string; doc: { doc_id: string } };
      expect(body).toMatchObject({ bundle_version: 1, doc: { doc_id: DOC_ID } });
      expect(body.bundle_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect((await app.inject({ method: 'GET', url: `/api/bundle/${'0'.repeat(64)}` })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
