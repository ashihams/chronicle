import { describe, expect, it } from 'vitest';
import {
  ACCEPT_HEADER,
  HostQueue,
  MAX_REDIRECTS,
  ROBOTS_FAILURE_TTL_MS,
  ROBOTS_TTL_MS,
  RobotsCache,
  VANTAGE_HEADER,
  fetchDocument,
  realSleep,
  type HttpOptions,
} from '../src/fetcher.js';
import { stubFetch, type StubResponse } from './helpers.js';

function http(fetch: HttpOptions['fetch'], extra: Partial<HttpOptions> = {}): HttpOptions {
  return { fetch, userAgent: 'ChronicleWatcher/1.0 (+test)', vantage: 'test-vantage', timeoutMs: 5000, ...extra };
}

describe('HostQueue', () => {
  it('serializes requests per host and waits the delay between them', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const q = new HostQueue(
      1000,
      () => clock,
      async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    );
    const order: string[] = [];
    const task = (name: string, cost: number) => async (): Promise<string> => {
      order.push(`start ${name}`);
      clock += cost;
      order.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([
      q.run('a.test', task('a1', 10)),
      q.run('a.test', task('a2', 10)),
      q.run('b.test', task('b1', 10)),
    ]);
    expect(results).toEqual(['a1', 'a2', 'b1']);
    expect(order.indexOf('start a2')).toBeGreaterThan(order.indexOf('end a1'));
    expect(sleeps).toEqual([1000]);
  });

  it('keeps going after a failed task', async () => {
    const q = new HostQueue(0);
    await expect(q.run('a.test', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(q.run('a.test', async () => 'ok')).resolves.toBe('ok');
  });

  it('realSleep resolves', async () => {
    await expect(realSleep(1)).resolves.toBeUndefined();
  });
});

describe('fetchDocument', () => {
  it('sends the required headers and returns the body', async () => {
    const { fetch, calls } = stubFetch({
      'http://site.test/a': {
        status: 200,
        body: 'hello',
        headers: { 'content-type': 'text/html', 'last-modified': 'Wed, 01 Oct 2026 10:00:00 GMT' },
      },
    });
    const res = await fetchDocument('http://site.test/a', http(fetch));
    expect(res).toMatchObject({
      status: 200,
      finalUrl: 'http://site.test/a',
      redirectChainLen: 0,
      contentType: 'text/html',
      lastModified: 'Wed, 01 Oct 2026 10:00:00 GMT',
    });
    expect(new TextDecoder().decode(res.bytes ?? new Uint8Array())).toBe('hello');
    expect(calls[0]?.headers).toEqual({
      'user-agent': 'ChronicleWatcher/1.0 (+test)',
      [VANTAGE_HEADER]: 'test-vantage',
      accept: ACCEPT_HEADER,
    });
  });

  it('follows relative and absolute redirects and records the chain', async () => {
    const { fetch } = stubFetch({
      'http://site.test/a': { status: 301, headers: { location: '/b' } },
      'http://site.test/b': { status: 302, headers: { location: 'http://other.test/c' } },
      'http://other.test/c': { status: 200, body: 'final' },
    });
    const res = await fetchDocument('http://site.test/a', http(fetch));
    expect(res).toMatchObject({ status: 200, finalUrl: 'http://other.test/c', redirectChainLen: 2 });
  });

  it(`stops after ${MAX_REDIRECTS} redirects and returns the last 3xx`, async () => {
    const routes: Record<string, StubResponse> = {};
    for (let i = 0; i <= MAX_REDIRECTS + 1; i++) {
      routes[`http://site.test/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
    }
    const res = await fetchDocument('http://site.test/0', http(stubFetch(routes).fetch));
    expect(res).toMatchObject({
      status: 302,
      redirectChainLen: MAX_REDIRECTS,
      finalUrl: `http://site.test/${MAX_REDIRECTS}`,
    });
  });

  it('reports network failures as status 0', async () => {
    const res = await fetchDocument('http://down.test/', http(stubFetch({}).fetch));
    expect(res).toMatchObject({ status: 0, bytes: null, contentType: null });
    expect(res.error).toContain('ECONNREFUSED');
  });

  it('reports a timeout', async () => {
    const fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as HttpOptions['fetch'];
    const res = await fetchDocument('http://slow.test/', http(fetch, { timeoutMs: 20 }));
    expect(res).toMatchObject({ status: 0, error: 'timeout' });
  });

  it('caps the body by content-length and by streamed size', async () => {
    const { fetch } = stubFetch({
      'http://site.test/declared': { status: 200, body: 'x', headers: { 'content-length': '999' } },
      'http://site.test/streamed': { status: 200, body: 'x'.repeat(50) },
      'http://site.test/ok': { status: 200, body: 'x'.repeat(10) },
    });
    const opts = http(fetch, { maxBodyBytes: 20 });
    expect((await fetchDocument('http://site.test/declared', opts)).error).toBe('body exceeds 20 bytes');
    expect((await fetchDocument('http://site.test/streamed', opts)).error).toBe('body exceeds 20 bytes');
    expect((await fetchDocument('http://site.test/ok', opts)).bytes?.byteLength).toBe(10);
  });

  it('returns an empty body for a bodyless response', async () => {
    const res = await fetchDocument(
      'http://site.test/empty',
      http(stubFetch({ 'http://site.test/empty': { status: 204 } }).fetch),
    );
    expect(res.bytes?.byteLength).toBe(0);
  });
});

describe('RobotsCache', () => {
  function cache(routes: Record<string, StubResponse>, now: () => number = Date.now) {
    const stub = stubFetch(routes);
    return { robots: new RobotsCache(http(stub.fetch), new HostQueue(0), now), calls: stub.calls };
  }

  it('applies the rules for our user agent and caches robots.txt for 24 hours', async () => {
    let clock = 0;
    const { robots, calls } = cache(
      {
        'http://site.test/robots.txt': {
          status: 200,
          body: 'User-agent: ChronicleWatcher\nDisallow: /private\n\nUser-agent: *\nDisallow: /',
        },
      },
      () => clock,
    );
    expect(await robots.isAllowed('http://site.test/public')).toBe(true);
    expect(await robots.isAllowed('http://site.test/private/x')).toBe(false);
    expect(calls).toHaveLength(1);
    clock += ROBOTS_TTL_MS;
    await robots.isAllowed('http://site.test/public');
    expect(calls).toHaveLength(2);
  });

  it('fetches robots.txt once for concurrent checks on the same origin', async () => {
    const { robots, calls } = cache({
      'http://site.test/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /' },
    });
    const allowed = await Promise.all([robots.isAllowed('http://site.test/a'), robots.isAllowed('http://site.test/b')]);
    expect(allowed).toEqual([true, true]);
    expect(calls).toHaveLength(1);
  });

  it('allows everything when robots.txt is missing', async () => {
    const { robots } = cache({ 'http://site.test/robots.txt': { status: 404 } });
    expect(await robots.isAllowed('http://site.test/anything')).toBe(true);
  });

  it('blocks the host for an hour when robots.txt fails', async () => {
    let clock = 0;
    const { robots, calls } = cache({ 'http://site.test/robots.txt': { status: 503 } }, () => clock);
    expect(await robots.isAllowed('http://site.test/a')).toBe(false);
    expect(await robots.isAllowed('http://down.test/a')).toBe(false);
    clock += ROBOTS_FAILURE_TTL_MS;
    await robots.isAllowed('http://site.test/a');
    expect(calls.filter((c) => c.url === 'http://site.test/robots.txt')).toHaveLength(2);
  });
});
