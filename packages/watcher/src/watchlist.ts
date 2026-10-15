import { readFile } from 'node:fs/promises';
import { InvalidUrlError, SOURCE_KINDS, canonicalizeUrl, docIdFor, type SourceKind } from '@chronicle/core';
import { z } from 'zod';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Placeholder for real pages a human has not picked yet. Only allowed on disabled items. */
export const TODO_URL = 'TODO';

const SourceSchema = z
  .object({
    url: z.string().min(1),
    kind: z.enum(SOURCE_KINDS),
    content_selector: z.string().min(1).optional(),
    must_contain: z.array(z.string().min(1)).optional(),
    poll_hours: z
      .number()
      .positive()
      .max(24 * 30)
      .optional(),
  })
  .strict();

const IndexSchema = z
  .object({
    index_id: z.string().regex(ID_RE),
    url: z.string().min(1),
    mode: z.string().min(1),
    link_selector: z.string().min(1),
    max_pages: z.number().int().positive(),
  })
  .strict();

const ItemSchema = z
  .object({
    notice_id: z.string().regex(ID_RE, 'notice_id must be a lowercase id'),
    department: z.string().regex(SLUG_RE, 'department must be a lowercase slug'),
    scheme: z.string().regex(SLUG_RE, 'scheme must be a lowercase slug').optional(),
    lang: z.string().regex(/^[a-z]{2,3}$/),
    index_id: z.string().regex(ID_RE).optional(),
    sources: z.array(SourceSchema).min(1),
    enabled: z.boolean().default(true),
  })
  .strict();

function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(canonicalizeUrl(url));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (err) {
    if (err instanceof InvalidUrlError || err instanceof TypeError) return false;
    throw err;
  }
}

export const WatchlistSchema = z
  .object({
    version: z.literal(1),
    indexes: z.array(IndexSchema).default([]),
    items: z.array(ItemSchema),
  })
  .strict()
  .superRefine((wl, ctx) => {
    const indexIds = new Set<string>();
    wl.indexes.forEach((ix, i) => {
      if (indexIds.has(ix.index_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['indexes', i, 'index_id'],
          message: `duplicate index_id ${ix.index_id}`,
        });
      }
      indexIds.add(ix.index_id);
    });

    const noticeIds = new Set<string>();
    const docIds = new Map<string, string>();
    wl.items.forEach((item, i) => {
      if (noticeIds.has(item.notice_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', i, 'notice_id'],
          message: `duplicate notice_id ${item.notice_id}`,
        });
      }
      noticeIds.add(item.notice_id);
      if (item.index_id !== undefined && !indexIds.has(item.index_id)) {
        ctx.addIssue({ code: 'custom', path: ['items', i, 'index_id'], message: `unknown index_id ${item.index_id}` });
      }
      if (!item.enabled) return;
      item.sources.forEach((s, j) => {
        const path = ['items', i, 'sources', j, 'url'];
        if (!isHttpUrl(s.url)) {
          ctx.addIssue({ code: 'custom', path, message: `enabled source url "${s.url}" must be an http(s) URL` });
          return;
        }
        const docId = docIdFor(canonicalizeUrl(s.url));
        const owner = docIds.get(docId);
        if (owner !== undefined) {
          ctx.addIssue({ code: 'custom', path, message: `url is already watched by ${owner}` });
        }
        docIds.set(docId, item.notice_id);
      });
    });
  });

export type Watchlist = z.output<typeof WatchlistSchema>;

export class WatchlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchlistError';
  }
}

export function parseWatchlist(json: unknown): Watchlist {
  const parsed = WatchlistSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new WatchlistError(`Invalid watchlist:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return parsed.data;
}

export interface LoadWatchlistOptions {
  path: string;
  url?: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Loads from `url` when given (WATCHLIST_URL), else from `path` (WATCHLIST_PATH). */
export async function loadWatchlist(opts: LoadWatchlistOptions): Promise<Watchlist> {
  let raw: string;
  if (opts.url !== undefined) {
    const res = await (opts.fetch ?? fetch)(opts.url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
    if (!res.ok) throw new WatchlistError(`watchlist fetch failed with http ${res.status}`);
    raw = await res.text();
  } else {
    raw = await readFile(opts.path, 'utf8');
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new WatchlistError('watchlist is not valid JSON');
  }
  return parseWatchlist(json);
}

/** One enabled source, flattened with its item's metadata. */
export interface WatchedSource {
  docId: string;
  url: string;
  canonicalUrl: string;
  kind: SourceKind;
  contentSelector: string | undefined;
  mustContain: string[] | undefined;
  pollHours: number;
  noticeId: string;
  department: string;
  scheme: string | undefined;
  lang: string;
}

export function enabledSources(wl: Watchlist, defaultPollHours: number): WatchedSource[] {
  return wl.items
    .filter((item) => item.enabled)
    .flatMap((item) =>
      item.sources.map((s) => {
        const canonicalUrl = canonicalizeUrl(s.url);
        return {
          docId: docIdFor(canonicalUrl),
          url: s.url,
          canonicalUrl,
          kind: s.kind,
          contentSelector: s.content_selector,
          mustContain: s.must_contain,
          pollHours: s.poll_hours ?? defaultPollHours,
          noticeId: item.notice_id,
          department: item.department,
          scheme: item.scheme,
          lang: item.lang,
        };
      }),
    );
}
