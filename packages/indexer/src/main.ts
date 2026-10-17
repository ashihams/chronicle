import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';
import { ConfigError, createArkivClient, loadConfig } from '@chronicle/core';
import { pino } from 'pino';
import { startIndexer } from './service.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
try {
  process.loadEnvFile(join(repoRoot, '.env'));
} catch {
  // no .env file: rely on the environment
}

const log = pino({ name: 'indexer' });

try {
  const config = loadConfig(process.env);
  if (config.arkiv.mode === 'fake') {
    log.warn('ARKIV_MODE=fake: this process has its own empty in-memory chain; use `pnpm dev:fake` for a demo');
  }
  const arkiv = createArkivClient(config, { privateKey: null });
  const dbPath = isAbsolute(config.indexer.dbPath) ? config.indexer.dbPath : join(repoRoot, config.indexer.dbPath);
  const handle = await startIndexer({
    config,
    arkiv,
    log,
    dbPath,
    webDist: join(repoRoot, 'packages', 'web', 'dist'),
  });
  const shutdown = (signal: string): void => {
    log.info({ signal }, 'shutting down');
    void handle.stop().then(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
} catch (err) {
  if (err instanceof ConfigError) {
    log.error(err.message);
  } else {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'indexer failed to start');
  }
  process.exitCode = 1;
}
