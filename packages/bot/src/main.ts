import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '@chronicle/core';
import { pino } from 'pino';
import { startBot } from './run.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
try {
  process.loadEnvFile(join(repoRoot, '.env'));
} catch {
  // no .env file: rely on the environment
}

const log = pino({ name: 'bot' });

try {
  const config = loadConfig(process.env);
  const handle = await startBot({ config, baseDir: repoRoot, log });
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
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'bot failed to start');
  }
  process.exitCode = 1;
}
