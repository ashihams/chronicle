import {
  NO_CONTENT_STATES,
  buildDocAttrs,
  buildDocPayload,
  buildObservationAttrs,
  buildObservationPayload,
  classify,
  describeChanges,
  diffText,
  fieldsFromExtraction,
  finalSeverity,
  hasPdfHeader,
  normHash,
  normalizeHtml,
  normalizePdf,
  ruleSeverity,
  sha256Hex,
  simhashHex,
  type ArkivClient,
  type Config,
  type ExecTool,
  type NoticeFields,
  type ObservationState,
} from '@chronicle/core';
import type { Logger } from 'pino';
import type { WatcherDb } from './db.js';
import type { Extractor } from './extractor.js';
import {
  HostQueue,
  RobotsCache,
  fetchDocument,
  realSleep,
  type FetchFn,
  type FetchedDocument,
  type HttpOptions,
  type Sleep,
} from './fetcher.js';
import { applyFailureRule, decideWrite } from './policy.js';
import { LAST_RENEW_META_KEY, RENEW_INTERVAL_SECONDS, renewEntities, type RenewSummary } from './renew.js';
import { ruleSummary } from './summary.js';
import type { WatchedSource } from './watchlist.js';

export type WatcherSettings = Pick<
  Config['watcher'],
  | 'vantage'
  | 'userAgent'
  | 'fetchTimeoutMs'
  | 'requestDelayMsPerHost'
  | 'heartbeatHours'
  | 'observationTtlDays'
  | 'renewWhenDaysLeft'
>;

export interface WatcherOptions {
  settings: WatcherSettings;
  arkiv: ArkivClient;
  db: WatcherDb;
  extractor: Extractor;
  log: Logger;
  fetch?: FetchFn;
  /** Unix seconds. */
  now?: () => number;
  sleep?: Sleep;
  pdfExec?: ExecTool;
}

export type CheckStatus = 'written' | 'skipped' | 'blocked_by_robots' | 'error';

export interface CheckOutcome {
  docId: string;
  noticeId: string;
  status: CheckStatus;
  state: ObservationState | null;
  reason: string;
  /** Ask the scheduler to retry with backoff instead of waiting a full poll interval. */
  retry: boolean;
  entityKey?: string;
  txHash?: string;
}

interface NormalizedContent {
  text: string;
  normSha256: string;
  textExtracted: boolean;
  title: string | null;
  /** Stretch S3/S5 observation extras. */
  extras?: {
    simhashHex?: string | null;
    sigStatus?: string | null;
    sigSignerOrg?: string | null;
    pdfProducer?: string | null;
    pdfCreatedTs?: number | null;
  };
}

function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const charset = /charset=([^;\s]+)/i.exec(contentType ?? '')?.[1]?.replace(/["']/g, '');
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function parseHttpDate(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) || ms < 0 ? null : Math.floor(ms / 1000);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export class Watcher {
  private readonly queue: HostQueue;
  private readonly robots: RobotsCache;
  private readonly http: HttpOptions;
  private readonly now: () => number;
  private renewing = false;

  constructor(private readonly opts: WatcherOptions) {
    this.now = opts.now ?? ((): number => Math.floor(Date.now() / 1000));
    this.http = {
      fetch: opts.fetch ?? fetch,
      userAgent: opts.settings.userAgent,
      vantage: opts.settings.vantage,
      timeoutMs: opts.settings.fetchTimeoutMs,
    };
    this.queue = new HostQueue(opts.settings.requestDelayMsPerHost, Date.now, opts.sleep ?? realSleep);
    this.robots = new RobotsCache(this.http, this.queue);
  }

  private get ttlSeconds(): number {
    return this.opts.settings.observationTtlDays * 86400;
  }

  /** Runs one check and never throws; failures come back as status `error` with `retry`. */
  async safeCheck(src: WatchedSource): Promise<CheckOutcome> {
    try {
      return await this.check(src);
    } catch (err) {
      this.opts.log.error({ docId: src.docId, noticeId: src.noticeId, err: errorMessage(err) }, 'check failed');
      return {
        docId: src.docId,
        noticeId: src.noticeId,
        status: 'error',
        state: null,
        reason: errorMessage(err),
        retry: true,
      };
    }
  }

  async check(src: WatchedSource): Promise<CheckOutcome> {
    const { db, log } = this.opts;
    const base = { docId: src.docId, noticeId: src.noticeId };

    if (!(await this.robots.isAllowed(src.url))) {
      db.upsert(src.docId, src.canonicalUrl, { lastCheckTs: this.now() });
      log.warn({ ...base, url: src.url }, 'blocked_by_robots');
      return { ...base, status: 'blocked_by_robots', state: null, reason: 'disallowed by robots.txt', retry: false };
    }

    const observedAt = this.now();
    const fetched = await this.queue.run(new URL(src.url).host, () => fetchDocument(src.url, this.http));
    const row = db.get(src.docId);
    const content = await this.normalize(src, fetched);
    const cls = classify({
      fetch: fetched,
      source: { url: src.url, kind: src.kind, ...(src.mustContain && { mustContain: src.mustContain }) },
      content,
      prev: row?.lastNormSha256 ? { normSha256: row.lastNormSha256, textExtracted: row.lastTextExtracted } : null,
    });
    const state = cls.state;

    const failure = applyFailureRule(state, row?.consecutiveFailures ?? 0);
    const decision = failure.suppress
      ? { write: false, reason: `failure ${failure.consecutiveFailures}: ${cls.reason}` }
      : decideWrite({
          state,
          lastState: row?.lastState ?? null,
          lastWriteTs: row?.lastWriteTs ?? null,
          now: observedAt,
          heartbeatSeconds: this.opts.settings.heartbeatHours * 3600,
        });
    if (!decision.write) {
      db.upsert(src.docId, src.canonicalUrl, {
        lastCheckTs: observedAt,
        consecutiveFailures: failure.consecutiveFailures,
      });
      log.info({ ...base, state, reason: decision.reason }, 'no write');
      return { ...base, status: 'skipped', state, reason: decision.reason, retry: failure.suppress };
    }

    const hasContent = !NO_CONTENT_STATES.has(state) && content !== null;
    const prevFields = row?.lastFields ?? null;
    let fields: NoticeFields | null = state === 'present' ? prevFields : null;
    let extractor = { model: 'none', confidence: 0 };
    let llmSeverity: number | null = null;
    let llmSummary: string | null = null;

    if ((state === 'first_seen' || state === 'changed') && content !== null) {
      const res = await this.opts.extractor.extract({
        text: content.text,
        title: content.title,
        kind: src.kind,
        diffHunks: state === 'changed' && row?.lastText ? diffText(row.lastText, content.text) : [],
        previousFields: prevFields,
      });
      fields = fieldsFromExtraction(res.extraction);
      extractor = { model: res.model, confidence: res.extraction.confidence };
      if (res.usedLlm) {
        llmSummary = res.extraction.summary_en;
        if (state === 'changed') llmSeverity = res.extraction.severity;
      }
    }

    const severity = finalSeverity(ruleSeverity(state, prevFields, fields), llmSeverity);
    const changes = describeChanges({
      state,
      prevState: row?.lastState ?? null,
      prevNormSha256: row?.lastNormSha256 ?? null,
      normSha256: content?.normSha256 ?? null,
      prevFields,
      nextFields: fields,
    });
    const title = fields?.title ?? content?.title ?? prevFields?.title ?? null;
    const docEntityKey = await this.ensureDoc(src, title);

    const contentFields = hasContent ? fields : null;
    const attributes = buildObservationAttrs({
      docId: src.docId,
      noticeId: src.noticeId,
      sourceKind: src.kind,
      department: src.department,
      scheme: src.scheme ?? null,
      vantage: this.opts.settings.vantage,
      observedAt,
      state,
      httpStatus: fetched.status,
      redirectChainLen: fetched.redirectChainLen,
      rawSha256: hasContent && fetched.bytes !== null ? sha256Hex(fetched.bytes) : null,
      normSha256: hasContent ? (content?.normSha256 ?? null) : null,
      prevNormSha256: row?.lastNormSha256 ?? null,
      textExtracted: hasContent ? (content?.textExtracted ?? false) : false,
      lastModifiedTs: hasContent ? parseHttpDate(fetched.lastModified) : null,
      printedDateTs: contentFields?.printed_date_ts ?? null,
      deadlineTs: contentFields?.deadline_ts ?? null,
      deadlineDate: contentFields?.deadline_date ?? null,
      amountPaise: contentFields?.amount_paise ?? null,
      severity,
      extras: content?.extras,
    });
    const payload = buildObservationPayload({
      title,
      summaryEn: llmSummary ?? ruleSummary({ state, previousState: row?.lastState ?? null, changes, fields }),
      finalUrl: fetched.finalUrl,
      changes,
      extractor,
      declaredSupersedes: contentFields?.declared_supersedes ?? null,
    });

    const created = await this.opts.arkiv.createEntity({ attributes, payload, ttlSeconds: this.ttlSeconds });
    db.upsert(src.docId, src.canonicalUrl, {
      lastState: state,
      lastWriteTs: observedAt,
      lastCheckTs: observedAt,
      consecutiveFailures: failure.consecutiveFailures,
      lastObsEntityKey: created.key,
      docEntityKey,
      ...(hasContent &&
        content !== null && {
          lastNormSha256: content.normSha256,
          lastText: content.text,
          lastTextExtracted: content.textExtracted,
        }),
      ...((state === 'first_seen' || state === 'changed') && fields !== null && { lastFields: fields }),
    });
    log.info(
      { ...base, state, severity, reason: decision.reason, key: created.key, txHash: created.txHash },
      'observation written',
    );
    return {
      ...base,
      status: 'written',
      state,
      reason: decision.reason,
      retry: false,
      entityKey: created.key,
      txHash: created.txHash,
    };
  }

  private async normalize(src: WatchedSource, f: FetchedDocument): Promise<NormalizedContent | null> {
    if (f.status < 200 || f.status >= 300 || f.bytes === null) return null;
    if (src.kind === 'pdf') {
      if (!hasPdfHeader(f.bytes)) {
        return { text: '', normSha256: sha256Hex(f.bytes), textExtracted: false, title: null };
      }
      const pdf = await normalizePdf(f.bytes, this.opts.pdfExec ? { exec: this.opts.pdfExec } : {});
      return {
        text: pdf.text,
        normSha256: pdf.normSha256,
        textExtracted: pdf.textExtracted,
        title: null,
        extras: {
          simhashHex: pdf.textExtracted ? simhashHex(pdf.text) : null,
          sigStatus: pdf.signature.status,
          sigSignerOrg: pdf.signature.signerOrg,
          pdfProducer: pdf.meta.producer,
          pdfCreatedTs: pdf.meta.creationTs,
        },
      };
    }
    const html = normalizeHtml(decodeBody(f.bytes, f.contentType), { contentSelector: src.contentSelector });
    return {
      text: html.text,
      normSha256: normHash(html.text),
      textExtracted: true,
      title: html.title,
      extras: { simhashHex: simhashHex(html.text) },
    };
  }

  /**
   * Returns the `doc` entity key for the source: local cache, then an Arkiv query (earliest block
   * wins, any writer), else a new entity.
   */
  private async ensureDoc(src: WatchedSource, title: string | null): Promise<string> {
    const { arkiv, db, log } = this.opts;
    const cached = db.get(src.docId)?.docEntityKey;
    if (cached) return cached;

    const found = await arkiv.query({
      where: [
        { attr: 'type', op: 'eq', value: 'doc' },
        { attr: 'doc_id', op: 'eq', value: src.docId },
      ],
      limit: 200,
    });
    const earliest = [...found.items].sort((a, b) =>
      a.createdAtBlock === b.createdAtBlock ? a.key.localeCompare(b.key) : a.createdAtBlock < b.createdAtBlock ? -1 : 1,
    )[0];
    if (earliest !== undefined) {
      db.upsert(src.docId, src.canonicalUrl, { docEntityKey: earliest.key });
      log.info({ docId: src.docId, key: earliest.key }, 'doc already registered');
      return earliest.key;
    }

    const created = await arkiv.createEntity({
      attributes: buildDocAttrs({
        noticeId: src.noticeId,
        sourceKind: src.kind,
        sourceUrl: src.url,
        department: src.department,
        scheme: src.scheme ?? null,
        lang: src.lang,
      }),
      payload: buildDocPayload({ title, registeredVantage: this.opts.settings.vantage, sourceUrl: src.url }),
      ttlSeconds: this.ttlSeconds,
    });
    db.upsert(src.docId, src.canonicalUrl, { docEntityKey: created.key });
    log.info({ docId: src.docId, key: created.key, txHash: created.txHash }, 'doc registered');
    return created.key;
  }

  /**
   * Daily renewal (section 4.2 step 10). Returns null when the last pass was under a day ago or
   * another pass is running.
   */
  async renewIfDue(): Promise<RenewSummary | null> {
    if (this.renewing) return null;
    this.renewing = true;
    try {
      return await this.renewNow();
    } finally {
      this.renewing = false;
    }
  }

  private async renewNow(): Promise<RenewSummary | null> {
    const { db, arkiv, log, settings } = this.opts;
    const now = this.now();
    const last = Number(db.getMeta(LAST_RENEW_META_KEY) ?? '0');
    if (now - last < RENEW_INTERVAL_SECONDS) return null;
    const keys = db.all().flatMap((r) => [r.docEntityKey, r.lastObsEntityKey].filter((k): k is string => k !== null));
    const summary = await renewEntities({
      arkiv,
      keys,
      ttlSeconds: this.ttlSeconds,
      renewWhenSecondsLeft: settings.renewWhenDaysLeft * 86400,
      log,
    });
    db.setMeta(LAST_RENEW_META_KEY, String(now));
    log.info(summary, 'renewal pass done');
    return summary;
  }
}
