import { existsSync } from 'node:fs';
import {
  PopplerMissingError,
  REMOVAL_STATES,
  hasPdfHeader,
  normalizePdf,
  normalizeText,
  normHash,
  sha256Hex,
  sha256Of,
  type ArkivClient,
  type ArkivEntityRecord,
  type ExecTool,
  type Where,
} from '@chronicle/core';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import { buildEvidenceBundle } from './bundle-build.js';
import type { DocRow, EntityRow, FlagRow, IndexerDb, VersionRow } from './db.js';
import { STATE_KEYS } from './indexer.js';
import { explorerLinks, RateLimiter, resolveStatic } from './http-util.js';
import { parseReplyLang } from './match-i18n.js';
import { lookupMatch } from './match-lookup.js';
import { ObservationAttrsSchema, ObservationPayloadSchema, rejectReason } from './schema.js';

export interface ApiOptions {
  db: IndexerDb;
  arkiv: ArkivClient;
  explorerBase: string;
  log: Logger;
  /** Built web app (`packages/web/dist`); served with SPA fallback when it exists. */
  webDist?: string;
  /** Wall clock in unix seconds, for `/api/arkiv/changes`. */
  now?: () => number;
  rateLimit?: { max: number; windowMs: number };
  /** Max upload size for `/api/match` PDFs (from `BOT_MAX_FILE_MB`). */
  maxFileMb?: number;
  /** Injectable poppler runner for tests. */
  pdfExec?: ExecTool;
  /** Embedded in evidence bundles so `chronicle verify` knows which chain to use. */
  chainId: number;
  rpcHttp: string;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const docIdParam = z.object({ docId: z.string().regex(/^[0-9a-f]{64}$/, 'docId must be 64 lowercase hex characters') });
const keyParam = z.object({
  key: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'key must be 0x followed by 64 hex characters')
    .transform((k) => k.toLowerCase()),
});
const addressParam = z.object({
  address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'address must be 0x followed by 40 hex characters')
    .transform((a) => a.toLowerCase()),
});
const slug = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'must be a lowercase slug');
const deptParam = z.object({ dept: slug });
const unix = z.coerce.number().int().nonnegative();
const limit = (def: number): z.ZodDefault<z.ZodNumber> => z.coerce.number().int().min(1).max(200).default(def);
const cursor = z.string().min(1).max(512).optional();

const docsQuery = z
  .object({
    department: slug.optional(),
    scheme: slug.optional(),
    state: z.string().min(1).max(32).optional(),
    changed_since: unix.optional(),
    q: z.string().trim().min(1).max(200).optional(),
    limit: limit(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();
const changesQuery = z
  .object({
    days: z.coerce.number().int().min(1).max(365).default(30),
    field: z.enum(['deadline', 'amount', 'any']).default('any'),
    limit: limit(100),
    cursor,
  })
  .strict();
const liveQuerySchema = z.object({ limit: limit(100), cursor }).strict();

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new ApiError(
      400,
      'bad_request',
      r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
    );
  }
  return r.data;
}

function num(v: bigint | null): number | null {
  return v === null ? null : Number(v);
}

function docView(d: DocRow): Record<string, unknown> {
  return {
    doc_id: d.docId,
    notice_id: d.noticeId,
    title: d.title,
    source_url: d.sourceUrl,
    source_kind: d.sourceKind,
    department: d.department,
    scheme: d.scheme,
    lang: d.lang,
    doc_entity_key: d.docEntityKey,
    current_state: d.currentState,
    current_seq: d.currentSeq,
    last_seen_ts: d.lastSeenTs,
    last_change_ts: d.lastChangeTs,
  };
}

function versionView(v: VersionRow, db?: IndexerDb): Record<string, unknown> {
  let summary_ta: string | null = null;
  let summary_hi: string | null = null;
  if (db !== undefined) {
    const first = db.getEntity(v.firstEntityKey);
    if (first !== null) {
      const payload = ObservationPayloadSchema.parse(first.payload);
      summary_ta = payload.summary_ta;
      summary_hi = payload.summary_hi;
    }
  }
  return {
    normalizer_version: v.normalizerVersion,
    seq: v.seq,
    norm_sha256: v.normSha256,
    first_seen_block: v.firstSeenBlock,
    first_seen_ts: v.firstSeenTs,
    first_entity_key: v.firstEntityKey,
    observer_count: v.observerCount,
    status: v.status,
    deadline_ts: v.deadlineTs,
    amount_paise: v.amountPaise,
    summary_en: v.summaryEn,
    summary_ta,
    summary_hi,
  };
}

function flagView(f: FlagRow): Record<string, unknown> {
  return {
    id: f.id,
    kind: f.kind,
    severity: f.severity,
    details: f.details,
    entity_keys: f.entityKeys,
    created_ts: f.createdTs,
    resolved_ts: f.resolvedTs,
    open: f.resolvedTs === null,
  };
}

/** Latest observation that carries PDF provenance attrs (stretch S3). */
function latestPdfProvenance(obs: EntityRow[]): {
  sig_status: string | null;
  sig_signer_org: string | null;
  pdf_producer: string | null;
  pdf_created_ts: number | null;
} | null {
  let best: EntityRow | null = null;
  for (const e of obs) {
    if (e.status !== 'live' && e.status !== 'expired') continue;
    if (e.attrs.sig_status === undefined && e.attrs.pdf_producer === undefined && e.attrs.pdf_created_ts === undefined) {
      continue;
    }
    if (
      best === null ||
      e.createdBlock > best.createdBlock ||
      (e.createdBlock === best.createdBlock && e.key > best.key)
    ) {
      best = e;
    }
  }
  if (best === null) return null;
  return {
    sig_status: typeof best.attrs.sig_status === 'string' ? best.attrs.sig_status : null,
    sig_signer_org: typeof best.attrs.sig_signer_org === 'string' ? best.attrs.sig_signer_org : null,
    pdf_producer: typeof best.attrs.pdf_producer === 'string' ? best.attrs.pdf_producer : null,
    pdf_created_ts: typeof best.attrs.pdf_created_ts === 'number' ? best.attrs.pdf_created_ts : null,
  };
}

function mirrorView(e: EntityRow): Record<string, unknown> {
  return {
    key: e.key,
    type: e.type,
    creator: e.creator,
    owner: e.owner,
    created_block: e.createdBlock,
    created_ts: e.createdTs,
    tx_hash: e.txHash,
    expires_block: e.expiresBlock,
    attributes: e.attrs,
    payload: e.payload,
    payload_sha256: e.payloadSha256,
    mirror_attrs_sha256: e.mirrorAttrsSha256,
    mirror_payload_sha256: e.mirrorPayloadSha256,
    mirror_owner: e.mirrorOwner,
    status: e.status,
    first_synced_ts: e.firstSyncedTs,
    last_checked_ts: e.lastCheckedTs,
  };
}

function recordView(r: ArkivEntityRecord): Record<string, unknown> {
  return {
    key: r.key,
    creator: r.creator,
    owner: r.owner,
    created_block: num(r.createdAtBlock),
    expires_block: num(r.expiresAtBlock),
    tx_hash: r.txHash,
    attributes: r.attributes,
    payload: r.payload,
    payload_sha256: r.payloadSha256,
    attrs_sha256: sha256Of(r.attributes),
  };
}

interface Observer {
  creator: string;
  vantages: string[];
  observation_count: number;
  latest_state: string | null;
  latest_norm_sha256: string | null;
  latest_created_ts: number;
  latest_entity_key: string;
}

/** Per-creator view of a doc's observations, in chain order of their latest observation. */
function observersOf(obs: EntityRow[]): Observer[] {
  const byCreator = new Map<string, Observer>();
  for (const e of obs) {
    const vantage = typeof e.attrs.vantage === 'string' ? e.attrs.vantage : null;
    const prev = byCreator.get(e.creator);
    const vantages = new Set(prev?.vantages ?? []);
    if (vantage !== null) vantages.add(vantage);
    byCreator.set(e.creator, {
      creator: e.creator,
      vantages: [...vantages].sort(),
      observation_count: (prev?.observation_count ?? 0) + 1,
      latest_state: typeof e.attrs.state === 'string' ? e.attrs.state : null,
      latest_norm_sha256: typeof e.attrs.norm_sha256 === 'string' ? e.attrs.norm_sha256 : null,
      latest_created_ts: e.createdTs,
      latest_entity_key: e.key,
    });
  }
  return [...byCreator.values()].sort((a, b) => a.latest_created_ts - b.latest_created_ts);
}

export interface TimelineEvent {
  kind: 'observation' | 'version' | 'flag';
  ts: number;
  [k: string]: unknown;
}

const KIND_ORDER: Record<TimelineEvent['kind'], number> = { observation: 0, version: 1, flag: 2 };

/** Observation, version-boundary and flag events ordered by chain time. */
export function buildTimeline(
  obs: EntityRow[],
  versions: VersionRow[],
  flags: FlagRow[],
  links: ReturnType<typeof explorerLinks>,
): TimelineEvent[] {
  const events: (TimelineEvent & { order: number })[] = [];
  obs.forEach((e, i) => {
    const payload = ObservationPayloadSchema.parse(e.payload);
    events.push({
      kind: 'observation',
      ts: e.createdTs,
      order: i,
      key: e.key,
      creator: e.creator,
      owner: e.owner,
      owner_differs: e.owner !== e.creator,
      vantage: e.attrs.vantage ?? null,
      created_block: e.createdBlock,
      created_ts: e.createdTs,
      observed_at: e.attrs.observed_at ?? null,
      state: e.attrs.state ?? null,
      norm_sha256: e.attrs.norm_sha256 ?? null,
      raw_sha256: e.attrs.raw_sha256 ?? null,
      prev_norm_sha256: e.attrs.prev_norm_sha256 ?? null,
      normalizer_version: e.attrs.normalizer_version ?? null,
      summary_en: payload.summary_en,
      summary_ta: payload.summary_ta,
      summary_hi: payload.summary_hi,
      changes: payload.changes,
      severity: e.attrs.severity ?? null,
      sig_status: e.attrs.sig_status ?? null,
      sig_signer_org: e.attrs.sig_signer_org ?? null,
      pdf_producer: e.attrs.pdf_producer ?? null,
      pdf_created_ts: e.attrs.pdf_created_ts ?? null,
      entity_status: e.status,
      explorer_url: links.entity(e.key),
      tx_url: e.txHash === null ? null : links.tx(e.txHash),
    });
  });
  for (const v of versions) {
    events.push({
      kind: 'version',
      ts: v.firstSeenTs,
      order: v.seq,
      label: `version ${v.seq} first seen`,
      seq: v.seq,
      normalizer_version: v.normalizerVersion,
      norm_sha256: v.normSha256,
      first_seen_block: v.firstSeenBlock,
      first_entity_key: v.firstEntityKey,
      status: v.status,
    });
  }
  for (const f of flags) {
    events.push({ ...flagView(f), kind: 'flag', flag_kind: f.kind, ts: f.createdTs, order: f.id });
  }
  events.sort((a, b) => a.ts - b.ts || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.order - b.order);
  return events.map(({ order: _order, ...e }) => e);
}

/** Where clauses for `/api/arkiv/changes`. */
export function changesWhere(nowTs: number, days: number, field: 'deadline' | 'amount' | 'any'): Where[] {
  const where: Where[] = [
    { attr: 'type', op: 'eq', value: 'observation' },
    { attr: 'state', op: 'eq', value: 'changed' },
    { attr: 'observed_at', op: 'gte', value: Math.max(0, Math.floor(nowTs) - days * 86400) },
  ];
  if (field === 'deadline') where.push({ attr: 'deadline_ts', op: 'gte', value: 0 });
  if (field === 'amount') where.push({ attr: 'amount_paise', op: 'gte', value: 0 });
  return where;
}

export async function buildApi(o: ApiOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true });
  const links = explorerLinks(o.explorerBase);
  const limiter = new RateLimiter(o.rateLimit?.max ?? 60, o.rateLimit?.windowMs ?? 60_000);
  const now = o.now ?? ((): number => Date.now() / 1000);
  const webDist = o.webDist !== undefined && existsSync(o.webDist) ? o.webDist : undefined;
  const maxFileBytes = Math.max(1, o.maxFileMb ?? 10) * 1024 * 1024;

  await app.register(multipart, {
    limits: { files: 1, fileSize: maxFileBytes, fields: 4, parts: 8 },
  });

  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD') reply.header('access-control-allow-origin', '*');
    if (!req.url.startsWith('/api/')) return;
    const wait = limiter.hit(req.ip);
    if (wait > 0) {
      reply.header('retry-after', String(wait));
      throw new ApiError(429, 'rate_limited', 'Too many requests; try again later');
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      void reply.status(err.status).send({ error: err.message, code: err.code });
      return;
    }
    o.log.error({ err: err.message }, 'api error');
    void reply.status(500).send({ error: 'Internal error', code: 'internal' });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || webDist === undefined || (req.method !== 'GET' && req.method !== 'HEAD')) {
      void reply.status(404).send({ error: 'Not found', code: 'not_found' });
      return;
    }
    const file = resolveStatic(webDist, req.url);
    if (file === null) {
      void reply.status(404).send({ error: 'Not found', code: 'not_found' });
      return;
    }
    void reply.type(file.contentType).send(file.body);
  });

  async function live<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      o.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'live Arkiv request failed');
      throw new ApiError(502, 'arkiv_unavailable', 'Arkiv could not be reached');
    }
  }

  async function liveQuery(
    reply: FastifyReply,
    where: Where[],
    q: { limit: number; cursor?: string | undefined },
    extra: { creator?: string; postFilter?: (r: ArkivEntityRecord) => boolean; postFilterNote?: string } = {},
  ): Promise<Record<string, unknown>> {
    const result = await live(() =>
      o.arkiv.query({
        where,
        limit: q.limit,
        ...(q.cursor !== undefined && { cursor: q.cursor }),
        ...(extra.creator !== undefined && { creator: extra.creator }),
      }),
    );
    let ignored = 0;
    const items = result.items.filter((r) => {
      if (rejectReason(r.attributes) !== null) {
        ignored += 1;
        return false;
      }
      return extra.postFilter === undefined || extra.postFilter(r);
    });
    void reply.header('cache-control', 'no-store');
    return {
      source: 'arkiv-live',
      where,
      ...(extra.creator !== undefined && { creator: extra.creator }),
      ...(extra.postFilterNote !== undefined && { post_filter: extra.postFilterNote }),
      block_number: Number(result.blockNumber),
      next_cursor: result.nextCursor ?? null,
      ignored_invalid: ignored,
      items: items.map((r) => ({ ...recordView(r), explorer_url: links.entity(r.key) })),
    };
  }

  app.get('/api/health', async () => ({
    ok: true,
    lastSyncTs: o.db.getStateNumber(STATE_KEYS.lastSyncTs),
    lastLivenessTs: o.db.getStateNumber(STATE_KEYS.lastLivenessTs),
    entityCount: o.db.entityCount(),
    chainHead: o.db.getStateNumber(STATE_KEYS.chainHead),
  }));

  app.get('/api/docs', async (req) => {
    const q = parse(docsQuery, req.query);
    const { items, total } = o.db.listDocs({
      department: q.department,
      scheme: q.scheme,
      state: q.state,
      changedSince: q.changed_since,
      q: q.q,
      limit: q.limit,
      offset: q.offset,
    });
    const flags = o.db.openFlagCounts();
    const observers = o.db.observerCounts();
    return {
      total,
      limit: q.limit,
      offset: q.offset,
      items: items.map((d) => {
        const current = o.db.versionsForDoc(d.docId).find((v) => v.status === 'current' && v.seq === d.currentSeq);
        return {
          ...docView(d),
          observer_count: observers.get(d.docId) ?? 0,
          open_flags: flags.get(d.docId) ?? { count: 0, kinds: [] },
          current_version:
            current === undefined
              ? null
              : {
                  seq: current.seq,
                  deadline_ts: current.deadlineTs,
                  amount_paise: current.amountPaise,
                  summary_en: current.summaryEn,
                },
        };
      }),
    };
  });

  function requireDoc(docId: string): DocRow {
    const doc = o.db.getDoc(docId);
    if (doc === null) throw new ApiError(404, 'not_found', 'No such doc');
    return doc;
  }

  app.get('/api/docs/:docId', async (req) => {
    const { docId } = parse(docIdParam, req.params);
    const doc = requireDoc(docId);
    const obs = o.db.observationsForDoc(docId);
    return {
      doc: { ...docView(doc), doc_entity_url: doc.docEntityKey === null ? null : links.entity(doc.docEntityKey) },
      status: {
        current_state: doc.currentState,
        current_seq: doc.currentSeq,
        last_seen_ts: doc.lastSeenTs,
        last_change_ts: doc.lastChangeTs,
        removed: doc.currentState !== null && REMOVAL_STATES.has(doc.currentState as never),
      },
      versions: o.db.versionsForDoc(docId).map((v) => versionView(v, o.db)),
      flags: o.db.flagsForDoc(docId).map(flagView),
      observers: observersOf(obs).map((w) => ({ ...w, explorer_url: links.address(w.creator) })),
      observation_count: obs.length,
      provenance: latestPdfProvenance(obs),
    };
  });

  app.get('/api/docs/:docId/timeline', async (req) => {
    const { docId } = parse(docIdParam, req.params);
    requireDoc(docId);
    return {
      doc_id: docId,
      events: buildTimeline(o.db.observationsForDoc(docId), o.db.versionsForDoc(docId), o.db.flagsForDoc(docId), links),
    };
  });

  app.get('/api/watchers', async () => ({
    items: o.db.watcherSummaries().map((w) => ({
      creator: w.creator,
      vantages: w.vantages,
      observation_count: w.observationCount,
      first_seen_ts: w.firstSeenTs,
      last_seen_ts: w.lastSeenTs,
      docs_covered: w.docsCovered,
      explorer_url: links.address(w.creator),
    })),
  }));

  app.get('/api/entities/:key', async (req, reply) => {
    const { key } = parse(keyParam, req.params);
    const mirror = o.db.getEntity(key);
    const rec = await live(() => o.arkiv.getEntity(key));
    if (mirror === null && rec === null)
      throw new ApiError(404, 'not_found', 'No such entity in the mirror or on Arkiv');
    void reply.header('cache-control', 'no-store');
    const matches =
      mirror !== null &&
      rec !== null &&
      rec.payloadSha256 === mirror.mirrorPayloadSha256 &&
      sha256Of(rec.attributes) === mirror.mirrorAttrsSha256;
    return {
      key,
      mirror: mirror === null ? null : mirrorView(mirror),
      live: rec === null ? null : recordView(rec),
      matches_mirror: matches,
      owner_changed: mirror !== null && rec !== null && rec.owner !== mirror.mirrorOwner,
      explorer_url: links.entity(key),
    };
  });

  app.get('/api/arkiv/changes', async (req, reply) => {
    const q = parse(changesQuery, req.query);
    const where = changesWhere(now(), q.days, q.field);
    const field = q.field;
    return liveQuery(
      reply,
      where,
      q,
      field === 'any'
        ? {}
        : {
            postFilter: (r) =>
              ObservationPayloadSchema.parse(r.payload).changes.some((c) => c.field === field) &&
              ObservationAttrsSchema.safeParse(r.attributes).success,
            postFilterNote: `payload.changes contains field "${field}"`,
          },
    );
  });

  app.get('/api/arkiv/by-department/:dept', async (req, reply) => {
    const { dept } = parse(deptParam, req.params);
    const q = parse(liveQuerySchema, req.query);
    return liveQuery(
      reply,
      [
        { attr: 'type', op: 'eq', value: 'observation' },
        { attr: 'department', op: 'eq', value: dept },
      ],
      q,
    );
  });

  app.get('/api/arkiv/by-creator/:address', async (req, reply) => {
    const { address } = parse(addressParam, req.params);
    const q = parse(liveQuerySchema, req.query);
    return liveQuery(reply, [{ attr: 'type', op: 'eq', value: 'observation' }], q, { creator: address });
  });

  const matchTextBody = z
    .object({
      text: z.string().min(1, 'text must not be empty').max(2_000_000),
      lang: z.enum(['en', 'ta', 'hi']).optional(),
    })
    .strict();
  const matchLangQuery = z.object({ lang: z.enum(['en', 'ta', 'hi']).optional() }).strict();

  app.get('/api/bundle/:docId', async (req, reply) => {
    const { docId } = parse(docIdParam, req.params);
    const bundle = buildEvidenceBundle(o.db, docId, {
      chainId: o.chainId,
      rpc: o.rpcHttp,
      generatedAt: Math.floor(now()),
    });
    if (bundle === null) throw new ApiError(404, 'not_found', 'No such doc');
    void reply
      .header('content-disposition', `attachment; filename="chronicle-${docId.slice(0, 12)}.json"`)
      .header('cache-control', 'no-store');
    return bundle;
  });

  /**
   * Stage 6 verifier: normalizes text or a PDF in memory (poppler may use a deleted temp file),
   * hashes it, and looks up mirrored versions. The body is never logged or stored in SQLite.
   */
  app.post('/api/match', async (req) => {
    const qLang = matchLangQuery.safeParse(req.query);
    const langFromQuery = qLang.success ? qLang.data.lang : undefined;
    const ctype = req.headers['content-type'] ?? '';
    if (ctype.includes('multipart/form-data')) {
      let file: { buffer: Buffer; filename: string; mimetype: string } | null = null;
      let textField: string | undefined;
      let langField: string | undefined;
      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (file !== null) throw new ApiError(400, 'bad_request', 'Only one file is accepted');
            const buffer = await part.toBuffer();
            file = { buffer, filename: part.filename, mimetype: part.mimetype };
          } else if (part.fieldname === 'text' && typeof part.value === 'string') {
            textField = part.value;
          } else if (part.fieldname === 'lang' && typeof part.value === 'string') {
            langField = part.value;
          }
        }
      } catch (err) {
        if (err instanceof ApiError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (/limit|too large|file size/i.test(msg)) {
          throw new ApiError(413, 'payload_too_large', `PDF must be at most ${o.maxFileMb ?? 10} MB`);
        }
        throw new ApiError(400, 'bad_request', 'Could not read multipart body');
      }
      const lang = parseReplyLang(langField ?? langFromQuery);
      if (file !== null) {
        return matchPdf(file.buffer, o, lang);
      }
      if (textField !== undefined) {
        const { text } = parse(matchTextBody, { text: textField });
        const normalized = normalizeText(text);
        return lookupMatch(o.db, {
          normSha256: normHash(normalized),
          normalizedText: normalized,
          lang,
        });
      }
      throw new ApiError(400, 'bad_request', 'multipart body must include file or text');
    }

    const body = parse(matchTextBody, req.body);
    const normalized = normalizeText(body.text);
    return lookupMatch(o.db, {
      normSha256: normHash(normalized),
      normalizedText: normalized,
      lang: parseReplyLang(body.lang ?? langFromQuery),
    });
  });

  return app;
}

async function matchPdf(
  bytes: Buffer,
  o: ApiOptions,
  lang: ReturnType<typeof parseReplyLang> = 'en',
): Promise<ReturnType<typeof lookupMatch>> {
  if (bytes.byteLength === 0) throw new ApiError(400, 'bad_request', 'Empty file');
  if (bytes.byteLength > Math.max(1, o.maxFileMb ?? 10) * 1024 * 1024) {
    throw new ApiError(413, 'payload_too_large', `PDF must be at most ${o.maxFileMb ?? 10} MB`);
  }
  const u8 = new Uint8Array(bytes);
  if (!hasPdfHeader(u8)) throw new ApiError(400, 'bad_request', 'File is not a PDF');
  const rawSha256 = sha256Hex(u8);
  try {
    const pdf = await normalizePdf(u8, o.pdfExec !== undefined ? { exec: o.pdfExec } : {});
    return lookupMatch(o.db, {
      normSha256: pdf.normSha256,
      rawSha256,
      normalizedText: pdf.textExtracted ? pdf.text : undefined,
      lang,
    });
  } catch (err) {
    if (err instanceof PopplerMissingError) {
      throw new ApiError(503, 'poppler_missing', 'PDF tools are not installed on this server');
    }
    o.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'pdf normalize failed');
    throw new ApiError(400, 'bad_request', 'Could not read PDF');
  }
}
