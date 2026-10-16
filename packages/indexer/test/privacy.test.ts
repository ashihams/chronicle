import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeArkivClient, FakeArkivNetwork, loadConfig, type Attrs } from '@chronicle/core';
import { buildDemoApp } from '@chronicle/demo-site';
import { startWatcher } from '@chronicle/watcher';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADDR_A, silentLog } from './helpers.js';

/**
 * Patterns that must never appear in Arkiv attributes or payloads.
 * Avoid bare `\d{10}` — unix timestamps are 10 digits.
 */
const FORBIDDEN: RegExp[] = [
  /\b[6-9]\d{9}\b/, // Indian-style mobile
  /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/,
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  /\bchat\b/i,
];

function scanValue(label: string, value: unknown, hits: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const s = String(value);
    for (const re of FORBIDDEN) {
      if (re.test(s)) hits.push(`${label}: ${re} matched in ${JSON.stringify(s).slice(0, 120)}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanValue(`${label}[${i}]`, v, hits));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      scanValue(`${label}.${k}`, v, hits);
    }
  }
}

function scanEntity(key: string, attrs: Attrs, payload: unknown, hits: string[]): void {
  scanValue(`${key}.attrs`, attrs, hits);
  scanValue(`${key}.payload`, payload, hits);
}

describe('privacy: Arkiv payloads from a fake watcher run', () => {
  let demo: ReturnType<typeof buildDemoApp>;
  let base: string;

  beforeAll(async () => {
    demo = buildDemoApp({ adminToken: 'privacy-token' });
    await demo.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(demo.app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await demo.app.close();
  });

  it('stores no phones, emails, chat ids, or document body text on chain', { timeout: 60_000 }, async () => {
    demo.state.reset();
    let t = Math.floor(Date.now() / 1000);
    const network = new FakeArkivNetwork({ clock: () => t });
    const arkiv = new FakeArkivClient(ADDR_A, network);
    const dir = mkdtempSync(join(tmpdir(), 'chronicle-privacy-'));
    writeFileSync(
      join(dir, 'watchlist.json'),
      JSON.stringify({
        version: 1,
        items: [
          {
            notice_id: 'demo-001',
            department: 'demo-dept',
            scheme: 'demo-scheme',
            lang: 'en',
            sources: [
              {
                url: `${base}/circulars/001`,
                kind: 'page',
                content_selector: 'main',
                poll_hours: 1,
              },
            ],
          },
        ],
      }),
    );

    const config = loadConfig({
      ARKIV_MODE: 'fake',
      VANTAGE: 'privacy-vantage',
      WATCHLIST_PATH: 'watchlist.json',
      DATA_DIR: 'data',
      REQUEST_DELAY_MS_PER_HOST: '0',
    });
    await startWatcher({
      config,
      baseDir: dir,
      once: true,
      log: silentLog,
      arkiv,
      llm: null,
      now: () => t,
    });
    t += 120;
    demo.state.mutate({ id: '001', action: 'edit_deadline', value: '2026-11-20' });
    await startWatcher({
      config,
      baseDir: dir,
      once: true,
      log: silentLog,
      arkiv,
      llm: null,
      now: () => t,
    });

    const docs = await arkiv.query({
      where: [{ attr: 'type', op: 'eq', value: 'doc' }],
      limit: 200,
    });
    const obs = await arkiv.query({
      where: [{ attr: 'type', op: 'eq', value: 'observation' }],
      limit: 200,
    });
    const entities = [...docs.items, ...obs.items];
    expect(entities.length).toBeGreaterThan(0);

    const hits: string[] = [];
    for (const ent of entities) {
      scanEntity(ent.key, ent.attributes, ent.payload, hits);
      const blob = JSON.stringify({ attrs: ent.attributes, payload: ent.payload });
      // Demo HTML banner / body must never be copied onto the chain.
      expect(blob).not.toMatch(/DEMONSTRATION: synthetic notice/i);
      expect(blob).not.toMatch(/Demo Government Portal \(synthetic\)/i);
      expect(blob).not.toMatch(/By order, Demo Secretary/i);
    }

    expect(hits, hits.join('\n')).toEqual([]);
  });
});
