import {
  classify,
  execTool,
  normalizeHtml,
  normalizePdf,
  normHash,
  PopplerMissingError,
  sha256Hex,
} from '@chronicle/core';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN_HEADER, buildDemoApp, VANTAGE_HEADER } from '../src/app.js';
import { DEMO_LABEL } from '../src/render.js';

const TOKEN = 'test-admin-token';
const T0 = 1_760_000_000;

let app: FastifyInstance;
let clock: number;

beforeEach(() => {
  clock = T0;
  app = buildDemoApp({ adminToken: TOKEN, now: () => clock }).app;
});

afterEach(async () => {
  await app.close();
});

function get(url: string, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, headers });
}

async function mutate(id: string, action: string, value?: string): Promise<LightMyRequestResponse> {
  clock += 60;
  return app.inject({
    method: 'POST',
    url: '/admin/mutate',
    headers: { [ADMIN_TOKEN_HEADER]: TOKEN },
    payload: value === undefined ? { id, action } : { id, action, value },
  });
}

function htmlHash(res: LightMyRequestResponse): string {
  return normHash(normalizeHtml(res.body).text);
}

function classifyPage(res: LightMyRequestResponse, url: string, prevHash: string | null) {
  const text = normalizeHtml(res.body).text;
  return classify({
    fetch: {
      status: res.statusCode,
      finalUrl: `https://demo.example${url}`,
      redirectChainLen: 0,
      contentType: String(res.headers['content-type']),
      bytes: res.rawPayload,
    },
    source: { url: `https://demo.example${url}`, kind: 'page' },
    content: { text, normSha256: normHash(text), textExtracted: true },
    prev: prevHash === null ? null : { normSha256: prevHash, textExtracted: true },
  }).state;
}

const popplerInstalled = await execTool('pdftotext', ['-v'], 5000).then(
  () => true,
  (err: unknown) => !(err instanceof PopplerMissingError),
);
const runPoppler = popplerInstalled || process.env.CI === 'true';

describe('public pages', () => {
  it('serves robots.txt allowing everything', async () => {
    const res = await get('/robots.txt');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('User-agent: *\nAllow: /\n');
  });

  it('redirects / to the circulars index', async () => {
    const res = await get('/');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/circulars/');
  });

  it('lists the three notices on the index, with and without a trailing slash', async () => {
    for (const url of ['/circulars/', '/circulars']) {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(DEMO_LABEL);
      for (const id of ['001', '002', '003']) {
        expect(res.body).toContain(`href="/circulars/${id}"`);
        expect(res.body).toContain(`href="/circulars/${id}.pdf"`);
      }
    }
  });

  it.each(['001', '002', '003'])('serves notice %s as labeled HTML with all fields', async (id) => {
    const res = await get(`/circulars/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['last-modified']).toBe(new Date(T0 * 1000).toUTCString());
    const text = normalizeHtml(res.body).text;
    expect(text).toContain('demonstration: synthetic notice, not a real government document.');
    expect(text).toMatch(/circular no\. demo\/2026\/0\d/);
    for (const label of ['date:', 'department:', 'scheme:', 'last date to apply:', 'amount: rs.']) {
      expect(text).toContain(label);
    }
  });

  it('gives the three notices different departments and schemes', async () => {
    const texts = await Promise.all(['001', '002', '003'].map(async (id) => (await get(`/circulars/${id}`)).body));
    const depts = texts.map((t) => /Department: ([^<]+)/.exec(t)?.[1]);
    const schemes = texts.map((t) => /Scheme: ([^<]+)/.exec(t)?.[1]);
    expect(new Set(depts).size).toBe(3);
    expect(new Set(schemes).size).toBe(3);
  });

  it.each(['/circulars/999', '/circulars/1', '/circulars/001.txt', '/circulars/abc.pdf'])('404 for %s', async (url) => {
    const res = await get(url);
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain(DEMO_LABEL);
  });

  it('serves the admin panel without any token in it', async () => {
    const res = await get('/admin');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Synthetic demonstration site');
    expect(res.body).toContain('simulation');
    expect(res.body).not.toContain(TOKEN);
  });
});

describe('volatile fields', () => {
  it('change on every request without changing the normalized hash', async () => {
    const a = await get('/circulars/001');
    clock += 3600;
    const b = await get('/circulars/001');
    expect(a.body).not.toBe(b.body);
    expect(a.body).toMatch(/Visitors: \d+/);
    expect(/Visitors: (\d+)/.exec(a.body)?.[1]).not.toBe(/Visitors: (\d+)/.exec(b.body)?.[1]);
    expect(/Last updated: ([^<]+)/.exec(a.body)?.[1]).not.toBe(/Last updated: ([^<]+)/.exec(b.body)?.[1]);
    expect(htmlHash(a)).toBe(htmlHash(b));
  });
});

describe('PDF', () => {
  it('serves a PDF with the Chronicle Demo producer and synthetic title', async () => {
    const res = await get('/circulars/001.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const doc = await PDFDocument.load(res.rawPayload, { updateMetadata: false });
    expect(doc.getProducer()).toBe('Chronicle Demo');
    expect(doc.getTitle()).toContain('synthetic demo');
  });

  it('is byte-identical for the same state', async () => {
    const a = await get('/circulars/002.pdf');
    clock += 3600;
    const b = await get('/circulars/002.pdf');
    expect(sha256Hex(a.rawPayload)).toBe(sha256Hex(b.rawPayload));
  });

  it('changes bytes when the deadline changes', async () => {
    const a = await get('/circulars/001.pdf');
    await mutate('001', 'edit_deadline', '2026-10-20');
    const b = await get('/circulars/001.pdf');
    expect(sha256Hex(a.rawPayload)).not.toBe(sha256Hex(b.rawPayload));
  });

  it.runIf(runPoppler)('carries the deadline in its text, which changes with edit_deadline', async () => {
    const before = await normalizePdf((await get('/circulars/001.pdf')).rawPayload);
    expect(before.textExtracted).toBe(true);
    expect(before.text).toContain('demonstration: synthetic notice');
    expect(before.text).toContain('30/10/2026');
    expect(before.meta.producer).toBe('Chronicle Demo');

    await mutate('001', 'edit_deadline', '2026-10-20');
    const after = await normalizePdf((await get('/circulars/001.pdf')).rawPayload);
    expect(after.text).toContain('20/10/2026');
    expect(after.normSha256).not.toBe(before.normSha256);
  });
});

describe('admin auth and validation', () => {
  it('rejects a missing or wrong token on every admin endpoint', async () => {
    for (const headers of [{}, { [ADMIN_TOKEN_HEADER]: 'wrong' }, { [ADMIN_TOKEN_HEADER]: `${TOKEN}x` }]) {
      expect((await app.inject({ method: 'GET', url: '/admin/state', headers })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/admin/reset', headers })).statusCode).toBe(401);
      const res = await app.inject({
        method: 'POST',
        url: '/admin/mutate',
        headers,
        payload: { id: '001', action: 'remove_404' },
      });
      expect(res.statusCode).toBe(401);
    }
    expect((await get('/circulars/001')).statusCode).toBe(200);
  });

  it.each([
    [{ id: '001', action: 'explode' }, 400],
    [{ id: '1', action: 'delist' }, 400],
    [{ action: 'delist' }, 400],
    [{ id: '009', action: 'delist' }, 404],
    [{ id: '001', action: 'edit_deadline', value: '30-10-2026' }, 400],
    [{ id: '001', action: 'edit_deadline', value: '2026-02-30' }, 400],
    [{ id: '001', action: 'edit_deadline' }, 400],
    [{ id: '001', action: 'edit_amount', value: 'lots' }, 400],
    [{ id: '001', action: 'edit_amount', value: '-5' }, 400],
    [{ id: '001', action: 'edit_amount' }, 400],
    [{ id: '001', action: 'edit_text', value: 'short' }, 400],
    [{ id: '001', action: 'backdate', value: 'yesterday' }, 400],
    [{ id: '001', action: 'hide_from_vantage', value: 'Not A Label!' }, 400],
    [{ id: '001', action: 'hide_from_vantage' }, 400],
  ])('rejects %o with %i', async (payload, code) => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/mutate',
      headers: { [ADMIN_TOKEN_HEADER]: TOKEN },
      payload,
    });
    expect(res.statusCode).toBe(code);
    expect(res.json()).toMatchObject({ ok: false });
  });

  it('accepts a reset with a non-JSON body and rejects a form-encoded mutate with 400', async () => {
    const headers = { [ADMIN_TOKEN_HEADER]: TOKEN, 'content-type': 'application/x-www-form-urlencoded' };
    expect((await app.inject({ method: 'POST', url: '/admin/reset', headers, payload: '' })).statusCode).toBe(200);
    const res = await app.inject({ method: 'POST', url: '/admin/mutate', headers, payload: 'id=001&action=delist' });
    expect(res.statusCode).toBe(400);
  });

  it('returns state with the token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/state', headers: { [ADMIN_TOKEN_HEADER]: TOKEN } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; notices: { id: string; status: string }[]; visitors: number }>();
    expect(body.notices.map((n) => n.id)).toEqual(['001', '002', '003']);
    expect(body.notices.every((n) => n.status === 'live')).toBe(true);
  });
});

describe('admin mutations', () => {
  it('edit_deadline changes the HTML text and the normalized hash', async () => {
    const before = await get('/circulars/001');
    const res = await mutate('001', 'edit_deadline', '2026-10-20');
    expect(res.json()).toMatchObject({ ok: true, notice: { deadline: '2026-10-20' } });
    const after = await get('/circulars/001');
    expect(after.body).toContain('Last date to apply: 20 October 2026');
    expect(htmlHash(after)).not.toBe(htmlHash(before));
    expect(after.headers['last-modified']).toBe(new Date((T0 + 60) * 1000).toUTCString());
    expect(classifyPage(after, '/circulars/001', htmlHash(before))).toBe('changed');
  });

  it('edit_amount changes the amount line', async () => {
    const before = await get('/circulars/002');
    await mutate('002', 'edit_amount', '30,000');
    const after = await get('/circulars/002');
    expect(after.body).toContain('Amount: Rs. 30,000 per hectare');
    expect(htmlHash(after)).not.toBe(htmlHash(before));
  });

  it('edit_text replaces the eligibility clause', async () => {
    const clause = 'Only students with at least 75 percent marks in the previous year are eligible.';
    await mutate('001', 'edit_text', clause);
    const after = await get('/circulars/001');
    expect(after.body).toContain(clause);
    expect(after.body).not.toContain('at least 60 percent marks');
  });

  it('backdate moves the printed date back by default or to the given date', async () => {
    await mutate('003', 'backdate');
    expect((await get('/circulars/003')).body).toContain('Date: 26 August 2026');
    await mutate('003', 'backdate', '2025-01-15');
    expect((await get('/circulars/003')).body).toContain('Date: 15 January 2025');
  });

  it('remove_404 returns 404 for HTML and PDF', async () => {
    await mutate('001', 'remove_404');
    const res = await get('/circulars/001');
    expect(res.statusCode).toBe(404);
    expect((await get('/circulars/001.pdf')).statusCode).toBe(404);
    expect(classifyPage(res, '/circulars/001', null)).toBe('removed_404');
  });

  it('remove_410 returns 410 for HTML and PDF', async () => {
    await mutate('002', 'remove_410');
    const res = await get('/circulars/002');
    expect(res.statusCode).toBe(410);
    expect((await get('/circulars/002.pdf')).statusCode).toBe(410);
    expect(classifyPage(res, '/circulars/002', null)).toBe('removed_410');
  });

  it('soft_remove returns 200 with a not-available page that classifies as soft_removed', async () => {
    const before = await get('/circulars/001');
    await mutate('001', 'soft_remove');
    const res = await get('/circulars/001');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('no longer available');
    expect(res.body).toContain(DEMO_LABEL);
    expect(classifyPage(res, '/circulars/001', htmlHash(before))).toBe('soft_removed');

    const pdf = await get('/circulars/001.pdf');
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('text/html');
  });

  it('redirect sends 302 to the index for HTML and PDF', async () => {
    await mutate('003', 'redirect');
    for (const url of ['/circulars/003', '/circulars/003.pdf']) {
      const res = await get(url);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/circulars/');
    }
  });

  it('delist hides the notice from the index but keeps its URLs working', async () => {
    await mutate('002', 'delist');
    const index = await get('/circulars/');
    expect(index.body).not.toContain('href="/circulars/002"');
    expect(index.body).toContain('href="/circulars/001"');
    expect((await get('/circulars/002')).statusCode).toBe(200);
    expect((await get('/circulars/002.pdf')).statusCode).toBe(200);
  });

  it('hide_from_vantage returns 404 only to that vantage, case-insensitively', async () => {
    await mutate('001', 'hide_from_vantage', 'eu-vps');
    await mutate('001', 'hide_from_vantage', 'eu-vps');
    expect((await get('/circulars/001', { [VANTAGE_HEADER]: 'eu-vps' })).statusCode).toBe(404);
    expect((await get('/circulars/001', { [VANTAGE_HEADER]: ' EU-VPS ' })).statusCode).toBe(404);
    expect((await get('/circulars/001.pdf', { [VANTAGE_HEADER]: 'eu-vps' })).statusCode).toBe(404);
    expect((await get('/circulars/001', { [VANTAGE_HEADER]: 'in-vps' })).statusCode).toBe(200);
    expect((await get('/circulars/001')).statusCode).toBe(200);
    expect((await get('/circulars/002', { [VANTAGE_HEADER]: 'eu-vps' })).statusCode).toBe(200);
  });

  it('restore undoes removal, delisting and vantage hiding but keeps content edits', async () => {
    await mutate('001', 'edit_deadline', '2026-10-20');
    await mutate('001', 'remove_410');
    await mutate('001', 'delist');
    await mutate('001', 'hide_from_vantage', 'eu-vps');
    const res = await mutate('001', 'restore');
    expect(res.json()).toMatchObject({
      ok: true,
      notice: { status: 'live', delisted: false, hiddenFromVantages: [], deadline: '2026-10-20' },
    });
    expect((await get('/circulars/001', { [VANTAGE_HEADER]: 'eu-vps' })).statusCode).toBe(200);
    expect((await get('/circulars/')).body).toContain('href="/circulars/001"');
  });

  it('reset restores the seed state', async () => {
    const seedHash = htmlHash(await get('/circulars/001'));
    await mutate('001', 'edit_deadline', '2026-10-20');
    await mutate('002', 'remove_404');
    const res = await app.inject({ method: 'POST', url: '/admin/reset', headers: { [ADMIN_TOKEN_HEADER]: TOKEN } });
    expect(res.json()).toEqual({ ok: true });
    expect(htmlHash(await get('/circulars/001'))).toBe(seedHash);
    expect((await get('/circulars/002')).statusCode).toBe(200);
  });

  it('state reflects mutations', async () => {
    await mutate('003', 'soft_remove');
    const res = await app.inject({ method: 'GET', url: '/admin/state', headers: { [ADMIN_TOKEN_HEADER]: TOKEN } });
    const body = res.json<{ notices: { id: string; status: string }[] }>();
    expect(body.notices.find((n) => n.id === '003')?.status).toBe('soft_removed');
  });
});
