/**
 * Local demo without a wallet: the demo site, one watcher and the indexer API in a single process,
 * sharing one in-memory Arkiv chain (`ARKIV_MODE=fake` chains cannot be shared between processes).
 *
 *   pnpm build && pnpm dev:fake
 *
 * Then open http://localhost:8080/api/docs and change a notice through the demo admin endpoint;
 * the watcher sees it on its next scheduled check. Restarting starts from an empty chain.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeArkivClient, FakeArkivNetwork, loadConfig } from '@chronicle/core';
import { buildDemoApp } from '@chronicle/demo-site';
import { startWatcher } from '@chronicle/watcher';
import { pino } from 'pino';
import { startIndexer } from '../src/service.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
try {
  process.loadEnvFile(join(repoRoot, '.env'));
} catch {
  // no .env file: rely on the environment
}

const log = pino({ name: 'dev-fake' });
const config = loadConfig({ ...process.env, ARKIV_MODE: 'fake' });

const network = new FakeArkivNetwork({ clock: () => Date.now() / 1000 });
const watcherClient = new FakeArkivClient('0x000000000000000000000000000000000000a11c', network);
const readerClient = new FakeArkivClient('0x00000000000000000000000000000000000000ff', network);

const demo = buildDemoApp({ adminToken: config.demo.adminToken });
await demo.app.listen({ port: config.demo.port, host: '127.0.0.1' });
log.info({ port: config.demo.port }, 'demo site listening');

const indexer = await startIndexer({
  config,
  arkiv: readerClient,
  log: log.child({ part: 'indexer' }),
  dbPath: ':memory:',
  host: '127.0.0.1',
  webDist: join(repoRoot, 'packages', 'web', 'dist'),
});

const watcher = await startWatcher({
  config,
  baseDir: repoRoot,
  once: false,
  log: log.child({ part: 'watcher' }),
  arkiv: watcherClient,
  dbPath: join(mkdtempSync(join(tmpdir(), 'chronicle-dev-fake-')), 'watcher.db'),
});

const shutdown = (signal: string): void => {
  log.info({ signal }, 'shutting down');
  void Promise.all([watcher.stop(), indexer.stop(), demo.app.close()]).then(() => process.exit(0));
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
