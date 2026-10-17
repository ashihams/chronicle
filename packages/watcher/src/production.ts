import type { WatchedSource } from './watchlist.js';

export class ProductionWatchlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductionWatchlistError';
  }
}

/** True when an enabled source looks like the synthetic demo watchlist. */
export function isDemoSource(s: WatchedSource): boolean {
  return s.noticeId.startsWith('demo-') || s.department.startsWith('demo-dept');
}

/**
 * In `NODE_ENV=production`, refuse enabled demo watchlist entries unless `ALLOW_DEMO=1`.
 * Local compose and acceptance smoke use `ALLOW_DEMO=1`.
 */
export function assertProductionWatchlist(sources: WatchedSource[], env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  if (env.ALLOW_DEMO === '1') return;
  const demos = sources.filter(isDemoSource);
  if (demos.length === 0) return;
  throw new ProductionWatchlistError(
    `Refusing ${demos.length} demo watchlist source(s) in production (e.g. ${demos[0]?.noticeId}). ` +
      'Point WATCHLIST_PATH / WATCHLIST_URL at real pages, or set ALLOW_DEMO=1 for a deliberate demo run.',
  );
}
