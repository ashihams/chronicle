import { describe, expect, it } from 'vitest';
import { startHealthServer } from '../src/health.js';

describe('startHealthServer', () => {
  it('serves GET /health and 404 elsewhere', async () => {
    const server = await startHealthServer({
      port: 0,
      host: '127.0.0.1',
      status: () => ({ last_pass_ts: 123, source_count: 2, wallet_address: '0xabc', vantage: 'test-vantage' }),
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const ok = await fetch(`${base}/health?x=1`);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({
        ok: true,
        last_pass_ts: 123,
        source_count: 2,
        wallet_address: '0xabc',
        vantage: 'test-vantage',
      });
      expect((await fetch(`${base}/other`)).status).toBe(404);
      expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('rejects when the port is taken', async () => {
    const first = await startHealthServer({
      port: 0,
      host: '127.0.0.1',
      status: () => ({ last_pass_ts: null, source_count: 0, wallet_address: null, vantage: 'v' }),
    });
    try {
      await expect(
        startHealthServer({
          port: first.port,
          host: '127.0.0.1',
          status: () => ({ last_pass_ts: null, source_count: 0, wallet_address: null, vantage: 'v' }),
        }),
      ).rejects.toThrow();
    } finally {
      await first.close();
    }
  });
});
