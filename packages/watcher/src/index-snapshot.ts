import {
  buildIndexSnapshotAttrs,
  buildIndexSnapshotPayload,
  parseIndexLinks,
  type ArkivClient,
  type IndexLink,
} from '@chronicle/core';
import type { Logger } from 'pino';
import type { WatcherDb } from './db.js';
import {
  HostQueue,
  RobotsCache,
  fetchDocument,
  realSleep,
  type FetchFn,
  type HttpOptions,
  type Sleep,
} from './fetcher.js';
import type { WatchedIndex } from './watchlist.js';

export interface IndexSnapshotSettings {
  vantage: string;
  userAgent: string;
  fetchTimeoutMs: number;
  requestDelayMsPerHost: number;
  observationTtlDays: number;
}

export interface IndexSnapshotOutcome {
  indexId: string;
  status: 'written' | 'skipped' | 'blocked_by_robots' | 'error';
  reason: string;
  linkCount: number;
  entityKey?: string;
  txHash?: string;
}

function metaKey(indexId: string): string {
  return `index_links_sha256:${indexId}`;
}

function pageUrl(base: string, page: number): string {
  if (page <= 1) return base;
  const u = new URL(base);
  u.searchParams.set('page', String(page));
  return u.href;
}

function decodeHtml(bytes: Uint8Array, contentType: string | null): string {
  const charset = /charset=([^\s;]+)/i.exec(contentType ?? '')?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Stretch S2: fetch archive index pages, parse links, write an `index_snapshot` when the set changes.
 */
export class IndexSnapshotter {
  private readonly http: HttpOptions;
  private readonly queue: HostQueue;
  private readonly robots: RobotsCache;
  private readonly ttlSeconds: number;
  private readonly now: () => number;

  constructor(
    private readonly opts: {
      settings: IndexSnapshotSettings;
      arkiv: ArkivClient;
      db: WatcherDb;
      log: Logger;
      fetch?: FetchFn;
      now?: () => number;
      sleep?: Sleep;
    },
  ) {
    this.now = opts.now ?? ((): number => Math.floor(Date.now() / 1000));
    this.ttlSeconds = opts.settings.observationTtlDays * 86400;
    this.http = {
      fetch: opts.fetch ?? fetch,
      userAgent: opts.settings.userAgent,
      vantage: opts.settings.vantage,
      timeoutMs: opts.settings.fetchTimeoutMs,
    };
    this.queue = new HostQueue(opts.settings.requestDelayMsPerHost, Date.now, opts.sleep ?? realSleep);
    this.robots = new RobotsCache(this.http, this.queue);
  }

  async safeCheck(ix: WatchedIndex): Promise<IndexSnapshotOutcome> {
    try {
      return await this.check(ix);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.opts.log.warn({ indexId: ix.index_id, err: reason }, 'index snapshot failed');
      return { indexId: ix.index_id, status: 'error', reason, linkCount: 0 };
    }
  }

  async check(ix: WatchedIndex): Promise<IndexSnapshotOutcome> {
    const { log, db, arkiv } = this.opts;
    const observedAt = this.now();
    const links: IndexLink[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= ix.max_pages; page += 1) {
      const url = pageUrl(ix.url, page);
      const host = new URL(url).host;
      const allowed = await this.robots.isAllowed(url);
      if (!allowed) {
        return {
          indexId: ix.index_id,
          status: 'blocked_by_robots',
          reason: 'robots.txt disallows this index URL',
          linkCount: 0,
        };
      }
      const fetched = await this.queue.run(host, () => fetchDocument(url, this.http));
      if (fetched.status < 200 || fetched.status >= 300 || fetched.bytes === null) {
        if (page === 1) {
          return {
            indexId: ix.index_id,
            status: 'error',
            reason: `index http ${fetched.status}`,
            linkCount: 0,
          };
        }
        break;
      }
      const html = decodeHtml(fetched.bytes, fetched.contentType);
      for (const link of parseIndexLinks(html, ix.link_selector, fetched.finalUrl)) {
        if (seen.has(link.docId)) continue;
        seen.add(link.docId);
        links.push(link);
      }
    }

    const attrs = buildIndexSnapshotAttrs({
      indexId: ix.index_id,
      indexMode: ix.mode,
      observedAt,
      links: links.map((l) => ({ docId: l.docId, title: l.title })),
    });
    const linksSha = String(attrs.links_sha256);
    const prev = db.getMeta(metaKey(ix.index_id));
    if (prev === linksSha) {
      log.info({ indexId: ix.index_id, linkCount: links.length }, 'index snapshot unchanged');
      return {
        indexId: ix.index_id,
        status: 'skipped',
        reason: 'links_sha256 unchanged',
        linkCount: links.length,
      };
    }

    const payload = buildIndexSnapshotPayload(links.map((l) => ({ docId: l.docId, title: l.title })));
    const created = await arkiv.createEntity({ attributes: attrs, payload, ttlSeconds: this.ttlSeconds });
    db.setMeta(metaKey(ix.index_id), linksSha);
    log.info(
      { indexId: ix.index_id, linkCount: links.length, key: created.key, txHash: created.txHash },
      'index snapshot written',
    );
    return {
      indexId: ix.index_id,
      status: 'written',
      reason: prev === null ? 'first_snapshot' : 'links_changed',
      linkCount: links.length,
      entityKey: created.key,
      txHash: created.txHash,
    };
  }
}
