import { sha256Of, type ArkivClient, type ArkivEntityRecord, type Attrs, type Where } from '@chronicle/core';
import type { Logger } from 'pino';
import type { EntityRow, IndexerDb } from './db.js';
import { CONTRADICTION_FLAG_KINDS, pagePdfContradiction, type SourceSnapshot } from './contradiction.js';
import { DERIVED_FLAG_KINDS, deriveDoc, type ObsInput } from './derive.js';
import {
  DocAttrsSchema,
  DocPayloadSchema,
  IndexSnapshotAttrsSchema,
  IndexSnapshotPayloadSchema,
  ObservationAttrsSchema,
  ObservationPayloadSchema,
  rejectReason,
} from './schema.js';
import { PDF_PROVENANCE_FLAG_KINDS, pdfProvenanceFlags } from './pdf-provenance.js';
import { STEALTH_FLAG_KINDS, stealthFlagsFromSnapshots, type IndexSnapshotView } from './stealth.js';

/** Observations are re-queried from this far before the newest `observed_at` already synced. */
export const OBSERVED_AT_OVERLAP_SECONDS = 86400;
/** A full query of all observations runs this often, to catch any with an unusual `observed_at`. */
export const FULL_SYNC_INTERVAL_SECONDS = 3600;
const PAGE_LIMIT = 200;
const MAX_PAGES = 100;

export const LIVENESS_FLAG_KINDS = ['missing', 'owner_modified'] as const;

export interface IndexerSettings {
  disagreeWindowMinutes: number;
  backdateDays: number;
  clockSkewSeconds: number;
}

export interface SyncSummary {
  full: boolean;
  candidates: number;
  added: number;
  ignored: number;
  head: number;
  docs: number;
}

export interface LivenessSummary {
  checked: number;
  expired: number;
  deleted: number;
  modified: number;
  ownerChanged: number;
}

export const STATE_KEYS = {
  lastSyncTs: 'last_sync_ts',
  lastFullSyncTs: 'last_full_sync_ts',
  lastObservedAt: 'last_observed_at',
  chainHead: 'chain_head',
  lastLivenessTs: 'last_liveness_ts',
} as const;

function attrsOf<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  a: Attrs,
): T | null {
  const r = schema.safeParse(a);
  return r.success ? r.data : null;
}

/** Mirror row for a freshly fetched entity. The mirror columns are set here, once. */
export function toEntityRow(rec: ArkivEntityRecord, createdTs: number, nowTs: number): EntityRow {
  return {
    key: rec.key,
    type: String(rec.attributes.type),
    creator: rec.creator,
    owner: rec.owner,
    createdBlock: Number(rec.createdAtBlock),
    createdTs,
    txHash: rec.txHash,
    expiresBlock: rec.expiresAtBlock === null ? null : Number(rec.expiresAtBlock),
    attrs: rec.attributes,
    payload: rec.payload,
    payloadSha256: rec.payloadSha256,
    mirrorAttrsSha256: sha256Of(rec.attributes),
    mirrorPayloadSha256: rec.payloadSha256,
    mirrorOwner: rec.owner,
    status: 'live',
    firstSyncedTs: nowTs,
    lastCheckedTs: nowTs,
  };
}

export class Indexer {
  constructor(
    private readonly arkiv: ArkivClient,
    private readonly db: IndexerDb,
    private readonly settings: IndexerSettings,
    private readonly log: Logger,
  ) {}

  private async queryAll(where: Where[]): Promise<ArkivEntityRecord[]> {
    const out: ArkivEntityRecord[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await this.arkiv.query({ where, limit: PAGE_LIMIT, ...(cursor !== undefined && { cursor }) });
      out.push(...r.items);
      if (r.nextCursor === undefined || r.items.length === 0) return out;
      cursor = r.nextCursor;
    }
    this.log.warn({ where }, 'query stopped at the page limit');
    return out;
  }

  /**
   * Section 5.1 with the `observed_at_window` strategy: all `doc` and `index_snapshot` entities, and
   * observations with `observed_at` at or after a day before the newest one already synced (all of
   * them on the first run and once an hour). New keys are fetched in full and mirrored; then every
   * doc is recomputed.
   */
  async sync(): Promise<SyncSummary> {
    const head = await this.arkiv.currentBlock();
    const nowTs = await this.arkiv.blockTimestamp(head);
    const lastFull = this.db.getStateNumber(STATE_KEYS.lastFullSyncTs);
    const lastObservedAt = this.db.getStateNumber(STATE_KEYS.lastObservedAt);
    const full = lastFull === null || lastObservedAt === null || nowTs - lastFull >= FULL_SYNC_INTERVAL_SECONDS;

    const obsWhere: Where[] = [{ attr: 'type', op: 'eq', value: 'observation' }];
    if (!full && lastObservedAt !== null) {
      obsWhere.push({
        attr: 'observed_at',
        op: 'gte',
        value: Math.max(0, lastObservedAt - OBSERVED_AT_OVERLAP_SECONDS),
      });
    }
    const candidates = [
      ...(await this.queryAll([{ attr: 'type', op: 'eq', value: 'doc' }])),
      ...(await this.queryAll(obsWhere)),
      ...(await this.queryAll([{ attr: 'type', op: 'eq', value: 'index_snapshot' }])),
    ];

    let added = 0;
    let ignored = 0;
    let maxObservedAt = lastObservedAt ?? 0;
    const seen = new Set<string>();
    for (const c of candidates) {
      if (seen.has(c.key) || this.db.hasEntity(c.key) || this.db.isIgnored(c.key)) continue;
      seen.add(c.key);
      const reason = rejectReason(c.attributes);
      if (reason !== null) {
        this.db.ignore(c.key, reason, nowTs);
        ignored += 1;
        continue;
      }
      const rec = await this.arkiv.getEntity(c.key);
      if (rec === null) continue;
      const createdTs = await this.arkiv.blockTimestamp(rec.createdAtBlock);
      const row = toEntityRow(rec, createdTs, nowTs);
      this.db.transaction(() => {
        this.db.insertEntity(row);
        this.upsertDocFrom(row);
      });
      const observedAt = rec.attributes.observed_at;
      if (row.type === 'observation' && typeof observedAt === 'number') {
        maxObservedAt = Math.max(maxObservedAt, observedAt);
      }
      added += 1;
    }

    this.db.setState(STATE_KEYS.lastSyncTs, nowTs);
    this.db.setState(STATE_KEYS.chainHead, Number(head));
    this.db.setState(STATE_KEYS.lastObservedAt, maxObservedAt);
    if (full) this.db.setState(STATE_KEYS.lastFullSyncTs, nowTs);

    const docs = this.recomputeAll(nowTs);
    const summary = { full, candidates: candidates.length, added, ignored, head: Number(head), docs };
    if (added > 0 || ignored > 0) this.log.info(summary, 'sync done');
    return summary;
  }

  /**
   * `docs` comes from `doc` entities (earliest creation block wins) and, until one exists, from
   * observation attributes.
   */
  private upsertDocFrom(row: EntityRow): void {
    if (row.type === 'doc') {
      const a = attrsOf(DocAttrsSchema, row.attrs);
      if (a === null) return;
      const existing = this.db.getDoc(a.doc_id);
      if (existing?.docEntityKey) {
        const current = this.db.getEntity(existing.docEntityKey);
        if (
          current !== null &&
          (current.createdBlock < row.createdBlock ||
            (current.createdBlock === row.createdBlock && current.key < row.key))
        ) {
          return;
        }
      }
      const p = DocPayloadSchema.parse(row.payload);
      this.db.upsertDoc({
        docId: a.doc_id,
        noticeId: a.notice_id,
        sourceUrl: p.source_url ?? a.source_url ?? null,
        sourceKind: a.source_kind,
        department: a.department,
        scheme: a.scheme ?? null,
        lang: a.lang,
        title: p.title ?? existing?.title ?? null,
        docEntityKey: row.key,
      });
      return;
    }
    if (row.type === 'observation') {
      const a = attrsOf(ObservationAttrsSchema, row.attrs);
      if (a === null) return;
      const existing = this.db.getDoc(a.doc_id);
      if (existing?.docEntityKey) return;
      const p = ObservationPayloadSchema.parse(row.payload);
      this.db.upsertDoc({
        docId: a.doc_id,
        noticeId: existing?.noticeId ?? a.notice_id,
        sourceUrl: existing?.sourceUrl ?? null,
        sourceKind: existing?.sourceKind ?? a.source_kind,
        department: existing?.department ?? a.department,
        scheme: existing?.scheme ?? a.scheme ?? null,
        lang: existing?.lang ?? null,
        title: existing?.title ?? p.title,
        docEntityKey: null,
      });
    }
  }

  /** Section 5.3 for one doc: versions, derived flags and the cached status columns. */
  recompute(docId: string, nowTs: number): void {
    const obs: ObsInput[] = [];
    for (const e of this.db.observationsForDoc(docId)) {
      const attrs = attrsOf(ObservationAttrsSchema, e.attrs);
      if (attrs === null) continue;
      obs.push({
        key: e.key,
        creator: e.creator,
        createdBlock: e.createdBlock,
        createdTs: e.createdTs,
        status: e.status,
        attrs,
        summaryEn: ObservationPayloadSchema.parse(e.payload).summary_en,
      });
    }
    const derived = deriveDoc(obs, {
      nowTs,
      disagreeWindowSeconds: this.settings.disagreeWindowMinutes * 60,
      backdateSeconds: this.settings.backdateDays * 86400,
      clockSkewSeconds: this.settings.clockSkewSeconds,
    });
    const provenance = pdfProvenanceFlags(obs);
    this.db.transaction(() => {
      this.db.replaceVersions(
        docId,
        derived.versions.map((v) => ({ ...v, docId })),
      );
      this.db.reconcileFlags(docId, DERIVED_FLAG_KINDS, derived.flags, nowTs);
      this.db.reconcileFlags(docId, PDF_PROVENANCE_FLAG_KINDS, provenance, nowTs);
      this.db.setDocStatus(docId, derived.status);
    });
  }

  recomputeAll(nowTs: number): number {
    const ids = this.db.allDocIds();
    for (const id of ids) this.recompute(id, nowTs);
    this.recomputeContradictions(nowTs);
    this.recomputeStealthRemovals(nowTs);
    return ids.length;
  }

  /**
   * Stretch S2: diff consecutive `index_snapshot` entities per creator; flag vanished
   * docs as delisted / stealth_removed / declared_withdrawn.
   */
  recomputeStealthRemovals(nowTs: number): void {
    const views: IndexSnapshotView[] = [];
    for (const e of this.db.entitiesOfType('index_snapshot')) {
      const attrs = attrsOf(IndexSnapshotAttrsSchema, e.attrs);
      if (attrs === null) continue;
      const payload = IndexSnapshotPayloadSchema.parse(e.payload ?? {});
      views.push({
        key: e.key,
        creator: e.creator,
        indexId: attrs.index_id,
        createdBlock: e.createdBlock,
        links: payload.links.map((l) => ({ docId: l.doc_id, title: l.title })),
      });
    }
    const desiredByDoc = stealthFlagsFromSnapshots(views, (docId) => this.latestObsHint(docId));
    const allDocIds = new Set([...this.db.allDocIds(), ...desiredByDoc.keys()]);
    for (const docId of allDocIds) {
      const desired = desiredByDoc.get(docId);
      this.db.reconcileFlags(docId, STEALTH_FLAG_KINDS, desired === undefined ? [] : [desired], nowTs);
    }
  }

  private latestObsHint(docId: string): { state: string | null; httpStatus: number | null; title: string | null } {
    let best: EntityRow | null = null;
    for (const e of this.db.observationsForDoc(docId)) {
      if (e.status !== 'live' && e.status !== 'expired') continue;
      if (
        best === null ||
        e.createdBlock > best.createdBlock ||
        (e.createdBlock === best.createdBlock && e.key > best.key)
      ) {
        best = e;
      }
    }
    if (best === null) return { state: null, httpStatus: null, title: null };
    const attrs = attrsOf(ObservationAttrsSchema, best.attrs);
    const title =
      best.payload !== null && typeof best.payload === 'object' && 'title' in best.payload
        ? typeof (best.payload as { title: unknown }).title === 'string'
          ? (best.payload as { title: string }).title
          : null
        : null;
    return {
      state: attrs?.state ?? null,
      httpStatus: attrs?.http_status ?? null,
      title,
    };
  }

  /**
   * Stretch S1: for each notice_id with both page and PDF docs, flag when latest
   * deadline_ts / amount_paise disagree. Flags are mirrored onto both docs.
   */
  recomputeContradictions(nowTs: number): void {
    for (const [, docs] of this.db.docsByNoticeId()) {
      const pageDoc = docs.find((d) => d.sourceKind === 'page');
      const pdfDoc = docs.find((d) => d.sourceKind === 'pdf');
      const page = pageDoc !== undefined ? this.latestSourceSnapshot(pageDoc.docId, 'page') : null;
      const pdf = pdfDoc !== undefined ? this.latestSourceSnapshot(pdfDoc.docId, 'pdf') : null;
      const flag = page !== null && pdf !== null ? pagePdfContradiction(page, pdf) : null;
      const desired = flag === null ? [] : [flag];
      for (const d of docs) {
        if (d.sourceKind === 'page' || d.sourceKind === 'pdf') {
          this.db.reconcileFlags(d.docId, CONTRADICTION_FLAG_KINDS, desired, nowTs);
        }
      }
    }
  }

  private latestSourceSnapshot(docId: string, sourceKind: 'page' | 'pdf'): SourceSnapshot | null {
    const CONTENT = new Set(['first_seen', 'present', 'changed']);
    let best: ObsInput | null = null;
    for (const e of this.db.observationsForDoc(docId)) {
      if (e.status !== 'live' && e.status !== 'expired') continue;
      const attrs = attrsOf(ObservationAttrsSchema, e.attrs);
      if (attrs === null || !CONTENT.has(attrs.state) || attrs.norm_sha256 === undefined) continue;
      const o: ObsInput = {
        key: e.key,
        creator: e.creator,
        createdBlock: e.createdBlock,
        createdTs: e.createdTs,
        status: e.status,
        attrs,
        summaryEn: null,
      };
      if (
        best === null ||
        o.createdBlock > best.createdBlock ||
        (o.createdBlock === best.createdBlock && o.key > best.key)
      ) {
        best = o;
      }
    }
    if (best === null) return null;
    return {
      docId,
      sourceKind,
      key: best.key,
      deadlineTs: best.attrs.deadline_ts ?? null,
      deadlineDate: best.attrs.deadline_date ?? null,
      amountPaise: best.attrs.amount_paise ?? null,
    };
  }

  /** Section 5.2: re-reads every live entity and records expiry, deletion, modification and transfers. */
  async liveness(): Promise<LivenessSummary> {
    const head = await this.arkiv.currentBlock();
    const nowTs = await this.arkiv.blockTimestamp(head);
    const summary: LivenessSummary = { checked: 0, expired: 0, deleted: 0, modified: 0, ownerChanged: 0 };
    const touched = new Set<string>();
    for (const e of this.db.entitiesByStatus(['live'])) {
      summary.checked += 1;
      const docId = typeof e.attrs.doc_id === 'string' ? e.attrs.doc_id : null;
      let rec: ArkivEntityRecord | null;
      try {
        rec = await this.arkiv.getEntity(e.key);
      } catch (err) {
        this.log.warn({ key: e.key, err: err instanceof Error ? err.message : String(err) }, 'liveness read failed');
        continue;
      }
      if (rec === null) {
        if (e.expiresBlock !== null && BigInt(e.expiresBlock) <= head) {
          this.db.updateEntityCheck(e.key, { status: 'expired', lastCheckedTs: nowTs });
          summary.expired += 1;
        } else {
          this.db.updateEntityCheck(e.key, { status: 'deleted', lastCheckedTs: nowTs });
          if (docId !== null) {
            this.db.openFlagOnce(
              docId,
              {
                kind: 'missing',
                severity: 2,
                details: { type: e.type, expires_block: e.expiresBlock },
                entityKeys: [e.key],
              },
              nowTs,
            );
          }
          summary.deleted += 1;
        }
        if (docId !== null) touched.add(docId);
        continue;
      }
      const ownerChanged = rec.owner !== e.owner;
      if (ownerChanged) {
        this.log.info({ key: e.key, from: e.owner, to: rec.owner }, 'entity owner changed');
        summary.ownerChanged += 1;
      }
      const modified = rec.payloadSha256 !== e.mirrorPayloadSha256 || sha256Of(rec.attributes) !== e.mirrorAttrsSha256;
      if (modified) {
        summary.modified += 1;
        if (docId !== null) {
          this.db.openFlagOnce(
            docId,
            {
              kind: 'owner_modified',
              severity: 3,
              details: {
                type: e.type,
                owner: rec.owner,
                payload_changed: rec.payloadSha256 !== e.mirrorPayloadSha256,
                attributes_changed: sha256Of(rec.attributes) !== e.mirrorAttrsSha256,
              },
              entityKeys: [e.key],
            },
            nowTs,
          );
          touched.add(docId);
        }
      }
      this.db.updateEntityCheck(e.key, {
        status: modified ? 'modified' : 'live',
        owner: rec.owner,
        expiresBlock: rec.expiresAtBlock === null ? null : Number(rec.expiresAtBlock),
        lastCheckedTs: nowTs,
      });
    }
    for (const id of touched) this.recompute(id, nowTs);
    this.db.setState(STATE_KEYS.lastLivenessTs, nowTs);
    if (summary.expired + summary.deleted + summary.modified + summary.ownerChanged > 0) {
      this.log.info(summary, 'liveness done');
    }
    return summary;
  }
}
