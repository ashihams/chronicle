import { canonicalizeUrl, docIdFor, type SourceKind } from '@chronicle/core';
import { pino } from 'pino';
import type { FetchFn } from '../src/fetcher.js';
import type { WatcherSettings } from '../src/watcher.js';
import type { WatchedSource } from '../src/watchlist.js';

export const silentLog = pino({ level: 'silent' });

export const SETTINGS: WatcherSettings = {
  vantage: 'test-vantage',
  userAgent: 'ChronicleWatcher/1.0 (+test)',
  fetchTimeoutMs: 5000,
  requestDelayMsPerHost: 0,
  heartbeatHours: 24,
  observationTtlDays: 180,
  renewWhenDaysLeft: 30,
};

export function source(url: string, kind: SourceKind = 'page', extra: Partial<WatchedSource> = {}): WatchedSource {
  const canonicalUrl = canonicalizeUrl(url);
  return {
    docId: docIdFor(canonicalUrl),
    url,
    canonicalUrl,
    kind,
    contentSelector: kind === 'page' ? 'main' : undefined,
    mustContain: undefined,
    pollHours: 1,
    noticeId: 'synthetic-001',
    department: 'synthetic-dept',
    scheme: 'synthetic-scheme',
    lang: 'en',
    ...extra,
  };
}

export interface StubResponse {
  status: number;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
}

/** A fetch stub keyed by URL. Missing URLs throw like a refused connection. Records every request. */
export function stubFetch(routes: Record<string, StubResponse | (() => StubResponse)>): {
  fetch: FetchFn;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const route = routes[url];
    if (route === undefined) throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    const r = typeof route === 'function' ? route() : route;
    const body = r.body === undefined ? null : typeof r.body === 'string' ? r.body : Buffer.from(r.body);
    return new Response(body, { status: r.status, headers: r.headers ?? {} });
  }) as FetchFn;
  return { fetch, calls };
}

/** Minimal notice page; `deadline` and `visitors` vary per test. */
export function noticePage(
  opts: { deadline?: string; amount?: string; visitors?: number; extra?: string } = {},
): string {
  return `<!doctype html><html><head><title>Synthetic notice | Synthetic Department</title></head><body>
<main>
<h1>Synthetic scholarship notice</h1>
<p>Circular No. SYN/2026/01</p>
<p>Date: 1 October 2026</p>
<p>Students enrolled full time in a recognised synthetic institution with at least 60 percent marks are eligible.</p>
<p>Applications must be submitted through the synthetic portal together with an institution certificate.</p>
<p>Last date to apply: ${opts.deadline ?? '30 October 2026'}</p>
<p>Amount: Rs. ${opts.amount ?? '1,500'} per month</p>
${opts.extra ?? ''}
<p>Visitors: ${opts.visitors ?? 1}</p>
</main></body></html>`;
}
