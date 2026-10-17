import {
  FakeArkivClient,
  FakeArkivNetwork,
  RULES_MODEL,
  datesToTs,
  type ArkivClient,
  type ArkivEntityRecord,
  type ExecTool,
  type LlmClient,
} from '@chronicle/core';
import { describe, expect, it } from 'vitest';
import { WatcherDb } from '../src/db.js';
import { createExtractor } from '../src/extractor.js';
import { LAST_RENEW_META_KEY } from '../src/renew.js';
import { Watcher } from '../src/watcher.js';
import type { WatchedSource } from '../src/watchlist.js';
import { SETTINGS, noticePage, silentLog, source, stubFetch, type StubResponse } from './helpers.js';

const URL_A = 'http://site.test/notices/1';
const T0 = 1_800_000_000;
const ROBOTS = { 'http://site.test/robots.txt': { status: 404 } };

interface Harness {
  watcher: Watcher;
  arkiv: FakeArkivClient;
  db: WatcherDb;
  setRoute(url: string, r: StubResponse | undefined): void;
  setNow(t: number): void;
  observations(): Promise<ArkivEntityRecord[]>;
}

function harness(opts: { llm?: LlmClient | null; pdfExec?: ExecTool; arkiv?: ArkivClient } = {}): Harness {
  const routes: Record<string, StubResponse> = { ...ROBOTS };
  const { fetch } = stubFetch(routes);
  const arkiv = new FakeArkivClient();
  const db = new WatcherDb(':memory:');
  let now = T0;
  const watcher = new Watcher({
    settings: SETTINGS,
    arkiv: opts.arkiv ?? arkiv,
    db,
    extractor: createExtractor(opts.llm ?? null),
    log: silentLog,
    fetch,
    now: () => now,
    ...(opts.pdfExec && { pdfExec: opts.pdfExec }),
  });
  return {
    watcher,
    arkiv,
    db,
    setRoute(url, r) {
      if (r === undefined) delete routes[url];
      else routes[url] = r;
    },
    setNow(t) {
      now = t;
    },
    async observations() {
      const res = await arkiv.query({ where: [{ attr: 'type', op: 'eq', value: 'observation' }], limit: 200 });
      return res.items;
    },
  };
}

const page = (opts: Parameters<typeof noticePage>[0] = {}): StubResponse => ({
  status: 200,
  body: noticePage(opts),
  headers: { 'content-type': 'text/html; charset=utf-8', 'last-modified': 'Wed, 01 Oct 2026 10:00:00 GMT' },
});

describe('Watcher.check', () => {
  it('writes first_seen with extracted fields and a doc, and never publishes document text', async () => {
    const h = harness();
    h.setRoute(URL_A, page());
    const src = source(URL_A);
    const out = await h.watcher.check(src);
    expect(out).toMatchObject({ status: 'written', state: 'first_seen', retry: false });

    const docs = await h.arkiv.query({ where: [{ attr: 'type', op: 'eq', value: 'doc' }] });
    expect(docs.items).toHaveLength(1);
    expect(docs.items[0]?.attributes).toMatchObject({
      doc_id: src.docId,
      notice_id: 'synthetic-001',
      source_kind: 'page',
    });
    expect(docs.items[0]?.payload).toMatchObject({
      registered_vantage: 'test-vantage',
      title: 'Synthetic notice | Synthetic Department',
    });

    const [obs] = await h.observations();
    expect(obs?.key).toBe(out.entityKey);
    expect(obs?.attributes).toMatchObject({
      state: 'first_seen',
      vantage: 'test-vantage',
      observed_at: T0,
      http_status: 200,
      text_extracted: 1,
      deadline_date: '2026-10-30',
      deadline_ts: datesToTs('2026-10-30'),
      printed_date_ts: datesToTs('2026-10-01'),
      amount_paise: 150_000,
      last_modified_ts: Date.parse('2026-10-01T10:00:00Z') / 1000,
      severity: 0,
    });
    expect(obs?.attributes.prev_norm_sha256).toBeUndefined();
    expect(obs?.payload).toMatchObject({
      final_url: URL_A,
      extractor: { model: RULES_MODEL, confidence: 0.3 },
      summary_en: 'First observation of this notice by this watcher (deadline 2026-10-30, amount Rs. 1500.00).',
    });
    expect(JSON.stringify(obs?.payload)).not.toMatch(/eligible|institution certificate/i);

    const row = h.db.get(src.docId);
    expect(row).toMatchObject({ lastState: 'first_seen', lastWriteTs: T0, lastObsEntityKey: out.entityKey });
    expect(row?.lastText).toContain('eligible');
  });

  it('ignores volatile counters, then writes changed with the new deadline and severity 2', async () => {
    const h = harness();
    const src = source(URL_A);
    h.setRoute(URL_A, page({ visitors: 1 }));
    await h.watcher.check(src);
    h.setRoute(URL_A, page({ visitors: 99 }));
    expect(await h.watcher.check(src)).toMatchObject({ status: 'skipped', state: 'present' });

    h.setRoute(URL_A, page({ deadline: '20 November 2026', visitors: 100 }));
    const out = await h.watcher.check(src);
    expect(out).toMatchObject({ status: 'written', state: 'changed' });
    const obs = (await h.observations()).at(-1);
    const first = (await h.observations())[0];
    expect(obs?.attributes).toMatchObject({
      deadline_ts: datesToTs('2026-11-20'),
      deadline_date: '2026-11-20',
      severity: 2,
      prev_norm_sha256: first?.attributes.norm_sha256,
    });
    expect(obs?.payload).toMatchObject({
      changes: [
        { field: 'deadline', from: '2026-10-30', to: '2026-11-20' },
        { field: 'text', from: first?.attributes.norm_sha256, to: obs?.attributes.norm_sha256 },
      ],
      summary_en: 'Deadline changed from 2026-10-30 to 2026-11-20.',
    });
    expect((await h.arkiv.query({ where: [{ attr: 'type', op: 'eq', value: 'doc' }] })).items).toHaveLength(1);
  });

  it('only publishes unreachable after two consecutive failures, once per heartbeat', async () => {
    const h = harness();
    const src = source(URL_A);
    h.setRoute(URL_A, page());
    await h.watcher.check(src);

    h.setRoute(URL_A, undefined);
    expect(await h.watcher.check(src)).toMatchObject({ status: 'skipped', state: 'unreachable', retry: true });
    expect(h.db.get(src.docId)?.consecutiveFailures).toBe(1);
    const second = await h.watcher.check(src);
    expect(second).toMatchObject({ status: 'written', state: 'unreachable', retry: false });
    expect(await h.watcher.check(src)).toMatchObject({ status: 'skipped', state: 'unreachable' });
    const obs = (await h.observations()).at(-1);
    expect(obs?.attributes).toMatchObject({ state: 'unreachable', http_status: 0, severity: 0 });
    expect(obs?.attributes.norm_sha256).toBeUndefined();

    h.setRoute(URL_A, { status: 503 });
    expect(await h.watcher.check(src)).toMatchObject({ status: 'skipped', state: 'unreachable' });

    h.setRoute(URL_A, page());
    expect(await h.watcher.check(src)).toMatchObject({
      status: 'written',
      state: 'present',
      reason: 'back after unreachable',
    });
    expect(h.db.get(src.docId)?.consecutiveFailures).toBe(0);
  });

  it('writes removal states with severity 3 and no content hashes', async () => {
    const h = harness();
    const src = source(URL_A, 'page', { mustContain: ['circular no.'] });
    h.setRoute(URL_A, page());
    await h.watcher.check(src);
    h.setRoute(URL_A, { status: 410, body: 'gone' });
    expect(await h.watcher.check(src)).toMatchObject({ status: 'written', state: 'removed_410' });
    const obs = (await h.observations()).at(-1);
    expect(obs?.attributes).toMatchObject({ severity: 3, http_status: 410 });
    expect(obs?.attributes.raw_sha256).toBeUndefined();
    expect(obs?.attributes.deadline_ts).toBeUndefined();
    expect(obs?.payload).toMatchObject({ changes: [{ field: 'removed', from: 'first_seen', to: 'removed_410' }] });
    expect(h.db.get(src.docId)?.lastNormSha256).toBe((await h.observations())[0]?.attributes.norm_sha256);
  });

  it('uses LLM severity only for changed and keeps the LLM summary', async () => {
    let severity = 3;
    const llm: LlmClient = {
      model: 'stub-model',
      completeJson: async () =>
        JSON.stringify({
          title: 'Synthetic notice',
          department: null,
          scheme: null,
          printed_date: '2026-10-01',
          deadline: '2026-10-30',
          amount_inr: 1500,
          declared_supersedes: 'Circular No. SYN/2025/09',
          summary_en: 'A synthetic scholarship notice.',
          severity,
          confidence: 0.8,
        }),
    };
    const h = harness({ llm });
    const src = source(URL_A);
    h.setRoute(URL_A, page());
    await h.watcher.check(src);
    let obs = (await h.observations()).at(-1);
    expect(obs?.attributes.severity).toBe(0);
    expect(obs?.payload).toMatchObject({
      summary_en: 'A synthetic scholarship notice.',
      extractor: { model: 'stub-model', confidence: 0.8 },
      declared_supersedes: 'Circular No. SYN/2025/09',
      title: 'Synthetic notice',
    });

    severity = 1;
    h.setRoute(URL_A, page({ extra: '<p>An extra clause about documents.</p>' }));
    await h.watcher.check(src);
    obs = (await h.observations()).at(-1);
    expect(obs?.attributes).toMatchObject({ state: 'changed', severity: 1 });

    severity = 3;
    h.setRoute(URL_A, page({ extra: '<p>Another clause.</p>' }));
    await h.watcher.check(src);
    expect((await h.observations()).at(-1)?.attributes.severity).toBe(3);
  });

  it('writes a heartbeat after HEARTBEAT_HOURS carrying the last fields', async () => {
    const h = harness();
    const src = source(URL_A);
    h.setRoute(URL_A, page());
    await h.watcher.check(src);
    h.setNow(T0 + 24 * 3600);
    expect(await h.watcher.check(src)).toMatchObject({ status: 'written', state: 'present', reason: 'heartbeat due' });
    const obs = (await h.observations()).at(-1);
    expect(obs?.attributes).toMatchObject({ deadline_date: '2026-10-30', severity: 0 });
    expect(obs?.payload).toMatchObject({ extractor: { model: 'none', confidence: 0 } });
  });

  it('normalizes PDFs through poppler and flags a PDF url that serves HTML', async () => {
    const pdfText = 'Circular No. SYN/2026/01. Last date to apply: 30 October 2026. Amount Rs. 1,500 per month.';
    const exec: ExecTool = async (cmd) => (cmd === 'pdftotext' ? pdfText : 'Producer: Synthetic\n');
    const h = harness({ pdfExec: exec });
    const url = 'http://site.test/notices/1.pdf';
    const src = source(url, 'pdf');
    h.setRoute(url, { status: 200, body: '%PDF-1.7 synthetic bytes', headers: { 'content-type': 'application/pdf' } });
    expect(await h.watcher.check(src)).toMatchObject({ state: 'first_seen' });
    expect((await h.observations()).at(-1)?.attributes).toMatchObject({
      text_extracted: 1,
      deadline_date: '2026-10-30',
      source_kind: 'pdf',
    });

    h.setRoute(url, page());
    expect(await h.watcher.check(src)).toMatchObject({ status: 'written', state: 'soft_removed' });
  });

  it('decodes a declared charset and falls back to utf-8 for an unknown one', async () => {
    const h = harness();
    const src = source(URL_A);
    const latin1 = Buffer.from(noticePage({ extra: '<p>Caf\u00e9 synthetic clause.</p>' }), 'latin1');
    h.setRoute(URL_A, { status: 200, body: latin1, headers: { 'content-type': 'text/html; charset="iso-8859-1"' } });
    await h.watcher.check(src);
    expect(h.db.get(src.docId)?.lastText).toContain('café');

    const h2 = harness();
    h2.setRoute(URL_A, {
      status: 200,
      body: noticePage(),
      headers: { 'content-type': 'text/html; charset=x-unknown' },
    });
    expect(await h2.watcher.check(src)).toMatchObject({ state: 'first_seen' });
  });

  it('reuses the earliest existing doc entity from any writer', async () => {
    const net = new FakeArkivNetwork();
    const other = new FakeArkivClient('0x00000000000000000000000000000000000000b2', net);
    const src = source(URL_A);
    const first = await other.createEntity({
      attributes: { type: 'doc', doc_id: src.docId },
      payload: {},
      ttlSeconds: 3600,
    });
    await other.createEntity({ attributes: { type: 'doc', doc_id: src.docId }, payload: {}, ttlSeconds: 3600 });
    const me = other.withAddress('0x00000000000000000000000000000000000000a1');
    const h = harness({ arkiv: me });
    h.setRoute(URL_A, page());
    await h.watcher.check(src);
    expect(h.db.get(src.docId)?.docEntityKey).toBe(first.key);
    const docs = await me.query({ where: [{ attr: 'type', op: 'eq', value: 'doc' }] });
    expect(docs.items).toHaveLength(2);
  });

  it('turns a failed Arkiv write into a retryable error and leaves local state unchanged', async () => {
    const real = new FakeArkivClient();
    const broken: ArkivClient = Object.assign(Object.create(real) as FakeArkivClient, {
      createEntity: async () => {
        throw new Error('insufficient funds');
      },
    });
    const h = harness({ arkiv: broken });
    const src = source(URL_A);
    h.setRoute(URL_A, page());
    expect(await h.watcher.safeCheck(src)).toMatchObject({
      status: 'error',
      retry: true,
      reason: 'Error: insufficient funds',
    });
    expect(h.db.get(src.docId)?.lastState ?? null).toBeNull();
  });

  it('skips a source disallowed by robots.txt without fetching it', async () => {
    const routes: Record<string, StubResponse> = {
      'http://site.test/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /' },
      [URL_A]: page(),
    };
    const { fetch, calls } = stubFetch(routes);
    const arkiv = new FakeArkivClient();
    const db = new WatcherDb(':memory:');
    const watcher = new Watcher({
      settings: SETTINGS,
      arkiv,
      db,
      extractor: createExtractor(null),
      log: silentLog,
      fetch,
    });
    const src: WatchedSource = source(URL_A);
    expect(await watcher.check(src)).toMatchObject({ status: 'blocked_by_robots', state: null, retry: false });
    expect(calls.map((c) => c.url)).toEqual(['http://site.test/robots.txt']);
    expect(arkiv.network.entities.size).toBe(0);
    expect(db.get(src.docId)?.lastCheckTs).not.toBeNull();
  });
});

describe('Watcher.renewIfDue', () => {
  it('runs at most once a day over the doc and observation keys', async () => {
    const h = harness();
    h.setRoute(URL_A, page());
    await h.watcher.check(source(URL_A));
    expect(await h.watcher.renewIfDue()).toEqual({ extended: 0, skipped: 2, failed: 0 });
    expect(h.db.getMeta(LAST_RENEW_META_KEY)).toBe(String(T0));
    h.setNow(T0 + 3600);
    expect(await h.watcher.renewIfDue()).toBeNull();

    h.arkiv.network.advanceSeconds(160 * 86400);
    h.setNow(T0 + 86400);
    const [a, b] = await Promise.all([h.watcher.renewIfDue(), h.watcher.renewIfDue()]);
    expect(a).toEqual({ extended: 2, skipped: 0, failed: 0 });
    expect(b).toBeNull();
  });
});
