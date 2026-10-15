import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeArkivClient,
  datesToTs,
  docIdFor,
  execTool,
  loadConfig,
  type ArkivClient,
  type ArkivEntityRecord,
  type Config,
} from '@chronicle/core';
import { buildDemoApp } from '@chronicle/demo-site';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WalletError, startWatcher } from '../src/run.js';
import type { CheckOutcome } from '../src/watcher.js';
import { silentLog } from './helpers.js';

const popplerInstalled = await execTool('pdftotext', ['-v'], 5000).then(
  () => true,
  () => false,
);
// CI installs poppler-utils, so a missing binary there must fail instead of skipping.
const withPdf = popplerInstalled || process.env.CI === 'true';

const T0 = 1_800_000_000;
const HOUR = 3600;

function writeWatchlist(dir: string, items: unknown[]): string {
  const path = join(dir, 'watchlist.json');
  writeFileSync(path, JSON.stringify({ version: 1, items }));
  return path;
}

function demoItem(base: string, id: string, pdf: boolean): unknown {
  return {
    notice_id: `demo-${id}`,
    department: 'demo-dept',
    scheme: 'demo-scheme',
    lang: 'en',
    sources: [
      {
        url: `${base}/circulars/${id}`,
        kind: 'page',
        content_selector: 'main',
        must_contain: ['circular no.'],
        poll_hours: 1,
      },
      ...(pdf ? [{ url: `${base}/circulars/${id}.pdf`, kind: 'pdf', poll_hours: 1 }] : []),
    ],
  };
}

function config(dir: string, extra: Record<string, string> = {}): Config {
  return loadConfig({
    ARKIV_MODE: 'fake',
    VANTAGE: 'test-vantage',
    WATCHLIST_PATH: 'watchlist.json',
    DATA_DIR: 'data',
    REQUEST_DELAY_MS_PER_HOST: '0',
    FETCH_TIMEOUT_MS: '10000',
    ...extra,
  });
}

async function byType(arkiv: ArkivClient, type: string): Promise<ArkivEntityRecord[]> {
  return (await arkiv.query({ where: [{ attr: 'type', op: 'eq', value: type }], limit: 200 })).items;
}

describe('watcher against the demo site (fake Arkiv)', () => {
  let app: ReturnType<typeof buildDemoApp>['app'];
  let state: ReturnType<typeof buildDemoApp>['state'];
  let base: string;

  beforeAll(async () => {
    ({ app, state } = buildDemoApp({ adminToken: 'test-token' }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('meets the Stage 4 acceptance flow', { timeout: 60_000 }, async () => {
    state.reset();
    const dir = mkdtempSync(join(tmpdir(), 'chronicle-watcher-'));
    writeWatchlist(dir, [demoItem(base, '001', withPdf), demoItem(base, '002', false)]);
    const arkiv = new FakeArkivClient();
    const perRun = withPdf ? 3 : 2;

    const pass = async (now: number): Promise<CheckOutcome[]> => {
      const h = await startWatcher({
        config: config(dir),
        baseDir: dir,
        once: true,
        log: silentLog,
        arkiv,
        llm: null,
        now: () => now,
      });
      return h.outcomes;
    };
    const states = (outcomes: CheckOutcome[]): string[] =>
      outcomes.map((o) => `${o.noticeId}:${o.status}:${o.state ?? '-'}`).sort();
    const latest = async (url: string): Promise<ArkivEntityRecord | undefined> =>
      (await byType(arkiv, 'observation')).filter((e) => e.attributes.doc_id === docIdFor(url)).at(-1);
    const page1 = `${base}/circulars/001`;

    // 1. first run: one doc and one first_seen observation per source
    let out = await pass(T0);
    expect(out.every((o) => o.status === 'written' && o.state === 'first_seen')).toBe(true);
    expect(await byType(arkiv, 'doc')).toHaveLength(perRun);
    expect(await byType(arkiv, 'observation')).toHaveLength(perRun);
    const first = await latest(page1);
    expect(first?.attributes).toMatchObject({ deadline_date: '2026-10-30', amount_paise: 150_000, severity: 0 });
    expect(JSON.stringify(first?.payload)).not.toContain('eligible');

    // 2. second run within the heartbeat: nothing written, and the visitor counters did not count as a change
    out = await pass(T0 + 60);
    expect(out.every((o) => o.status === 'skipped' && o.state === 'present')).toBe(true);
    expect(await byType(arkiv, 'observation')).toHaveLength(perRun);

    // 3. edit_deadline: changed with the new deadline and severity >= 2
    state.mutate({ id: '001', action: 'edit_deadline', value: '2026-11-20' });
    out = await pass(T0 + 120);
    expect(states(out)).toEqual(
      [...(withPdf ? ['demo-001:written:changed'] : []), 'demo-001:written:changed', 'demo-002:skipped:present'].sort(),
    );
    const changed = await latest(page1);
    expect(changed?.attributes).toMatchObject({ state: 'changed', deadline_ts: datesToTs('2026-11-20') });
    expect(Number(changed?.attributes.severity)).toBeGreaterThanOrEqual(2);
    expect(await byType(arkiv, 'doc')).toHaveLength(perRun);

    // 4. remove_404: removed_404 once, then no duplicate within the heartbeat
    state.mutate({ id: '001', action: 'remove_404' });
    out = await pass(T0 + 180);
    expect(
      out.filter((o) => o.noticeId === 'demo-001').every((o) => o.state === 'removed_404' && o.status === 'written'),
    ).toBe(true);
    expect((await latest(page1))?.attributes).toMatchObject({ state: 'removed_404', severity: 3, http_status: 404 });
    out = await pass(T0 + 240);
    expect(out.every((o) => o.status === 'skipped')).toBe(true);

    // 5. restore: present is written right away because the notice came back
    state.mutate({ id: '001', action: 'restore' });
    out = await pass(T0 + 300);
    expect(
      out.filter((o) => o.noticeId === 'demo-001').every((o) => o.state === 'present' && o.status === 'written'),
    ).toBe(true);

    // 6. soft_remove
    state.mutate({ id: '001', action: 'soft_remove' });
    out = await pass(T0 + 360);
    expect(
      out.filter((o) => o.noticeId === 'demo-001').every((o) => o.state === 'soft_removed' && o.status === 'written'),
    ).toBe(true);
    expect((await latest(page1))?.attributes).toMatchObject({ state: 'soft_removed', http_status: 200, severity: 3 });

    // 7. redirect
    state.mutate({ id: '001', action: 'restore' });
    state.mutate({ id: '001', action: 'redirect' });
    out = await pass(T0 + 420);
    expect(
      out.filter((o) => o.noticeId === 'demo-001').every((o) => o.state === 'redirected' && o.status === 'written'),
    ).toBe(true);
    expect((await latest(page1))?.attributes).toMatchObject({ state: 'redirected', redirect_chain_len: 1 });
    expect((await latest(page1))?.payload).toMatchObject({ final_url: `${base}/circulars/` });

    // 8. heartbeat after HEARTBEAT_HOURS
    state.mutate({ id: '001', action: 'restore' });
    await pass(T0 + 480);
    out = await pass(T0 + 25 * HOUR);
    expect(out.every((o) => o.status === 'written' && o.state === 'present')).toBe(true);
  });

  it('writes nothing and fetches only robots.txt when robots.txt disallows us', async () => {
    const requests: string[] = [];
    const server: Server = createServer((req, res) => {
      requests.push(req.url ?? '');
      if (req.url === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('User-agent: ChronicleWatcher\nDisallow: /\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<main>should not be fetched</main>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const dir = mkdtempSync(join(tmpdir(), 'chronicle-watcher-'));
      writeWatchlist(dir, [demoItem(host, '001', true)]);
      const arkiv = new FakeArkivClient();
      const h = await startWatcher({ config: config(dir), baseDir: dir, once: true, log: silentLog, arkiv, llm: null });
      expect(h.outcomes.map((o) => o.status)).toEqual(['blocked_by_robots', 'blocked_by_robots']);
      expect(requests).toEqual(['/robots.txt']);
      expect(arkiv.network.entities.size).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('startWatcher', () => {
  it('refuses to start with a zero balance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronicle-watcher-'));
    writeWatchlist(dir, []);
    const arkiv = new FakeArkivClient();
    arkiv.network.balances.set(arkiv.address(), 0n);
    await expect(
      startWatcher({ config: config(dir), baseDir: dir, once: true, log: silentLog, arkiv }),
    ).rejects.toThrow(/zero balance.*faucet/);
  });

  it('refuses to start without a wallet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronicle-watcher-'));
    writeWatchlist(dir, []);
    const readOnly = Object.assign(Object.create(new FakeArkivClient()) as FakeArkivClient, { address: () => null });
    await expect(
      startWatcher({ config: config(dir), baseDir: dir, once: true, log: silentLog, arkiv: readOnly }),
    ).rejects.toThrow(WalletError);
  });

  it('runs as a service with a health endpoint and stops cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronicle-watcher-'));
    writeWatchlist(dir, []);
    const h = await startWatcher({
      config: config(dir, { GROQ_API_KEY: 'test-key-not-used' }),
      baseDir: dir,
      once: false,
      log: silentLog,
      healthPort: 0,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${h.health?.port}/health`);
      expect(await res.json()).toMatchObject({ ok: true, source_count: 0, vantage: 'test-vantage' });
    } finally {
      await h.stop();
    }
  });
});
