import { loadConfig } from '@chronicle/core';
import { describe, expect, it } from 'vitest';
import { Loop, startIndexer } from '../src/service.js';
import { Chain, H, silentLog } from './helpers.js';

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('Loop', () => {
  it('never overlaps runs and coalesces triggers into one more run', async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    let release: () => void = () => {};
    const loop = new Loop(
      'test',
      60_000,
      async () => {
        runs += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((r) => (release = r));
        active -= 1;
      },
      silentLog,
    );
    loop.start();
    loop.trigger();
    loop.trigger();
    await tick();
    expect(runs).toBe(1);
    release();
    await tick();
    expect(runs).toBe(2);
    release();
    await tick();
    expect(runs).toBe(2);
    expect(maxActive).toBe(1);
    await loop.stop();
    loop.trigger();
    expect(runs).toBe(2);
  });

  it('keeps going after a failed run', async () => {
    let runs = 0;
    const loop = new Loop(
      'test',
      1,
      async () => {
        runs += 1;
        throw new Error('boom');
      },
      silentLog,
    );
    loop.start();
    await tick(30);
    await loop.stop();
    expect(runs).toBeGreaterThan(1);
  });
});

describe('startIndexer', () => {
  it('serves the API, syncs on events and stops cleanly', async () => {
    const chain = new Chain();
    await chain.observe(chain.a, { hash: H(1) });
    const config = loadConfig({ ARKIV_MODE: 'fake', SYNC_INTERVAL_SECONDS: '3600' });
    const h = await startIndexer({
      config,
      arkiv: chain.a,
      log: silentLog,
      dbPath: ':memory:',
      port: 0,
      host: '127.0.0.1',
    });
    try {
      for (let i = 0; i < 50 && h.db.entityCount() < 1; i++) await tick(10);
      expect(h.db.entityCount()).toBe(1);

      // the subscription triggers an early sync long before the hourly poll
      await chain.observe(chain.b, { hash: H(1) });
      for (let i = 0; i < 50 && h.db.entityCount() < 2; i++) await tick(10);
      expect(h.db.entityCount()).toBe(2);

      const res = await fetch(`${h.address}/api/health`);
      expect(await res.json()).toMatchObject({ ok: true, entityCount: 2 });
    } finally {
      await h.stop();
    }
  });
});
