import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  GroqLlmClient,
  RULES_MODEL,
  createArkivClient,
  type ArkivClient,
  type Config,
  type ExecTool,
  type LlmClient,
} from '@chronicle/core';
import type { Logger } from 'pino';
import { WatcherDb } from './db.js';
import { createExtractor } from './extractor.js';
import type { FetchFn } from './fetcher.js';
import { startHealthServer, type HealthServer } from './health.js';
import { Scheduler } from './scheduler.js';
import { serializeWrites } from './serial.js';
import { Watcher, type CheckOutcome } from './watcher.js';
import { enabledSources, loadWatchlist } from './watchlist.js';

export const FAUCET_NOTE =
  'Fund the wallet from the Tiramisu testnet faucet (linked from hub.arkiv.network and docs.arkiv.network), then restart.';

export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

export interface StartOptions {
  config: Config;
  /** Relative WATCHLIST_PATH and DATA_DIR are resolved against this directory. */
  baseDir: string;
  once: boolean;
  log: Logger;
  arkiv?: ArkivClient;
  fetch?: FetchFn;
  /** `null` forces the rule-based extractor; undefined uses Groq when GROQ_API_KEY is set. */
  llm?: LlmClient | null;
  /** Defaults to DATA_DIR/watcher.db. */
  dbPath?: string;
  /** Defaults to WATCHER_HEALTH_PORT; 0 picks a free port. */
  healthPort?: number;
  now?: () => number;
  pdfExec?: ExecTool;
}

export interface WatcherHandle {
  /** Outcomes of the single pass in `once` mode; empty otherwise. */
  outcomes: CheckOutcome[];
  health: HealthServer | null;
  stop(): Promise<void>;
}

function under(baseDir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(baseDir, p);
}

/**
 * Section 4.2: loads the watchlist, checks the wallet, then either runs one pass (`once`) or starts
 * the scheduler and the health server.
 */
export async function startWatcher(opts: StartOptions): Promise<WatcherHandle> {
  const { config, log } = opts;
  const w = config.watcher;
  const now = opts.now ?? ((): number => Math.floor(Date.now() / 1000));

  const watchlist = await loadWatchlist({
    path: under(opts.baseDir, w.watchlistPath),
    url: w.watchlistUrl,
    ...(opts.fetch && { fetch: opts.fetch }),
  });
  const sources = enabledSources(watchlist, w.pollHoursDefault);

  const arkiv = serializeWrites(opts.arkiv ?? createArkivClient(config));
  const address = arkiv.address();
  if (address === null) throw new WalletError('No wallet: set WATCHER_PRIVATE_KEY in the environment.');
  const balance = await arkiv.balance();
  log.info(
    { address, balanceWei: balance.toString(), vantage: w.vantage, mode: config.arkiv.mode, sources: sources.length },
    'watcher starting',
  );
  if (balance === 0n) throw new WalletError(`Wallet ${address} has a zero balance. ${FAUCET_NOTE}`);
  if (config.arkiv.mode === 'fake') {
    log.warn('ARKIV_MODE=fake: entities live in this process only; local state persists in the watcher DB');
  }

  let dbPath = opts.dbPath;
  if (dbPath === undefined) {
    const dataDir = under(opts.baseDir, w.dataDir);
    mkdirSync(dataDir, { recursive: true });
    dbPath = join(dataDir, 'watcher.db');
  }
  const db = new WatcherDb(dbPath);

  const llm =
    opts.llm !== undefined
      ? opts.llm
      : config.llm.groqApiKey
        ? new GroqLlmClient({ apiKey: config.llm.groqApiKey, model: config.llm.model })
        : null;
  log.info({ extractor: llm?.model ?? RULES_MODEL }, 'extractor selected');

  const watcher = new Watcher({
    settings: w,
    arkiv,
    db,
    extractor: createExtractor(llm),
    log,
    now,
    ...(opts.fetch && { fetch: opts.fetch }),
    ...(opts.pdfExec && { pdfExec: opts.pdfExec }),
  });

  if (opts.once) {
    try {
      const outcomes = await Promise.all(sources.map((s) => watcher.safeCheck(s)));
      await watcher.renewIfDue();
      return { outcomes, health: null, stop: async () => undefined };
    } finally {
      db.close();
    }
  }

  let lastPassTs: number | null = null;
  const scheduler = new Scheduler({
    sources,
    check: (s) => watcher.safeCheck(s),
    onCheck: () => {
      lastPassTs = now();
    },
    onIdle: async () => {
      await watcher.renewIfDue();
    },
  });
  const health = await startHealthServer({
    port: opts.healthPort ?? w.healthPort,
    status: () => ({
      last_pass_ts: lastPassTs,
      source_count: sources.length,
      wallet_address: address,
      vantage: w.vantage,
    }),
  });
  log.info({ port: health.port }, 'health server listening');
  void scheduler.start().then(() => log.info('first pass done'));

  return {
    outcomes: [],
    health,
    stop: async () => {
      await scheduler.stop();
      await health.close();
      db.close();
    },
  };
}
