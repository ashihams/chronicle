import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecTool } from '@chronicle/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApi, changesWhere } from '../src/api.js';
import { IndexerDb } from '../src/db.js';
import { Indexer } from '../src/indexer.js';
import { ADDR_A, ADDR_B, Chain, DAY, DOC_ID, H, SETTINGS, silentLog } from './helpers.js';

const EXPLORER = 'https://explorer.example.test/';

interface Ctx {
  chain: Chain;
  db: IndexerDb;
  app: FastifyInstance;
  keys: Record<string, string>;
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function setup(
  opts: {
    webDist?: string;
    rateLimit?: { max: number; windowMs: number };
    pdfExec?: ExecTool;
  } = {},
): Promise<Ctx> {
  const chain = new Chain();
  const db = new IndexerDb(':memory:');
  const keys: Record<string, string> = {};
  keys.doc = await chain.doc(chain.a);
  keys.first = await chain.observe(chain.a, {
    state: 'first_seen',
    hash: H(1),
    vantage: 'in-a',
    deadlineTs: 1_900_000_000,
  });
  chain.advance(3600);
  keys.changed = await chain.observe(
    chain.a,
    { state: 'changed', hash: H(2), vantage: 'in-a', deadlineTs: 1_900_500_000, severity: 2 },
    { summary_en: 'Deadline moved.', changes: [{ field: 'deadline', from: '2030-03-17', to: '2030-03-23' }] },
  );
  chain.advance(60);
  keys.other = await chain.observe(chain.b, { state: 'first_seen', hash: H(1), vantage: 'eu-b' });
  await new Indexer(chain.a, db, SETTINGS, silentLog).sync();
  const app = await buildApi({
    db,
    arkiv: chain.a,
    explorerBase: EXPLORER,
    log: silentLog,
    now: () => chain.t,
    chainId: 7738577,
    rpcHttp: 'https://rpc.example.test',
    ...opts,
  });
  apps.push(app);
  return { chain, db, app, keys };
}

async function get(
  app: FastifyInstance,
  url: string,
): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, unknown> }> {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as Record<string, unknown>, headers: res.headers };
}

describe('changesWhere', () => {
  it('builds the live query for each field', () => {
    expect(changesWhere(1000.7 + 30 * DAY, 30, 'any')).toEqual([
      { attr: 'type', op: 'eq', value: 'observation' },
      { attr: 'state', op: 'eq', value: 'changed' },
      { attr: 'observed_at', op: 'gte', value: 1000 },
    ]);
    expect(changesWhere(10, 30, 'deadline').at(-1)).toEqual({ attr: 'deadline_ts', op: 'gte', value: 0 });
    expect(changesWhere(10, 30, 'amount')[2]).toEqual({ attr: 'observed_at', op: 'gte', value: 0 });
    expect(changesWhere(10, 30, 'amount').at(-1)).toEqual({ attr: 'amount_paise', op: 'gte', value: 0 });
  });
});

describe('REST API', () => {
  it('reports health and sync status', async () => {
    const { app } = await setup();
    const { status, body, headers } = await get(app, '/api/health');
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, entityCount: 4 });
    expect(typeof body.lastSyncTs).toBe('number');
    expect(typeof body.chainHead).toBe('number');
    expect(headers['access-control-allow-origin']).toBe('*');
  });

  it('lists docs with filters', async () => {
    const { app } = await setup();
    const { body } = await get(app, '/api/docs');
    expect(body).toMatchObject({ total: 1, limit: 50, offset: 0 });
    expect((body.items as unknown[])[0]).toMatchObject({
      doc_id: DOC_ID,
      title: 'Synthetic circular',
      observer_count: 2,
      open_flags: { count: 1, kinds: ['vantage_disagreement'] },
      // A's latest is version 2, B's is version 1: a tie goes to the later version
      current_version: { seq: 2, deadline_ts: 1_900_500_000, summary_en: 'Deadline moved.' },
    });
    expect((await get(app, '/api/docs?department=synthetic-dept&q=synthetic')).body.total).toBe(1);
    expect((await get(app, '/api/docs?department=nope')).body.total).toBe(0);
    expect((await get(app, '/api/docs?changed_since=1')).body.total).toBe(1);
  });

  it('rejects bad query parameters with {error, code}', async () => {
    const { app } = await setup();
    for (const url of ['/api/docs?limit=500', '/api/docs?unknown=1', '/api/docs?changed_since=abc', '/api/docs/XYZ']) {
      const r = await get(app, url);
      expect(r.status, url).toBe(400);
      expect(r.body).toMatchObject({ code: 'bad_request' });
      expect(typeof r.body.error).toBe('string');
    }
    expect(await get(app, `/api/docs/${'0'.repeat(64)}`)).toMatchObject({ status: 404, body: { code: 'not_found' } });
    expect(await get(app, '/api/nothing')).toMatchObject({ status: 404, body: { code: 'not_found' } });
  });

  it('returns a doc with versions, status, flags and observers', async () => {
    const { app, keys } = await setup();
    const { status, body } = await get(app, `/api/docs/${DOC_ID}`);
    expect(status).toBe(200);
    expect(body.doc).toMatchObject({
      doc_id: DOC_ID,
      doc_entity_url: `https://explorer.example.test/entity/${keys.doc}`,
    });
    expect(body.status).toMatchObject({ current_state: 'first_seen', removed: false });
    expect((body.versions as { seq: number; status: string }[]).map((v) => [v.seq, v.status])).toEqual([
      [1, 'superseded'],
      [2, 'current'],
    ]);
    expect((body.flags as { kind: string; open: boolean }[]).map((f) => [f.kind, f.open])).toEqual([
      ['vantage_disagreement', true],
    ]);
    expect(
      (body.observers as { creator: string; vantages: string[]; observation_count: number }[]).map((o) => [
        o.creator,
        o.vantages,
        o.observation_count,
      ]),
    ).toEqual([
      [ADDR_A, ['in-a'], 2],
      [ADDR_B, ['eu-b'], 1],
    ]);
  });

  it('returns a timeline ordered by chain time', async () => {
    const { app, keys } = await setup();
    const { body } = await get(app, `/api/docs/${DOC_ID}/timeline`);
    const events = body.events as { kind: string; ts: number; key?: string; label?: string }[];
    expect(events.map((e) => e.kind)).toEqual([
      'observation',
      'version',
      'observation',
      'version',
      'observation',
      'flag',
    ]);
    expect(events.map((e) => e.ts)).toEqual([...events.map((e) => e.ts)].sort((a, b) => a - b));
    expect(events[1]?.label).toBe('version 1 first seen');
    expect(events[5]).toMatchObject({ flag_kind: 'vantage_disagreement', severity: 2, open: true });
    expect(events[2]).toMatchObject({
      key: keys.changed,
      creator: ADDR_A,
      owner: ADDR_A,
      vantage: 'in-a',
      state: 'changed',
      norm_sha256: H(2),
      summary_en: 'Deadline moved.',
      severity: 2,
      explorer_url: `https://explorer.example.test/entity/${keys.changed}`,
    });
    expect(events[2]).toHaveProperty('observed_at');
    expect(events[2]).toHaveProperty('created_block');
    expect(String((events[2] as { tx_url?: string }).tx_url)).toMatch(/\/tx\/0x[0-9a-f]{64}$/);
  });

  it('summarizes watchers', async () => {
    const { app } = await setup();
    const { body } = await get(app, '/api/watchers');
    expect(body.items).toEqual([
      expect.objectContaining({ creator: ADDR_A, observation_count: 2, docs_covered: 1, vantages: ['in-a'] }),
      expect.objectContaining({
        creator: ADDR_B,
        observation_count: 1,
        explorer_url: `https://explorer.example.test/address/${ADDR_B}`,
      }),
    ]);
  });

  it('re-checks an entity live against the mirror', async () => {
    const { app, chain, keys } = await setup();
    let r = await get(app, `/api/entities/${keys.first?.toUpperCase().replace('0X', '0x')}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ key: keys.first, matches_mirror: true, owner_changed: false });
    expect(r.body.mirror).toMatchObject({ creator: ADDR_A, status: 'live' });
    expect(r.body.live).toMatchObject({ creator: ADDR_A });
    expect(r.headers['cache-control']).toBe('no-store');

    chain.network.__setPayload(keys.first as string, { summary_en: 'rewritten' });
    r = await get(app, `/api/entities/${keys.first}`);
    expect(r.body.matches_mirror).toBe(false);

    chain.network.__delete(keys.first as string);
    r = await get(app, `/api/entities/${keys.first}`);
    expect(r.body).toMatchObject({ matches_mirror: false, live: null });

    expect((await get(app, `/api/entities/0x${'1'.repeat(64)}`)).status).toBe(404);
    expect((await get(app, '/api/entities/0x12')).status).toBe(400);
  });

  it('runs live Arkiv queries for changes, departments and creators', async () => {
    const { app, chain, keys } = await setup();
    // an invalid entity from someone else on the shared chain is skipped, not returned
    await chain.c.createEntity({
      attributes: { type: 'observation', state: 'changed', observed_at: chain.t },
      payload: {},
      ttlSeconds: DAY,
    });
    let r = await get(app, '/api/arkiv/changes?days=30');
    expect(r.body).toMatchObject({
      source: 'arkiv-live',
      where: changesWhere(chain.t, 30, 'any'),
      ignored_invalid: 1,
      next_cursor: null,
    });
    expect((r.body.items as { key: string }[]).map((i) => i.key)).toEqual([keys.changed]);

    r = await get(app, '/api/arkiv/changes?days=30&field=deadline');
    expect(r.body.post_filter).toContain('deadline');
    expect((r.body.items as unknown[]).length).toBe(1);
    r = await get(app, '/api/arkiv/changes?field=amount');
    expect(r.body.items).toEqual([]);
    expect((await get(app, '/api/arkiv/changes?field=title')).status).toBe(400);

    r = await get(app, '/api/arkiv/by-department/synthetic-dept?limit=2');
    expect(r.body).toMatchObject({ source: 'arkiv-live', next_cursor: expect.any(String) });
    expect((r.body.items as unknown[]).length).toBe(2);
    const next = await get(app, `/api/arkiv/by-department/synthetic-dept?limit=2&cursor=${String(r.body.next_cursor)}`);
    expect((next.body.items as unknown[]).length).toBe(1);
    expect((await get(app, '/api/arkiv/by-department/Bad%20Dept')).status).toBe(400);

    r = await get(app, `/api/arkiv/by-creator/${ADDR_B.toUpperCase().replace('0X', '0x')}`);
    expect(r.body).toMatchObject({ source: 'arkiv-live', creator: ADDR_B });
    expect((r.body.items as { creator: string }[]).map((i) => i.creator)).toEqual([ADDR_B]);
  });

  it('answers 502 when Arkiv is unreachable', async () => {
    const { app, chain } = await setup();
    chain.a.query = () => Promise.reject(new Error('rpc down'));
    expect(await get(app, '/api/arkiv/changes')).toMatchObject({ status: 502, body: { code: 'arkiv_unavailable' } });
  });

  it('rate limits API requests per IP', async () => {
    const { app } = await setup({ rateLimit: { max: 2, windowMs: 60_000 } });
    expect((await get(app, '/api/health')).status).toBe(200);
    expect((await get(app, '/api/health')).status).toBe(200);
    const r = await get(app, '/api/health');
    expect(r).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('serves the web build with SPA fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronicle-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    const { app } = await setup({ webDist: dir });
    let res = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(res.headers['content-type']).toContain('javascript');
    res = await app.inject({ method: 'GET', url: `/docs/${DOC_ID}` });
    expect(res.body).toContain('<title>app</title>');
    res = await app.inject({ method: 'GET', url: '/' });
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('matches pasted text and rejects an empty body', async () => {
    const { app, db } = await setup();
    const text = 'Synthetic circular for match testing.';
    const { normalizeText, normHash } = await import('@chronicle/core');
    const hash = normHash(normalizeText(text));
    // rewrite version 1 to this hash so the JSON path hits
    const versions = db.versionsForDoc(DOC_ID);
    const v1 = versions[0];
    if (v1 === undefined) throw new Error('missing version');
    db.replaceVersions(
      DOC_ID,
      versions.map((v) => (v.seq === 1 ? { ...v, normSha256: hash } : v)),
    );

    const hit = await app.inject({
      method: 'POST',
      url: '/api/match',
      headers: { 'content-type': 'application/json' },
      payload: { text },
    });
    expect(hit.statusCode).toBe(200);
    expect(hit.json()).toMatchObject({
      result: 'exact_match',
      match: { doc_id: DOC_ID, version_seq: 1, status: 'superseded' },
    });
    expect(String((hit.json() as { note: string }).note)).not.toMatch(/fraud|fake/i);

    const miss = await app.inject({
      method: 'POST',
      url: '/api/match',
      headers: { 'content-type': 'application/json' },
      payload: { text: 'entirely different body' },
    });
    expect(miss.json()).toMatchObject({ result: 'no_match', match: null });

    const empty = await app.inject({
      method: 'POST',
      url: '/api/match',
      headers: { 'content-type': 'application/json' },
      payload: { text: '' },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('matches a PDF by raw bytes hash when text extraction finds nothing', async () => {
    const { sha256Hex } = await import('@chronicle/core');
    const pdfBytes = Buffer.from('%PDF-1.4\nsynthetic match fixture\n%%EOF\n');
    const raw = sha256Hex(pdfBytes);
    const { app, db } = await setup({
      pdfExec: async () => '',
    });
    const versions = db.versionsForDoc(DOC_ID);
    if (versions[0] === undefined) throw new Error('missing version');
    db.replaceVersions(
      DOC_ID,
      versions.map((v) => (v.seq === 1 ? { ...v, normSha256: raw } : v)),
    );

    const form = new FormData();
    form.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'notice.pdf');
    const res = await app.inject({ method: 'POST', url: '/api/match', payload: form });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ result: 'exact_match', match: { version_seq: 1 } });

    const notPdf = new FormData();
    notPdf.append('file', new Blob([Buffer.from('not-a-pdf')], { type: 'application/pdf' }), 'x.pdf');
    expect((await app.inject({ method: 'POST', url: '/api/match', payload: notPdf })).statusCode).toBe(400);
  });
});
