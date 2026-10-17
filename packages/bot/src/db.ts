import Database from 'better-sqlite3';

/**
 * Stretch S4: off-chain subscriptions and alert dedupe. Never exposed by the API.
 * Chat IDs live here only — never log them.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS subscriptions (
  chat_id INTEGER NOT NULL,
  filter_type TEXT NOT NULL,
  filter_value TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  PRIMARY KEY (chat_id, filter_type, filter_value)
);
CREATE TABLE IF NOT EXISTS alert_log (
  chat_id INTEGER NOT NULL,
  doc_id TEXT NOT NULL,
  norm_sha256 TEXT NOT NULL,
  stage TEXT NOT NULL,
  sent_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_log_dedupe ON alert_log(doc_id, norm_sha256, stage);
CREATE INDEX IF NOT EXISTS idx_alert_log_chat_ts ON alert_log(chat_id, sent_ts);
CREATE TABLE IF NOT EXISTS meta ( k TEXT PRIMARY KEY, v TEXT NOT NULL );
`;

export const FILTER_TYPES = ['department', 'scheme', 'doc_id', 'keyword'] as const;
export type FilterType = (typeof FILTER_TYPES)[number];

export const ALERT_STAGES = ['unconfirmed', 'confirmed'] as const;
export type AlertStage = (typeof ALERT_STAGES)[number];

export interface Subscription {
  chatId: number;
  filterType: FilterType;
  filterValue: string;
  createdTs: number;
}

export class BotDb {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  addSubscription(chatId: number, filterType: FilterType, filterValue: string, createdTs: number): boolean {
    const r = this.db
      .prepare(
        'INSERT OR IGNORE INTO subscriptions (chat_id, filter_type, filter_value, created_ts) VALUES (?, ?, ?, ?)',
      )
      .run(chatId, filterType, filterValue, createdTs);
    return r.changes > 0;
  }

  removeSubscription(chatId: number, filterType: FilterType, filterValue: string): boolean {
    const r = this.db
      .prepare('DELETE FROM subscriptions WHERE chat_id = ? AND filter_type = ? AND filter_value = ?')
      .run(chatId, filterType, filterValue);
    return r.changes > 0;
  }

  listSubscriptions(chatId: number): Subscription[] {
    const rows = this.db
      .prepare(
        'SELECT chat_id, filter_type, filter_value, created_ts FROM subscriptions WHERE chat_id = ? ORDER BY created_ts, filter_type, filter_value',
      )
      .all(chatId) as { chat_id: number; filter_type: string; filter_value: string; created_ts: number }[];
    return rows.map((r) => ({
      chatId: r.chat_id,
      filterType: r.filter_type as FilterType,
      filterValue: r.filter_value,
      createdTs: r.created_ts,
    }));
  }

  allSubscriptions(): Subscription[] {
    const rows = this.db
      .prepare(
        'SELECT chat_id, filter_type, filter_value, created_ts FROM subscriptions ORDER BY created_ts, chat_id, filter_type',
      )
      .all() as { chat_id: number; filter_type: string; filter_value: string; created_ts: number }[];
    return rows.map((r) => ({
      chatId: r.chat_id,
      filterType: r.filter_type as FilterType,
      filterValue: r.filter_value,
      createdTs: r.created_ts,
    }));
  }

  /** True when this (doc, hash, stage) was already sent to this chat. */
  wasAlerted(chatId: number, docId: string, normSha256: string, stage: AlertStage): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 AS ok FROM alert_log WHERE chat_id = ? AND doc_id = ? AND norm_sha256 = ? AND stage = ? LIMIT 1',
      )
      .get(chatId, docId, normSha256, stage) as { ok: number } | undefined;
    return row !== undefined;
  }

  /** Global dedupe key from the spec: (doc_id, norm_sha256, stage) already sent to anyone. */
  stageAlreadySent(docId: string, normSha256: string, stage: AlertStage): boolean {
    const row = this.db
      .prepare('SELECT 1 AS ok FROM alert_log WHERE doc_id = ? AND norm_sha256 = ? AND stage = ? LIMIT 1')
      .get(docId, normSha256, stage) as { ok: number } | undefined;
    return row !== undefined;
  }

  recordAlert(chatId: number, docId: string, normSha256: string, stage: AlertStage, sentTs: number): void {
    this.db
      .prepare(
        'INSERT INTO alert_log (chat_id, doc_id, norm_sha256, stage, sent_ts) VALUES (?, ?, ?, ?, ?)',
      )
      .run(chatId, docId, normSha256, stage, sentTs);
  }

  alertsInWindow(chatId: number, sinceTs: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM alert_log WHERE chat_id = ? AND sent_ts >= ?')
      .get(chatId, sinceTs) as { n: number };
    return row.n;
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(key) as { v: string } | undefined;
    return row?.v ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, value);
  }
}
