import { describe, expect, it } from 'vitest';
import { WatcherDb } from '../src/db.js';
import type { NoticeFields } from '../src/fields.js';

const FIELDS: NoticeFields = {
  title: 'Synthetic notice',
  department: null,
  scheme: null,
  printed_date_ts: 1_790_000_000,
  deadline_ts: 1_791_000_000,
  deadline_date: '2026-10-30',
  amount_paise: 150_000,
  declared_supersedes: null,
  summary_en: 'fields extracted by rules',
};

describe('WatcherDb', () => {
  it('creates a row with defaults on first upsert', () => {
    const db = new WatcherDb(':memory:');
    const row = db.upsert('a'.repeat(64), 'http://example.test/1');
    expect(row).toEqual({
      docId: 'a'.repeat(64),
      canonicalUrl: 'http://example.test/1',
      lastNormSha256: null,
      lastState: null,
      lastText: null,
      lastTextExtracted: false,
      lastFields: null,
      lastWriteTs: null,
      lastCheckTs: null,
      consecutiveFailures: 0,
      docEntityKey: null,
      lastObsEntityKey: null,
    });
    expect(db.get('b'.repeat(64))).toBeNull();
    db.close();
  });

  it('applies partial updates and round-trips fields and booleans', () => {
    const db = new WatcherDb(':memory:');
    const id = 'c'.repeat(64);
    db.upsert(id, 'http://example.test/1', {
      lastNormSha256: 'd'.repeat(64),
      lastState: 'first_seen',
      lastText: 'normalized text',
      lastTextExtracted: true,
      lastFields: FIELDS,
      lastWriteTs: 100,
      docEntityKey: '0xdoc',
    });
    const row = db.upsert(id, 'http://ignored.test/', { consecutiveFailures: 2, lastCheckTs: 200 });
    expect(row).toMatchObject({
      canonicalUrl: 'http://example.test/1',
      lastState: 'first_seen',
      lastTextExtracted: true,
      lastFields: FIELDS,
      lastWriteTs: 100,
      lastCheckTs: 200,
      consecutiveFailures: 2,
      docEntityKey: '0xdoc',
    });
    expect(db.all().map((r) => r.docId)).toEqual([id]);
    db.close();
  });

  it('reads unknown states and malformed field JSON as null', () => {
    const db = new WatcherDb(':memory:');
    const id = 'e'.repeat(64);
    db.upsert(id, 'http://example.test/1');
    const raw = (db as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }).db;
    raw.prepare('UPDATE sources SET last_state = ?, last_fields_json = ? WHERE doc_id = ?').run('bogus', '{x', id);
    expect(db.get(id)).toMatchObject({ lastState: null, lastFields: null });
    raw.prepare('UPDATE sources SET last_fields_json = ? WHERE doc_id = ?').run('{"title":1}', id);
    expect(db.get(id)?.lastFields).toBeNull();
    db.close();
  });

  it('stores meta values', () => {
    const db = new WatcherDb(':memory:');
    expect(db.getMeta('k')).toBeNull();
    db.setMeta('k', '1');
    db.setMeta('k', '2');
    expect(db.getMeta('k')).toBe('2');
    db.close();
  });
});
