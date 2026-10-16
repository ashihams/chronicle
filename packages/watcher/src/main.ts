import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '@chronicle/core';
import { pino } from 'pino';
import { ProductionWatchlistError, WalletError, startWatcher } from './run.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
try {
  process.loadEnvFile(join(repoRoot, '.env'));
} catch {
  // no .env file: rely on the environment
}

const log = pino({ name: 'watcher' });
const once = process.argv.slice(2).includes('--once');

try {
  const config = loadConfig(process.env);
  if (config.arkiv.mode === 'live' && config.watcher.privateKey === undefined) {
    throw new ConfigError(['WATCHER_PRIVATE_KEY: required in live mode']);
  }
  const handle = await startWatcher({ config, baseDir: repoRoot, once, log });
  if (once) {
    const errors = handle.outcomes.filter((o) => o.status === 'error').length;
    log.info(
      { checks: handle.outcomes.length, written: handle.outcomes.filter((o) => o.status === 'written').length, errors },
      'single pass done',
    );
    process.exitCode = errors > 0 ? 1 : 0;
  } else {
    const shutdown = (signal: string): void => {
      log.info({ signal }, 'shutting down');
      void handle.stop().then(() => process.exit(0));
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  }
} catch (err) {
  if (err instanceof ConfigError || err instanceof WalletError || err instanceof ProductionWatchlistError) {
    log.error(err.message);
  } else {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'watcher failed to start');
  }
  process.exitCode = 1;
}
