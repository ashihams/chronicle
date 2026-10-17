import { z } from 'zod';

const DocListItemSchema = z.object({
  doc_id: z.string(),
  notice_id: z.string().nullable(),
  title: z.string().nullable(),
  source_url: z.string().nullable().optional(),
  source_kind: z.string().nullable().optional(),
  department: z.string().nullable(),
  scheme: z.string().nullable(),
  current_state: z.string().nullable(),
  current_seq: z.number().nullable().optional(),
  last_seen_ts: z.number().nullable().optional(),
  last_change_ts: z.number().nullable(),
  observer_count: z.number().int().nonnegative(),
  open_flags: z.object({
    count: z.number(),
    kinds: z.array(z.string()),
  }),
  current_version: z
    .object({
      seq: z.number(),
      deadline_ts: z.number().nullable(),
      amount_paise: z.number().nullable(),
      summary_en: z.string().nullable(),
    })
    .nullable(),
});

const DocsResponseSchema = z.object({
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  items: z.array(DocListItemSchema),
});

const FlagSchema = z.object({
  kind: z.string(),
  severity: z.number().int(),
  open: z.boolean(),
});

const VersionSchema = z.object({
  seq: z.number(),
  norm_sha256: z.string(),
  first_seen_ts: z.number(),
  observer_count: z.number().int(),
  status: z.enum(['current', 'superseded']),
  summary_en: z.string().nullable(),
});

const DocDetailSchema = z.object({
  doc: DocListItemSchema.passthrough(),
  status: z.object({
    current_state: z.string().nullable(),
    current_seq: z.number().nullable(),
    last_seen_ts: z.number().nullable(),
    last_change_ts: z.number().nullable(),
    removed: z.boolean(),
  }),
  versions: z.array(VersionSchema),
  flags: z.array(FlagSchema),
  observers: z.array(z.object({ creator: z.string() }).passthrough()),
  observation_count: z.number(),
});

export type DocListItem = z.infer<typeof DocListItemSchema>;
export type DocDetail = z.infer<typeof DocDetailSchema>;

export class IndexerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'IndexerApiError';
  }
}

export interface IndexerClient {
  listChangedSince(changedSince: number, limit?: number): Promise<DocListItem[]>;
  getDoc(docId: string): Promise<DocDetail>;
}

export function createIndexerClient(apiBaseUrl: string, fetchImpl: typeof fetch = fetch): IndexerClient {
  const base = apiBaseUrl.replace(/\/$/, '');

  async function getJson(path: string): Promise<unknown> {
    const res = await fetchImpl(`${base}${path}`);
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err =
        body !== null && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
          ? (body as { error: string }).error
          : `HTTP ${res.status}`;
      throw new IndexerApiError(err, res.status);
    }
    return body;
  }

  return {
    async listChangedSince(changedSince: number, limit = 200): Promise<DocListItem[]> {
      const items: DocListItem[] = [];
      let offset = 0;
      for (;;) {
        const q = new URLSearchParams({
          changed_since: String(changedSince),
          limit: String(Math.min(200, limit)),
          offset: String(offset),
        });
        const parsed = DocsResponseSchema.parse(await getJson(`/api/docs?${q}`));
        items.push(...parsed.items);
        offset += parsed.items.length;
        if (parsed.items.length === 0 || items.length >= parsed.total || items.length >= limit) break;
      }
      return items;
    },

    async getDoc(docId: string): Promise<DocDetail> {
      return DocDetailSchema.parse(await getJson(`/api/docs/${docId}`));
    },
  };
}

/** Highest open flag severity (0 when none). */
export function maxOpenSeverity(detail: DocDetail): number {
  let max = 0;
  for (const f of detail.flags) {
    if (f.open && f.severity > max) max = f.severity;
  }
  return max;
}

export function currentVersion(detail: DocDetail): z.infer<typeof VersionSchema> | null {
  return detail.versions.find((v) => v.status === 'current') ?? detail.versions[detail.versions.length - 1] ?? null;
}
