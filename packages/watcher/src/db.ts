import { OBSERVATION_STATES, type ObservationState } from '@chronicle/core';
import Database from 'better-sqlite3';
import { NoticeFieldsSchema, type NoticeFields } from './fields.js';

/**
 * Section 6 `sources` table plus `last_text_extracted` (classify needs it to spot a PDF that lost
 * its text layer). `last_text` is normalized text kept locally for diffs and never published.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  doc_id TEXT PRIMARY KEY, canonical_url TEXT, last_norm_sha256 TEXT, last_state TEXT,
  last_text TEXT,
  last_fields_json TEXT, last_write_ts INTEGER, last_check_ts INTEGER,
  consecutive_failures INTEGER DEFAULT 0, doc_entity_key TEXT, last_obs_entity_key TEXT,
  last_text_extracted INTEGER
);
CREATE TABLE IF NOT EXISTS meta ( k TEXT PRIMARY KEY, v TEXT NOT NULL );
`;

export interface SourceRow {
  docId: string;
  canonicalUrl: string;
  lastNormSha256: string | null;
  lastState: ObservationState | null;
  lastText: string | null;
  lastTextExtracted: boolean;
  lastFields: NoticeFields | null;
  lastWriteTs: number | null;
  lastCheckTs: number | null;
  consecutiveFailures: number;
  docEntityKey: string | null;
  lastObsEntityKey: string | null;
}

interface RawRow {
  doc_id: string;
  canonical_url: string | null;
  last_norm_sha256: string | null;
  last_state: string | null;
  last_text: string | null;
  last_fields_json: string | null;
  last_write_ts: number | null;
  last_check_ts: number | null;
  consecutive_failures: number | null;
  doc_entity_key: string | null;
  last_obs_entity_key: string | null;
  last_text_extracted: number | null;
}

function parseState(s: string | null): ObservationState | null {
  return s !== null && (OBSERVATION_STATES as readonly string[]).includes(s) ? (s as ObservationState) : null;
}

function parseFields(json: string | null): NoticeFields | null {
  if (json === null) return null;
  try {
    const parsed = NoticeFieldsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function fromRaw(r: RawRow): SourceRow {
  return {
    docId: r.doc_id,
    canonicalUrl: r.canonical_url ?? '',
    lastNormSha256: r.last_norm_sha256,
    lastState: parseState(r.last_state),
    lastText: r.last_text,
    lastTextExtracted: r.last_text_extracted === 1,
    lastFields: parseFields(r.last_fields_json),
    lastWriteTs: r.last_write_ts,
    lastCheckTs: r.last_check_ts,
    consecutiveFailures: r.consecutive_failures ?? 0,
    docEntityKey: r.doc_entity_key,
    lastObsEntityKey: r.last_obs_entity_key,
  };
}

const COLUMNS: Record<keyof Omit<SourceRow, 'docId'>, string> = {
  canonicalUrl: 'canonical_url',
  lastNormSha256: 'last_norm_sha256',
  lastState: 'last_state',
  lastText: 'last_text',
  lastTextExtracted: 'last_text_extracted',
  lastFields: 'last_fields_json',
  lastWriteTs: 'last_write_ts',
  lastCheckTs: 'last_check_ts',
  consecutiveFailures: 'consecutive_failures',
  docEntityKey: 'doc_entity_key',
  lastObsEntityKey: 'last_obs_entity_key',
};

type SqlValue = string | number | null;

function toSql(key: keyof typeof COLUMNS, value: SourceRow[keyof typeof COLUMNS]): SqlValue {
  if (key === 'lastFields') return value === null ? null : JSON.stringify(value);
  if (key === 'lastTextExtracted') return value ? 1 : 0;
  return value as SqlValue;
}

export type SourceUpdate = Partial<Omit<SourceRow, 'docId'>>;

export class WatcherDb {
  private readonly db: Database.Database;

  /** `path` is a file path, or `:memory:` for tests. */
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  get(docId: string): SourceRow | null {
    const r = this.db.prepare('SELECT * FROM sources WHERE doc_id = ?').get(docId) as RawRow | undefined;
    return r === undefined ? null : fromRaw(r);
  }

  /** Creates the row if needed and applies the given column updates. */
  upsert(docId: string, canonicalUrl: string, update: SourceUpdate = {}): SourceRow {
    this.db
      .prepare('INSERT INTO sources (doc_id, canonical_url) VALUES (?, ?) ON CONFLICT(doc_id) DO NOTHING')
      .run(docId, canonicalUrl);
    const keys = (Object.keys(update) as (keyof typeof COLUMNS)[]).filter((k) => update[k] !== undefined);
    if (keys.length > 0) {
      const sets = keys.map((k) => `${COLUMNS[k]} = ?`).join(', ');
      const values = keys.map((k) => toSql(k, update[k] as SourceRow[typeof k]));
      this.db.prepare(`UPDATE sources SET ${sets} WHERE doc_id = ?`).run(...values, docId);
    }
    const row = this.get(docId);
    if (row === null) throw new Error(`source row ${docId} vanished`);
    return row;
  }

  all(): SourceRow[] {
    return (this.db.prepare('SELECT * FROM sources ORDER BY doc_id').all() as RawRow[]).map(fromRaw);
  }

  getMeta(k: string): string | null {
    const r = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined;
    return r?.v ?? null;
  }

  setMeta(k: string, v: string): void {
    this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  close(): void {
    this.db.close();
  }
}
