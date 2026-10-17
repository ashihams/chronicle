import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ArkivClient, Config } from '@chronicle/core';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { buildApi } from './api.js';
import { IndexerDb } from './db.js';
import { Indexer } from './indexer.js';

/** Runs `task` now and then every `intervalMs` after the previous run ends; runs never overlap. */
export class Loop {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private stopped = false;
  private again = false;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly task: () => Promise<unknown>,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.trigger();
  }

  /** Runs as soon as possible; if a run is in progress, one more run follows it. */
  trigger(): void {
    if (this.stopped) return;
    if (this.running !== null) {
      this.again = true;
      return;
    }
    clearTimeout(this.timer);
    this.running = (async () => {
      try {
        await this.task();
      } catch (err) {
        this.log.warn({ loop: this.name, err: err instanceof Error ? err.message : String(err) }, 'loop run failed');
      } finally {
        this.running = null;
        if (!this.stopped) {
          if (this.again) {
            this.again = false;
            this.trigger();
          } else {
            this.timer = setTimeout(() => this.trigger(), this.intervalMs);
          }
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
}

export interface IndexerHandle {
  app: FastifyInstance;
  indexer: Indexer;
  db: IndexerDb;
  address: string;
  stop(): Promise<void>;
}

export interface StartIndexerOptions {
  config: Config;
  arkiv: ArkivClient;
  log: Logger;
  dbPath?: string;
  port?: number;
  host?: string;
  webDist?: string;
}

/**
 * Starts the API, the sync loop (polling is the source of truth), the liveness loop and, when the
 * client supports it, an event subscription that only triggers an early sync.
 */
export async function startIndexer(o: StartIndexerOptions): Promise<IndexerHandle> {
  const s = o.config.indexer;
  const dbPath = o.dbPath ?? s.dbPath;
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new IndexerDb(dbPath);
  const indexer = new Indexer(o.arkiv, db, s, o.log);
  const app = buildApi({
    db,
    arkiv: o.arkiv,
    explorerBase: o.config.arkiv.explorerBase,
    log: o.log,
    ...(o.webDist !== undefined && { webDist: o.webDist }),
  });

  const syncLoop = new Loop('sync', s.syncIntervalSeconds * 1000, () => indexer.sync(), o.log);
  const livenessLoop = new Loop('liveness', s.livenessIntervalMinutes * 60_000, () => indexer.liveness(), o.log);

  let unsubscribe: (() => void) | null = null;
  if (o.arkiv.subscribe !== undefined) {
    try {
      unsubscribe = await o.arkiv.subscribe(() => syncLoop.trigger());
    } catch (err) {
      o.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'event subscription unavailable; polling only',
      );
    }
  }

  const address = await app.listen({ port: o.port ?? s.port, host: o.host ?? '0.0.0.0' });
  o.log.info({ address }, 'indexer API listening');
  syncLoop.start();
  livenessLoop.start();

  return {
    app,
    indexer,
    db,
    address,
    async stop() {
      unsubscribe?.();
      await Promise.all([syncLoop.stop(), livenessLoop.stop()]);
      await app.close();
      db.close();
    },
  };
}
