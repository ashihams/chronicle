import { describe, expect, it } from 'vitest';
import { BACKOFF_MS, Scheduler, backoffMs, jitteredDelayMs, type Timers } from '../src/scheduler.js';
import type { CheckOutcome } from '../src/watcher.js';
import type { WatchedSource } from '../src/watchlist.js';
import { source } from './helpers.js';

const HOUR = 3600_000;

function outcome(src: WatchedSource, retry: boolean): CheckOutcome {
  return {
    docId: src.docId,
    noticeId: src.noticeId,
    status: retry ? 'error' : 'skipped',
    state: null,
    reason: '',
    retry,
  };
}

/** Manual timers: `fire()` runs every pending callback once. */
function manualTimers(): Timers & { pending: Map<number, { fn: () => void; ms: number }>; fire(): void } {
  let next = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    pending,
    setTimeout(fn, ms) {
      next += 1;
      pending.set(next, { fn, ms });
      return next;
    },
    clearTimeout(h) {
      pending.delete(h as number);
    },
    fire() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, t] of due) t.fn();
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('jitteredDelayMs', () => {
  it('stays within plus or minus 10 percent', () => {
    expect(jitteredDelayMs(1, () => 0)).toBe(0.9 * HOUR);
    expect(jitteredDelayMs(1, () => 0.5)).toBe(HOUR);
    expect(jitteredDelayMs(1, () => 0.999999)).toBeLessThanOrEqual(1.1 * HOUR);
    for (let i = 0; i < 100; i++) {
      const d = jitteredDelayMs(6);
      expect(d).toBeGreaterThanOrEqual(0.9 * 6 * HOUR);
      expect(d).toBeLessThanOrEqual(1.1 * 6 * HOUR);
    }
  });
});

describe('backoffMs', () => {
  it('goes 1 min, 5 min, then 30 min', () => {
    expect([0, 1, 2, 3, 10].map(backoffMs)).toEqual([BACKOFF_MS[0], 60_000, 300_000, 1_800_000, 1_800_000]);
  });
});

describe('Scheduler', () => {
  it('runs every source at start, then on its own interval, backing off after failures', async () => {
    const a = source('http://site.test/a', 'page', { pollHours: 1 });
    const b = source('http://site.test/b', 'page', { pollHours: 2 });
    const results = new Map([
      [a.docId, [false, false]],
      [b.docId, [true, true, false]],
    ]);
    const seen: string[] = [];
    let idle = 0;
    const timers = manualTimers();
    const scheduler = new Scheduler({
      sources: [a, b],
      check: async (s) => outcome(s, results.get(s.docId)?.shift() ?? false),
      onCheck: (o) => seen.push(o.docId === a.docId ? 'a' : 'b'),
      onIdle: async () => {
        idle += 1;
        if (idle === 1) throw new Error('renewal failed');
      },
      rand: () => 0.5,
      timers,
    });
    await scheduler.start();
    expect(seen.sort()).toEqual(['a', 'b']);
    expect([...timers.pending.values()].map((t) => t.ms).sort((x, y) => x - y)).toEqual([60_000, HOUR]);

    timers.fire();
    await flush();
    expect([...timers.pending.values()].map((t) => t.ms).sort((x, y) => x - y)).toEqual([300_000, HOUR]);

    timers.fire();
    await flush();
    expect([...timers.pending.values()].map((t) => t.ms).sort((x, y) => x - y)).toEqual([HOUR, 2 * HOUR]);
    expect(seen).toHaveLength(6);
    expect(idle).toBe(6);

    await scheduler.stop();
    expect(timers.pending.size).toBe(0);
  });

  it('does not reschedule after stop', async () => {
    const a = source('http://site.test/a');
    const timers = manualTimers();
    let release: () => void = () => undefined;
    const scheduler = new Scheduler({
      sources: [a],
      check: (s) =>
        new Promise<CheckOutcome>((resolve) => {
          release = () => resolve(outcome(s, false));
        }),
      timers,
    });
    const started = scheduler.start();
    const stopped = scheduler.stop();
    release();
    await Promise.all([started, stopped]);
    expect(timers.pending.size).toBe(0);
  });

  it('uses real timers by default', async () => {
    const a = source('http://site.test/a');
    const scheduler = new Scheduler({ sources: [a], check: async (s) => outcome(s, false) });
    await scheduler.start();
    await scheduler.stop();
  });
});
