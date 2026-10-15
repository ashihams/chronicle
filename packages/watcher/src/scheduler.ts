import type { CheckOutcome } from './watcher.js';
import type { WatchedSource } from './watchlist.js';

export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
export const JITTER = 0.1;

/** `pollHours` with uniform jitter of plus or minus 10 percent. `rand` returns [0, 1). */
export function jitteredDelayMs(pollHours: number, rand: () => number = Math.random): number {
  return Math.round(pollHours * 3600_000 * (1 - JITTER + 2 * JITTER * rand()));
}

/** 1 min, 5 min, then 30 min for every later consecutive failure. `attempt` starts at 1. */
export function backoffMs(attempt: number): number {
  const i = Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[i] ?? BACKOFF_MS[2];
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface SchedulerOptions {
  sources: WatchedSource[];
  check: (src: WatchedSource) => Promise<CheckOutcome>;
  /** Called after every completed check. */
  onCheck?: (outcome: CheckOutcome) => void;
  /** Called after each scheduler tick, e.g. for the daily renewal. */
  onIdle?: () => Promise<void>;
  rand?: () => number;
  timers?: Timers;
}

/** Runs every source immediately, then on its own jittered interval; failed checks back off. */
export class Scheduler {
  private readonly handles = new Map<string, unknown>();
  private readonly failures = new Map<string, number>();
  private readonly inFlight = new Set<Promise<void>>();
  private stopped = false;
  private readonly timers: Timers;

  constructor(private readonly opts: SchedulerOptions) {
    this.timers = opts.timers ?? realTimers;
  }

  /** Starts the loop and resolves when the first pass over all sources has finished. */
  async start(): Promise<void> {
    await Promise.all(this.opts.sources.map((s) => this.run(s)));
  }

  /** Cancels pending timers and waits for running checks. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const h of this.handles.values()) this.timers.clearTimeout(h);
    this.handles.clear();
    await Promise.all([...this.inFlight]);
  }

  /** Next delay for a source after a check, exposed for tests. */
  nextDelayMs(src: WatchedSource, outcome: CheckOutcome): number {
    if (!outcome.retry) {
      this.failures.delete(src.docId);
      return jitteredDelayMs(src.pollHours, this.opts.rand);
    }
    const attempt = (this.failures.get(src.docId) ?? 0) + 1;
    this.failures.set(src.docId, attempt);
    return backoffMs(attempt);
  }

  private run(src: WatchedSource): Promise<void> {
    const p = (async (): Promise<void> => {
      const outcome = await this.opts.check(src);
      this.opts.onCheck?.(outcome);
      try {
        if (this.opts.onIdle) await this.opts.onIdle();
      } catch {
        // onIdle reports its own errors; the source keeps its schedule
      }
      if (this.stopped) return;
      const delay = this.nextDelayMs(src, outcome);
      this.handles.set(
        src.docId,
        this.timers.setTimeout(() => {
          this.handles.delete(src.docId);
          if (!this.stopped) void this.run(src);
        }, delay),
      );
    })();
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
    return p;
  }
}
