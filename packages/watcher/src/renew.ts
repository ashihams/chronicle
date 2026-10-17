import { BLOCK_TIME_SECONDS, type ArkivClient } from '@chronicle/core';
import type { Logger } from 'pino';

export const RENEW_INTERVAL_SECONDS = 24 * 3600;
export const LAST_RENEW_META_KEY = 'last_renew_ts';

export interface RenewOptions {
  arkiv: ArkivClient;
  keys: string[];
  ttlSeconds: number;
  renewWhenSecondsLeft: number;
  log: Logger;
  blockTimeSeconds?: number;
}

export interface RenewSummary {
  extended: number;
  /** Not ours, already expired, or with enough time left. */
  skipped: number;
  failed: number;
}

/** Extends each owned entity whose remaining lifetime is below the threshold. Never throws. */
export async function renewEntities(opts: RenewOptions): Promise<RenewSummary> {
  const summary: RenewSummary = { extended: 0, skipped: 0, failed: 0 };
  const me = opts.arkiv.address();
  const blockTime = opts.blockTimeSeconds ?? BLOCK_TIME_SECONDS;
  for (const key of new Set(opts.keys)) {
    try {
      const e = await opts.arkiv.getEntity(key);
      if (e === null || e.expiresAtBlock === null || me === null || e.owner !== me) {
        summary.skipped += 1;
        continue;
      }
      const head = await opts.arkiv.currentBlock();
      const secondsLeft = Number(e.expiresAtBlock - head) * blockTime;
      if (secondsLeft >= opts.renewWhenSecondsLeft) {
        summary.skipped += 1;
        continue;
      }
      const res = await opts.arkiv.extendEntity(key, opts.ttlSeconds);
      summary.extended += 1;
      opts.log.info({ key, txHash: res.txHash, expiresAtBlock: res.expiresAtBlock.toString() }, 'entity extended');
    } catch (err) {
      summary.failed += 1;
      opts.log.warn({ key, err: err instanceof Error ? err.message : String(err) }, 'entity extension failed');
    }
  }
  return summary;
}
