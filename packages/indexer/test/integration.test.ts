import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeArkivClient, FakeArkivNetwork, canonicalizeUrl, datesToTs, docIdFor, loadConfig } from '@chronicle/core';
import { buildDemoApp } from '@chronicle/demo-site';
import { startWatcher } from '@chronicle/watcher';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi } from '../src/api.js';
import { IndexerDb } from '../src/db.js';
import { Indexer } from '../src/indexer.js';
import { ADDR_A, ADDR_B, SETTINGS, silentLog } from './helpers.js';

describe('demo site, watchers and indexer on one fake chain', () => {
  let demo: ReturnType<typeof buildDemoApp>;
  let base: string;

  beforeAll(async () => {
    demo = buildDemoApp({ adminToken: 'test-token' });
    await demo.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(demo.app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await demo.app.close();
  });

  it('serves docs, the timeline and live changes from watcher output', { timeout: 60_000 }, async () => {
    demo.state.reset();
    // the demo stamps Last-Modified with the wall clock, so chain and watcher time must follow it
    let t = Math.floor(Date.now() / 1000);
    const network = new FakeArkivNetwork({ clock: () => t });
    const watcherA = new FakeArkivClient(ADDR_A, network);
    const watcherB = new FakeArkivClient(ADDR_B, network);

    const dirFor = (vantage: string): string => {
      const dir = mkdtempSync(join(tmpdir(), `chronicle-${vantage}-`));
      const item = (id: string): unknown => ({
        notice_id: `demo-${id}`,
        department: 'demo-dept',
        scheme: 'demo-scheme',
        lang: 'en',
        sources: [{ url: `${base}/circulars/${id}`, kind: 'page', content_selector: 'main', poll_hours: 1 }],
      });
      writeFileSync(join(dir, 'watchlist.json'), JSON.stringify({ version: 1, items: [item('001'), item('002')] }));
      return dir;
    };
    const dirs = { a: dirFor('a'), b: dirFor('b') };
    const pass = async (vantage: 'a' | 'b', arkiv: FakeArkivClient): Promise<void> => {
      const config = loadConfig({
        ARKIV_MODE: 'fake',
        VANTAGE: `vantage-${vantage}`,
        WATCHLIST_PATH: 'watchlist.json',
        DATA_DIR: 'data',
        REQUEST_DELAY_MS_PER_HOST: '0',
      });
      await startWatcher({
        config,
        baseDir: dirs[vantage],
        once: true,
        log: silentLog,
        arkiv,
        llm: null,
        now: () => t,
      });
    };

    await pass('a', watcherA);
    t += 60;
    await pass('b', watcherB);
    t += 600;
    demo.state.mutate({ id: '001', action: 'edit_deadline', value: '2026-11-20' });
    await pass('a', watcherA);
    t += 60;

    const db = new IndexerDb(':memory:');
    const indexer = new Indexer(
      new FakeArkivClient('0x00000000000000000000000000000000000000ff', network),
      db,
      SETTINGS,
      silentLog,
    );
    await indexer.sync();
    const app = buildApi({
      db,
      arkiv: watcherA,
      explorerBase: 'https://explorer.example.test',
      log: silentLog,
      now: () => t,
    });
    try {
      const docId = docIdFor(canonicalizeUrl(`${base}/circulars/001`));

      const docs = (await app.inject('/api/docs')).json() as { total: number; items: Record<string, unknown>[] };
      expect(docs.total).toBe(2);
      const d1 = docs.items.find((d) => d.doc_id === docId);
      expect(d1).toMatchObject({
        notice_id: 'demo-001',
        department: 'demo-dept',
        current_state: 'changed',
        observer_count: 2,
        // A saw the edit, B did not: a tie between two watchers goes to the newer version
        current_version: { seq: 2, deadline_ts: datesToTs('2026-11-20') },
        open_flags: { count: 1, kinds: ['vantage_disagreement'] },
      });
      expect(String(d1?.title)).not.toBe('');

      const changed = (await app.inject(`/api/docs?state=changed`)).json() as { total: number };
      expect(changed.total).toBe(1);

      const timeline = (await app.inject(`/api/docs/${docId}/timeline`)).json() as {
        events: Record<string, unknown>[];
      };
      const observations = timeline.events.filter((e) => e.kind === 'observation');
      expect(observations.map((e) => [e.creator, e.state, e.vantage])).toEqual([
        [ADDR_A, 'first_seen', 'vantage-a'],
        [ADDR_B, 'first_seen', 'vantage-b'],
        [ADDR_A, 'changed', 'vantage-a'],
      ]);
      expect(timeline.events.filter((e) => e.kind === 'version').map((e) => e.label)).toEqual([
        'version 1 first seen',
        'version 2 first seen',
      ]);
      // watcher time and chain time agree, so the only flag is the disagreement
      expect(timeline.events.filter((e) => e.kind === 'flag').map((e) => e.flag_kind)).toEqual([
        'vantage_disagreement',
      ]);
      expect(db.flagsForDoc(docId).map((f) => f.kind)).toEqual(['vantage_disagreement']);

      const live = (await app.inject('/api/arkiv/changes?days=30')).json() as {
        source: string;
        items: { attributes: Record<string, unknown> }[];
      };
      expect(live.source).toBe('arkiv-live');
      expect(live.items).toHaveLength(1);
      expect(live.items[0]?.attributes).toMatchObject({
        doc_id: docId,
        state: 'changed',
        deadline_ts: datesToTs('2026-11-20'),
      });

      const health = (await app.inject('/api/health')).json() as { entityCount: number };
      // two doc entities (B found A's and skipped), 2 + 2 first_seen and one changed observation
      expect(health.entityCount).toBe(7);
    } finally {
      await app.close();
      db.close();
    }
  });
});
