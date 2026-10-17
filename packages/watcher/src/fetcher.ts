import type { FetchResult } from '@chronicle/core';
import robotsParserModule from 'robots-parser';

// The package is CommonJS (`module.exports = fn`) but its typings declare an ES default export, so
// under NodeNext the default import is typed as the namespace while it is the function at runtime.
interface Robots {
  isAllowed(url: string, ua?: string): boolean | undefined;
}
const robotsParser = robotsParserModule as unknown as (url: string, robotstxt: string) => Robots;

export const MAX_REDIRECTS = 5;
export const MAX_BODY_BYTES = 25 * 1024 * 1024;
export const ROBOTS_TTL_MS = 24 * 3600 * 1000;
/** A robots.txt that could not be fetched (5xx, network) blocks the host for this long, then is retried. */
export const ROBOTS_FAILURE_TTL_MS = 3600 * 1000;
export const ACCEPT_HEADER = 'text/html,application/pdf,*/*';
export const VANTAGE_HEADER = 'x-chronicle-vantage';

export type FetchFn = typeof fetch;
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Serializes requests per host and keeps `delayMs` between the end of one and the start of the next. */
export class HostQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly lastDone = new Map<string, number>();

  constructor(
    private readonly delayMs: number,
    private readonly nowMs: () => number = Date.now,
    private readonly sleep: Sleep = realSleep,
  ) {}

  run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(host) ?? Promise.resolve();
    const result = prev.then(async () => {
      const last = this.lastDone.get(host);
      if (last !== undefined) {
        const wait = last + this.delayMs - this.nowMs();
        if (wait > 0) await this.sleep(wait);
      }
      try {
        return await fn();
      } finally {
        this.lastDone.set(host, this.nowMs());
      }
    });
    this.tails.set(
      host,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}

export interface HttpOptions {
  fetch: FetchFn;
  userAgent: string;
  vantage: string;
  timeoutMs: number;
  maxBodyBytes?: number;
}

/** FetchResult plus the response headers the watcher records. */
export interface FetchedDocument extends FetchResult {
  lastModified: string | null;
}

class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`body exceeds ${limit} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

async function readCapped(res: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel();
    throw new BodyTooLargeError(limit);
  }
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new BodyTooLargeError(limit);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message !== '') return `${err.message}: ${cause.message}`;
    return err.message;
  }
  return String(err);
}

/**
 * GET with manually followed redirects (at most MAX_REDIRECTS), one overall timeout and a body cap.
 * Never throws: network failures come back as status 0 with `error` set.
 */
export async function fetchDocument(url: string, opts: HttpOptions): Promise<FetchedDocument> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const headers = { 'user-agent': opts.userAgent, [VANTAGE_HEADER]: opts.vantage, accept: ACCEPT_HEADER };
  let current = url;
  let chainLen = 0;
  try {
    for (;;) {
      const res = await opts.fetch(current, { redirect: 'manual', headers, signal });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location !== null && chainLen < MAX_REDIRECTS) {
        await res.body?.cancel();
        current = new URL(location, current).toString();
        chainLen += 1;
        continue;
      }
      const bytes = await readCapped(res, opts.maxBodyBytes ?? MAX_BODY_BYTES);
      return {
        status: res.status,
        finalUrl: current,
        redirectChainLen: chainLen,
        contentType: res.headers.get('content-type'),
        bytes,
        lastModified: res.headers.get('last-modified'),
      };
    }
  } catch (err) {
    return {
      status: 0,
      finalUrl: current,
      redirectChainLen: chainLen,
      contentType: null,
      bytes: null,
      error: errorMessage(err),
      lastModified: null,
    };
  }
}

interface RobotsEntry {
  /** null means the robots.txt could not be fetched, so nothing on the host is allowed. */
  robot: Robots | 'allow-all' | null;
  expiresAt: number;
}

/** robots.txt per origin, cached for 24 hours. Concurrent lookups for one origin share a fetch. */
export class RobotsCache {
  private readonly cache = new Map<string, RobotsEntry>();
  private readonly pending = new Map<string, Promise<RobotsEntry>>();

  constructor(
    private readonly http: HttpOptions,
    private readonly queue: HostQueue,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async isAllowed(url: string): Promise<boolean> {
    const u = new URL(url);
    const entry = await this.entryFor(u);
    if (entry.robot === 'allow-all') return true;
    if (entry.robot === null) return false;
    return entry.robot.isAllowed(url, this.http.userAgent) !== false;
  }

  private async entryFor(u: URL): Promise<RobotsEntry> {
    const cached = this.cache.get(u.origin);
    if (cached !== undefined && cached.expiresAt > this.nowMs()) return cached;
    let pending = this.pending.get(u.origin);
    if (pending === undefined) {
      pending = this.load(u).finally(() => this.pending.delete(u.origin));
      this.pending.set(u.origin, pending);
    }
    return pending;
  }

  private async load(u: URL): Promise<RobotsEntry> {
    const robotsUrl = `${u.origin}/robots.txt`;
    const res = await this.queue.run(u.host, () => fetchDocument(robotsUrl, this.http));
    let entry: RobotsEntry;
    if (res.status >= 200 && res.status < 300 && res.bytes !== null) {
      const text = new TextDecoder().decode(res.bytes);
      entry = { robot: robotsParser(robotsUrl, text), expiresAt: this.nowMs() + ROBOTS_TTL_MS };
    } else if (res.status >= 400 && res.status < 500) {
      entry = { robot: 'allow-all', expiresAt: this.nowMs() + ROBOTS_TTL_MS };
    } else {
      entry = { robot: null, expiresAt: this.nowMs() + ROBOTS_FAILURE_TTL_MS };
    }
    this.cache.set(u.origin, entry);
    return entry;
  }
}
