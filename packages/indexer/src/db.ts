import type { Attrs } from '@chronicle/core';
import Database from 'better-sqlite3';

/**
 * Section 6, plus derived per-doc columns on `docs` (current state and change times, used by the
 * list filters) and `ignored_keys` (entities whose attributes fail validation, so they are not
 * fetched again on every sync).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  key TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  creator TEXT NOT NULL,
  owner TEXT NOT NULL,
  created_block INTEGER NOT NULL,
  created_ts INTEGER NOT NULL,
  tx_hash TEXT,
  expires_block INTEGER,
  attrs_json TEXT NOT NULL,
  payload_json TEXT,
  payload_sha256 TEXT NOT NULL,
  mirror_attrs_sha256 TEXT NOT NULL,
  mirror_payload_sha256 TEXT NOT NULL,
  mirror_owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'live',
  first_synced_ts INTEGER NOT NULL,
  last_checked_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_doc ON entities(json_extract(attrs_json,'$.doc_id'));
CREATE INDEX IF NOT EXISTS idx_entities_creator ON entities(creator);

CREATE TABLE IF NOT EXISTS docs (
  doc_id TEXT PRIMARY KEY, notice_id TEXT, source_url TEXT, source_kind TEXT,
  department TEXT, scheme TEXT, lang TEXT, title TEXT, doc_entity_key TEXT,
  current_state TEXT, current_seq INTEGER, last_seen_ts INTEGER, last_change_ts INTEGER
);

CREATE TABLE IF NOT EXISTS versions (
  doc_id TEXT NOT NULL, normalizer_version TEXT NOT NULL, seq INTEGER NOT NULL,
  norm_sha256 TEXT NOT NULL, first_seen_block INTEGER NOT NULL, first_seen_ts INTEGER NOT NULL,
  first_entity_key TEXT NOT NULL, observer_count INTEGER NOT NULL, status TEXT NOT NULL,
  deadline_ts INTEGER, amount_paise INTEGER, summary_en TEXT,
  PRIMARY KEY (doc_id, normalizer_version, seq)
);

CREATE TABLE IF NOT EXISTS flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity INTEGER NOT NULL, details_json TEXT NOT NULL, entity_keys_json TEXT NOT NULL,
  created_ts INTEGER NOT NULL, resolved_ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_flags_doc ON flags(doc_id);

CREATE TABLE IF NOT EXISTS sync_state ( k TEXT PRIMARY KEY, v TEXT NOT NULL );
CREATE TABLE IF NOT EXISTS ignored_keys ( key TEXT PRIMARY KEY, reason TEXT NOT NULL, ts INTEGER NOT NULL );
`;

export const ENTITY_STATUSES = ['live', 'expired', 'deleted', 'modified'] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];

export interface EntityRow {
  key: string;
  type: string;
  creator: string;
  owner: string;
  createdBlock: number;
  createdTs: number;
  txHash: string | null;
  expiresBlock: number | null;
  attrs: Attrs;
  payload: unknown;
  payloadSha256: string;
  mirrorAttrsSha256: string;
  mirrorPayloadSha256: string;
  mirrorOwner: string;
  status: EntityStatus;
  firstSyncedTs: number;
  lastCheckedTs: number;
}

interface RawEntity {
  key: string;
  type: string;
  creator: string;
  owner: string;
  created_block: number;
  created_ts: number;
  tx_hash: string | null;
  expires_block: number | null;
  attrs_json: string;
  payload_json: string | null;
  payload_sha256: string;
  mirror_attrs_sha256: string;
  mirror_payload_sha256: string;
  mirror_owner: string;
  status: string;
  first_synced_ts: number;
  last_checked_ts: number;
}

function parseJson(s: string | null): unknown {
  if (s === null) return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

function toEntity(r: RawEntity): EntityRow {
  return {
    key: r.key,
    type: r.type,
    creator: r.creator,
    owner: r.owner,
    createdBlock: r.created_block,
    createdTs: r.created_ts,
    txHash: r.tx_hash,
    expiresBlock: r.expires_block,
    attrs: (parseJson(r.attrs_json) ?? {}) as Attrs,
    payload: parseJson(r.payload_json),
    payloadSha256: r.payload_sha256,
    mirrorAttrsSha256: r.mirror_attrs_sha256,
    mirrorPayloadSha256: r.mirror_payload_sha256,
    mirrorOwner: r.mirror_owner,
    status: (ENTITY_STATUSES as readonly string[]).includes(r.status) ? (r.status as EntityStatus) : 'live',
    firstSyncedTs: r.first_synced_ts,
    lastCheckedTs: r.last_checked_ts,
  };
}

export interface DocRow {
  docId: string;
  noticeId: string | null;
  sourceUrl: string | null;
  sourceKind: string | null;
  department: string | null;
  scheme: string | null;
  lang: string | null;
  title: string | null;
  docEntityKey: string | null;
  currentState: string | null;
  currentSeq: number | null;
  lastSeenTs: number | null;
  lastChangeTs: number | null;
}

interface RawDoc {
  doc_id: string;
  notice_id: string | null;
  source_url: string | null;
  source_kind: string | null;
  department: string | null;
  scheme: string | null;
  lang: string | null;
  title: string | null;
  doc_entity_key: string | null;
  current_state: string | null;
  current_seq: number | null;
  last_seen_ts: number | null;
  last_change_ts: number | null;
}

function toDoc(r: RawDoc): DocRow {
  return {
    docId: r.doc_id,
    noticeId: r.notice_id,
    sourceUrl: r.source_url,
    sourceKind: r.source_kind,
    department: r.department,
    scheme: r.scheme,
    lang: r.lang,
    title: r.title,
    docEntityKey: r.doc_entity_key,
    currentState: r.current_state,
    currentSeq: r.current_seq,
    lastSeenTs: r.last_seen_ts,
    lastChangeTs: r.last_change_ts,
  };
}

export interface VersionRow {
  docId: string;
  normalizerVersion: string;
  seq: number;
  normSha256: string;
  firstSeenBlock: number;
  firstSeenTs: number;
  firstEntityKey: string;
  observerCount: number;
  status: 'current' | 'superseded';
  deadlineTs: number | null;
  amountPaise: number | null;
  summaryEn: string | null;
}

interface RawVersion {
  doc_id: string;
  normalizer_version: string;
  seq: number;
  norm_sha256: string;
  first_seen_block: number;
  first_seen_ts: number;
  first_entity_key: string;
  observer_count: number;
  status: string;
  deadline_ts: number | null;
  amount_paise: number | null;
  summary_en: string | null;
}

function toVersion(r: RawVersion): VersionRow {
  return {
    docId: r.doc_id,
    normalizerVersion: r.normalizer_version,
    seq: r.seq,
    normSha256: r.norm_sha256,
    firstSeenBlock: r.first_seen_block,
    firstSeenTs: r.first_seen_ts,
    firstEntityKey: r.first_entity_key,
    observerCount: r.observer_count,
    status: r.status === 'current' ? 'current' : 'superseded',
    deadlineTs: r.deadline_ts,
    amountPaise: r.amount_paise,
    summaryEn: r.summary_en,
  };
}

export interface FlagRow {
  id: number;
  docId: string;
  kind: string;
  severity: number;
  details: unknown;
  entityKeys: string[];
  createdTs: number;
  resolvedTs: number | null;
}

interface RawFlag {
  id: number;
  doc_id: string;
  kind: string;
  severity: number;
  details_json: string;
  entity_keys_json: string;
  created_ts: number;
  resolved_ts: number | null;
}

function toFlag(r: RawFlag): FlagRow {
  const keys = parseJson(r.entity_keys_json);
  return {
    id: r.id,
    docId: r.doc_id,
    kind: r.kind,
    severity: r.severity,
    details: parseJson(r.details_json),
    entityKeys: Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [],
    createdTs: r.created_ts,
    resolvedTs: r.resolved_ts,
  };
}

/** A flag as computed; `entityKeys` is sorted so the same condition always has the same identity. */
export interface FlagInput {
  kind: string;
  severity: number;
  details: unknown;
  entityKeys: string[];
}

export interface DocListFilter {
  department?: string | undefined;
  scheme?: string | undefined;
  state?: string | undefined;
  changedSince?: number | undefined;
  q?: string | undefined;
  limit: number;
  offset: number;
}

export interface WatcherSummaryRow {
  creator: string;
  vantages: string[];
  observationCount: number;
  firstSeenTs: number;
  lastSeenTs: number;
  docsCovered: number;
}

export class IndexerDb {
  readonly db: Database.Database;

  /** `path` is a file path, or `:memory:` for tests. */
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- sync state -------------------------------------------------------------------------

  getState(k: string): string | null {
    const r = this.db.prepare('SELECT v FROM sync_state WHERE k = ?').get(k) as { v: string } | undefined;
    return r?.v ?? null;
  }

  getStateNumber(k: string): number | null {
    const v = this.getState(k);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  setState(k: string, v: string | number): void {
    this.db
      .prepare('INSERT INTO sync_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(k, String(v));
  }

  // ---- entities ---------------------------------------------------------------------------

  hasEntity(key: string): boolean {
    return this.db.prepare('SELECT 1 FROM entities WHERE key = ?').get(key) !== undefined;
  }

  getEntity(key: string): EntityRow | null {
    const r = this.db.prepare('SELECT * FROM entities WHERE key = ?').get(key) as RawEntity | undefined;
    return r === undefined ? null : toEntity(r);
  }

  insertEntity(e: EntityRow): void {
    this.db
      .prepare(
        `INSERT INTO entities (key, type, creator, owner, created_block, created_ts, tx_hash, expires_block,
          attrs_json, payload_json, payload_sha256, mirror_attrs_sha256, mirror_payload_sha256, mirror_owner,
          status, first_synced_ts, last_checked_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO NOTHING`,
      )
      .run(
        e.key,
        e.type,
        e.creator,
        e.owner,
        e.createdBlock,
        e.createdTs,
        e.txHash,
        e.expiresBlock,
        JSON.stringify(e.attrs),
        e.payload === null || e.payload === undefined ? null : JSON.stringify(e.payload),
        e.payloadSha256,
        e.mirrorAttrsSha256,
        e.mirrorPayloadSha256,
        e.mirrorOwner,
        e.status,
        e.firstSyncedTs,
        e.lastCheckedTs,
      );
  }

  /** Liveness updates; the mirror columns are never changed after the first sync. */
  updateEntityCheck(
    key: string,
    u: { status: EntityStatus; owner?: string; expiresBlock?: number | null; lastCheckedTs: number },
  ): void {
    this.db
      .prepare(
        `UPDATE entities SET status = ?, owner = COALESCE(?, owner),
           expires_block = CASE WHEN ? THEN ? ELSE expires_block END, last_checked_ts = ? WHERE key = ?`,
      )
      .run(
        u.status,
        u.owner ?? null,
        u.expiresBlock !== undefined ? 1 : 0,
        u.expiresBlock ?? null,
        u.lastCheckedTs,
        key,
      );
  }

  entitiesByStatus(statuses: EntityStatus[]): EntityRow[] {
    const marks = statuses.map(() => '?').join(', ');
    return (
      this.db.prepare(`SELECT * FROM entities WHERE status IN (${marks}) ORDER BY key`).all(...statuses) as RawEntity[]
    ).map(toEntity);
  }

  /** Observations of a doc in chain order (creation block, then key). */
  observationsForDoc(docId: string): EntityRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM entities WHERE type = 'observation' AND json_extract(attrs_json,'$.doc_id') = ?
           ORDER BY created_block, key`,
        )
        .all(docId) as RawEntity[]
    ).map(toEntity);
  }

  /** Live or expired entities of a given type (chain order). */
  entitiesOfType(type: string): EntityRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM entities WHERE type = ? AND status IN ('live','expired')
           ORDER BY created_block, key`,
        )
        .all(type) as RawEntity[]
    ).map(toEntity);
  }

  docEntities(docId: string): EntityRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM entities WHERE type = 'doc' AND json_extract(attrs_json,'$.doc_id') = ?
           ORDER BY created_block, key`,
        )
        .all(docId) as RawEntity[]
    ).map(toEntity);
  }

  entityCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n;
  }

  isIgnored(key: string): boolean {
    return this.db.prepare('SELECT 1 FROM ignored_keys WHERE key = ?').get(key) !== undefined;
  }

  ignore(key: string, reason: string, ts: number): void {
    this.db
      .prepare('INSERT INTO ignored_keys (key, reason, ts) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING')
      .run(key, reason.slice(0, 500), ts);
  }

  // ---- docs -------------------------------------------------------------------------------

  getDoc(docId: string): DocRow | null {
    const r = this.db.prepare('SELECT * FROM docs WHERE doc_id = ?').get(docId) as RawDoc | undefined;
    return r === undefined ? null : toDoc(r);
  }

  allDocIds(): string[] {
    return (this.db.prepare('SELECT doc_id FROM docs ORDER BY doc_id').all() as { doc_id: string }[]).map(
      (r) => r.doc_id,
    );
  }

  /** Docs that share a notice_id, grouped for stretch contradiction checks. */
  docsByNoticeId(): Map<string, DocRow[]> {
    const rows = (
      this.db.prepare('SELECT * FROM docs WHERE notice_id IS NOT NULL ORDER BY notice_id, doc_id').all() as RawDoc[]
    ).map(toDoc);
    const map = new Map<string, DocRow[]>();
    for (const d of rows) {
      if (d.noticeId === null) continue;
      const list = map.get(d.noticeId) ?? [];
      list.push(d);
      map.set(d.noticeId, list);
    }
    return map;
  }

  upsertDoc(d: Omit<DocRow, 'currentState' | 'currentSeq' | 'lastSeenTs' | 'lastChangeTs'>): void {
    this.db
      .prepare(
        `INSERT INTO docs (doc_id, notice_id, source_url, source_kind, department, scheme, lang, title, doc_entity_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(doc_id) DO UPDATE SET notice_id = excluded.notice_id, source_url = excluded.source_url,
           source_kind = excluded.source_kind, department = excluded.department, scheme = excluded.scheme,
           lang = excluded.lang, title = excluded.title, doc_entity_key = excluded.doc_entity_key`,
      )
      .run(d.docId, d.noticeId, d.sourceUrl, d.sourceKind, d.department, d.scheme, d.lang, d.title, d.docEntityKey);
  }

  setDocStatus(
    docId: string,
    s: {
      currentState: string | null;
      currentSeq: number | null;
      lastSeenTs: number | null;
      lastChangeTs: number | null;
    },
  ): void {
    this.db
      .prepare(
        'UPDATE docs SET current_state = ?, current_seq = ?, last_seen_ts = ?, last_change_ts = ? WHERE doc_id = ?',
      )
      .run(s.currentState, s.currentSeq, s.lastSeenTs, s.lastChangeTs, docId);
  }

  listDocs(f: DocListFilter): { items: DocRow[]; total: number } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.department !== undefined) {
      where.push('department = ?');
      args.push(f.department);
    }
    if (f.scheme !== undefined) {
      where.push('scheme = ?');
      args.push(f.scheme);
    }
    if (f.state !== undefined) {
      where.push('current_state = ?');
      args.push(f.state);
    }
    if (f.changedSince !== undefined) {
      where.push('last_change_ts >= ?');
      args.push(f.changedSince);
    }
    if (f.q !== undefined) {
      const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(
        "(LOWER(COALESCE(title,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(notice_id,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(source_url,'')) LIKE ? ESCAPE '\\')",
      );
      args.push(like, like, like);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM docs ${clause}`).get(...args) as { n: number }).n;
    const items = (
      this.db
        .prepare(
          `SELECT * FROM docs ${clause} ORDER BY COALESCE(last_change_ts, last_seen_ts, 0) DESC, doc_id LIMIT ? OFFSET ?`,
        )
        .all(...args, f.limit, f.offset) as RawDoc[]
    ).map(toDoc);
    return { items, total };
  }

  // ---- versions ---------------------------------------------------------------------------

  replaceVersions(docId: string, versions: VersionRow[]): void {
    this.db.prepare('DELETE FROM versions WHERE doc_id = ?').run(docId);
    const insert = this.db.prepare(
      `INSERT INTO versions (doc_id, normalizer_version, seq, norm_sha256, first_seen_block, first_seen_ts,
        first_entity_key, observer_count, status, deadline_ts, amount_paise, summary_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const v of versions) {
      insert.run(
        docId,
        v.normalizerVersion,
        v.seq,
        v.normSha256,
        v.firstSeenBlock,
        v.firstSeenTs,
        v.firstEntityKey,
        v.observerCount,
        v.status,
        v.deadlineTs,
        v.amountPaise,
        v.summaryEn,
      );
    }
  }

  versionsForDoc(docId: string): VersionRow[] {
    return (
      this.db
        .prepare('SELECT * FROM versions WHERE doc_id = ? ORDER BY normalizer_version, seq')
        .all(docId) as RawVersion[]
    ).map(toVersion);
  }

  /** Versions whose content hash equals `normSha256` (exact text / normalized-PDF match). */
  versionsByNormSha256(normSha256: string): VersionRow[] {
    return (
      this.db
        .prepare('SELECT * FROM versions WHERE norm_sha256 = ? ORDER BY doc_id, normalizer_version, seq')
        .all(normSha256) as RawVersion[]
    ).map(toVersion);
  }

  /**
   * Observations that recorded this exact PDF byte hash, with the content hash used for the
   * version chain (may be the text hash or the bytes hash when no text was extracted).
   */
  observationsByRawSha256(rawSha256: string): { docId: string; normSha256: string | null }[] {
    return (
      this.db
        .prepare(
          `SELECT json_extract(attrs_json,'$.doc_id') AS doc_id,
                  json_extract(attrs_json,'$.norm_sha256') AS norm_sha256
           FROM entities
           WHERE type = 'observation' AND json_extract(attrs_json,'$.raw_sha256') = ?`,
        )
        .all(rawSha256) as { doc_id: string | null; norm_sha256: string | null }[]
    )
      .filter((r): r is { doc_id: string; norm_sha256: string | null } => typeof r.doc_id === 'string')
      .map((r) => ({ docId: r.doc_id, normSha256: r.norm_sha256 }));
  }

  /** Stretch S5: observations that carry a 16-hex `simhash_hex` and a content hash. */
  observationsWithSimhash(): { normSha256: string; simhashHex: string }[] {
    return (
      this.db
        .prepare(
          `SELECT json_extract(attrs_json,'$.norm_sha256') AS norm_sha256,
                  json_extract(attrs_json,'$.simhash_hex') AS simhash_hex
           FROM entities
           WHERE type = 'observation'
             AND json_extract(attrs_json,'$.simhash_hex') IS NOT NULL
             AND json_extract(attrs_json,'$.norm_sha256') IS NOT NULL`,
        )
        .all() as { norm_sha256: string | null; simhash_hex: string | null }[]
    )
      .filter(
        (r): r is { norm_sha256: string; simhash_hex: string } =>
          typeof r.norm_sha256 === 'string' &&
          typeof r.simhash_hex === 'string' &&
          /^[0-9a-f]{16}$/.test(r.simhash_hex) &&
          /^[0-9a-f]{64}$/.test(r.norm_sha256),
      )
      .map((r) => ({ normSha256: r.norm_sha256, simhashHex: r.simhash_hex }));
  }

  /** Stretch S5: distinct `$creator` count and reason codes for a content hash. */
  forgeryReportStats(normSha256: string): { distinctCreators: number; reasonCodes: string[] } {
    const rows = this.db
      .prepare(
        `SELECT creator, json_extract(attrs_json,'$.reason_code') AS reason_code
         FROM entities
         WHERE type = 'forgery_report'
           AND status IN ('live','expired')
           AND json_extract(attrs_json,'$.norm_sha256') = ?`,
      )
      .all(normSha256) as { creator: string; reason_code: string | null }[];
    const creators = new Set<string>();
    const codes = new Set<string>();
    for (const r of rows) {
      creators.add(r.creator);
      if (typeof r.reason_code === 'string' && r.reason_code.length > 0) codes.add(r.reason_code);
    }
    return { distinctCreators: creators.size, reasonCodes: [...codes].sort() };
  }

  // ---- flags ------------------------------------------------------------------------------

  flagsForDoc(docId: string, openOnly = false): FlagRow[] {
    const sql = `SELECT * FROM flags WHERE doc_id = ? ${openOnly ? 'AND resolved_ts IS NULL' : ''} ORDER BY created_ts, id`;
    return (this.db.prepare(sql).all(docId) as RawFlag[]).map(toFlag);
  }

  openFlagCounts(): Map<string, { count: number; kinds: string[] }> {
    const rows = this.db
      .prepare(
        'SELECT doc_id, COUNT(*) AS n, GROUP_CONCAT(DISTINCT kind) AS kinds FROM flags WHERE resolved_ts IS NULL GROUP BY doc_id',
      )
      .all() as { doc_id: string; n: number; kinds: string | null }[];
    return new Map(
      rows.map((r) => [
        r.doc_id,
        {
          count: r.n,
          kinds: (r.kinds ?? '')
            .split(',')
            .filter((k) => k !== '')
            .sort(),
        },
      ]),
    );
  }

  /**
   * Makes the open flags of the given kinds for a doc match `desired`: new conditions open a flag,
   * existing ones are updated in place, and conditions that cleared are resolved.
   */
  reconcileFlags(docId: string, kinds: readonly string[], desired: FlagInput[], nowTs: number): void {
    const identity = (kind: string, keys: string[]): string => `${kind}|${JSON.stringify(keys)}`;
    const open = this.flagsForDoc(docId, true).filter((f) => kinds.includes(f.kind));
    const openById = new Map(open.map((f) => [identity(f.kind, f.entityKeys), f]));
    const seen = new Set<string>();
    for (const d of desired) {
      const id = identity(d.kind, d.entityKeys);
      seen.add(id);
      const existing = openById.get(id);
      if (existing !== undefined) {
        this.db
          .prepare('UPDATE flags SET severity = ?, details_json = ? WHERE id = ?')
          .run(d.severity, JSON.stringify(d.details), existing.id);
      } else {
        this.insertFlag(docId, d, nowTs);
      }
    }
    for (const f of open) {
      if (!seen.has(identity(f.kind, f.entityKeys))) {
        this.db.prepare('UPDATE flags SET resolved_ts = ? WHERE id = ?').run(nowTs, f.id);
      }
    }
  }

  /** Opens a flag unless an open flag with the same kind and entity keys exists. */
  openFlagOnce(docId: string, f: FlagInput, nowTs: number): void {
    const exists = this.flagsForDoc(docId, true).some(
      (o) => o.kind === f.kind && JSON.stringify(o.entityKeys) === JSON.stringify(f.entityKeys),
    );
    if (!exists) this.insertFlag(docId, f, nowTs);
  }

  private insertFlag(docId: string, f: FlagInput, nowTs: number): void {
    this.db
      .prepare(
        'INSERT INTO flags (doc_id, kind, severity, details_json, entity_keys_json, created_ts) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(docId, f.kind, f.severity, JSON.stringify(f.details), JSON.stringify(f.entityKeys), nowTs);
  }

  // ---- watchers ---------------------------------------------------------------------------

  /** Distinct creators that observed each doc. */
  observerCounts(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT json_extract(attrs_json,'$.doc_id') AS doc_id, COUNT(DISTINCT creator) AS n
         FROM entities WHERE type = 'observation' GROUP BY 1`,
      )
      .all() as { doc_id: string | null; n: number }[];
    return new Map(rows.filter((r) => r.doc_id !== null).map((r) => [r.doc_id as string, r.n]));
  }

  watcherSummaries(): WatcherSummaryRow[] {
    const rows = this.db
      .prepare(
        `SELECT creator,
           GROUP_CONCAT(DISTINCT json_extract(attrs_json,'$.vantage')) AS vantages,
           COUNT(*) AS n, MIN(created_ts) AS first_ts, MAX(created_ts) AS last_ts,
           COUNT(DISTINCT json_extract(attrs_json,'$.doc_id')) AS docs
         FROM entities WHERE type = 'observation' GROUP BY creator ORDER BY n DESC, creator`,
      )
      .all() as {
      creator: string;
      vantages: string | null;
      n: number;
      first_ts: number;
      last_ts: number;
      docs: number;
    }[];
    return rows.map((r) => ({
      creator: r.creator,
      vantages: (r.vantages ?? '')
        .split(',')
        .filter((v) => v !== '')
        .sort(),
      observationCount: r.n,
      firstSeenTs: r.first_ts,
      lastSeenTs: r.last_ts,
      docsCovered: r.docs,
    }));
  }
}
