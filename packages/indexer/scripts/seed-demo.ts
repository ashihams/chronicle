/**
 * Stage 9: drive the synthetic demo through first_seen → deadline edit → soft_remove → restore
 * with two wallets / vantages on one fake Arkiv chain, then print mirror counts.
 *
 *   pnpm build && pnpm seed:demo
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeArkivClient, FakeArkivNetwork, loadConfig } from '@chronicle/core';
import { buildDemoApp } from '@chronicle/demo-site';
import { startWatcher } from '@chronicle/watcher';
import { pino } from 'pino';
import { IndexerDb } from '../src/db.js';
import { Indexer } from '../src/indexer.js';

const log = pino({ name: 'seed-demo' });
const ADDR_A = '0x00000000000000000000000000000000000000aa';
const ADDR_B = '0x00000000000000000000000000000000000000bb';

function watchlistDir(base: string, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `chronicle-seed-${label}-`));
  const item = (id: string): unknown => ({
    notice_id: `demo-${id}`,
    department: 'demo-dept',
    scheme: 'demo-scheme',
    lang: 'en',
    sources: [
      {
        url: `${base}/circulars/${id}`,
        kind: 'page',
        content_selector: 'main',
        poll_hours: 1,
      },
    ],
  });
  writeFileSync(join(dir, 'watchlist.json'), JSON.stringify({ version: 1, items: [item('001'), item('002')] }));
  return dir;
}

async function main(): Promise<void> {
  let t = Math.floor(Date.now() / 1000);
  const network = new FakeArkivNetwork({ clock: () => t });
  const watcherA = new FakeArkivClient(ADDR_A, network);
  const watcherB = new FakeArkivClient(ADDR_B, network);

  const demo = buildDemoApp({ adminToken: 'seed-token', logger: false });
  await demo.app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(demo.app.server.address() as AddressInfo).port}`;
  const dirs = { a: watchlistDir(base, 'a'), b: watchlistDir(base, 'b') };

  const pass = async (label: 'a' | 'b', arkiv: FakeArkivClient): Promise<void> => {
    const config = loadConfig({
      ARKIV_MODE: 'fake',
      VANTAGE: label === 'a' ? 'seed-vps-a' : 'seed-vps-b',
      WATCHLIST_PATH: 'watchlist.json',
      DATA_DIR: 'data',
      REQUEST_DELAY_MS_PER_HOST: '0',
    });
    const handle = await startWatcher({
      config,
      baseDir: dirs[label],
      once: true,
      log: log.child({ watcher: label }),
      arkiv,
      llm: null,
      now: () => t,
    });
    const written = handle.outcomes.filter((o) => o.status === 'written').length;
    log.info({ label, checks: handle.outcomes.length, written }, 'pass done');
  };

  log.info({ base }, 'seed: first_seen from two vantages');
  await pass('a', watcherA);
  t += 60;
  await pass('b', watcherB);

  t += 120;
  demo.state.mutate({ id: '001', action: 'edit_deadline', value: '2026-11-20' });
  log.info('seed: deadline edit');
  await pass('a', watcherA);
  t += 60;
  await pass('b', watcherB);

  t += 120;
  demo.state.mutate({ id: '001', action: 'soft_remove' });
  log.info('seed: soft_remove');
  await pass('a', watcherA);
  t += 60;
  await pass('b', watcherB);

  t += 120;
  demo.state.mutate({ id: '001', action: 'restore' });
  log.info('seed: restore');
  await pass('a', watcherA);
  t += 60;
  await pass('b', watcherB);

  const db = new IndexerDb(':memory:');
  const indexer = new Indexer(
    new FakeArkivClient('0x00000000000000000000000000000000000000ff', network),
    db,
    { disagreeWindowMinutes: 30, backdateDays: 7, clockSkewSeconds: 3600 },
    log.child({ part: 'indexer' }),
  );
  await indexer.sync();

  const docs = db.listDocs({ limit: 50, offset: 0 });
  const entities = await watcherA.query({ where: [{ attr: 'type', op: 'eq', value: 'observation' }], limit: 200 });
  log.info(
    {
      docs: docs.total,
      observations: entities.items.length,
      creators: [ADDR_A, ADDR_B],
    },
    'seed:demo complete (fake chain; use live wallets for a shared public demo)',
  );

  await demo.app.close();
  db.close();
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, 'seed:demo failed');
  process.exitCode = 1;
});
