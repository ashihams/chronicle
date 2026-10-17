import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocDetail, DocListItem, IndexerClient } from '../src/api-client.js';
import { BotDb } from '../src/db.js';
import { startDispatcher } from '../src/dispatcher.js';

const dirs: string[] = [];
const DOC = 'a'.repeat(64);
const HASH = 'c'.repeat(64);

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

function listItem(over: Partial<DocListItem> = {}): DocListItem {
  return {
    doc_id: DOC,
    notice_id: 'demo-1',
    title: 'Synthetic Notice',
    department: 'demo-dept',
    scheme: 'demo-merit',
    current_state: 'changed',
    last_change_ts: 1_760_000_100,
    observer_count: 1,
    open_flags: { count: 1, kinds: ['vantage_disagreement'] },
    current_version: { seq: 2, deadline_ts: null, amount_paise: null, summary_en: 'deadline 15 Nov -> 30 Oct' },
    ...over,
  };
}

function detail(over: { observers?: number; severity?: number } = {}): DocDetail {
  const n = over.observers ?? 1;
  return {
    doc: listItem(),
    status: {
      current_state: 'changed',
      current_seq: 2,
      last_seen_ts: 1_760_000_100,
      last_change_ts: 1_760_000_100,
      removed: false,
    },
    versions: [
      {
        seq: 2,
        norm_sha256: HASH,
        first_seen_ts: 1_760_000_050,
        observer_count: n,
        status: 'current',
        summary_en: 'deadline 15 Nov -> 30 Oct',
      },
    ],
    flags: [
      {
        kind: 'vantage_disagreement',
        severity: over.severity ?? 2,
        open: true,
      },
    ],
    observers: Array.from({ length: n }, (_, i) => ({ creator: `0x${i}` })),
    observation_count: n,
  };
}

describe('dispatcher', () => {
  it('sends UNCONFIRMED once, then CONFIRMED when a second watcher appears', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronicle-bot-'));
    dirs.push(dir);
    const db = new BotDb(join(dir, 'bot.db'));
    db.addSubscription(99, 'department', 'demo-dept', 1);
    db.setMeta('changed_since_cursor', '1760000000');

    const sent: { chatId: number; text: string }[] = [];
    let observers = 1;
    const client: IndexerClient = {
      listChangedSince: async () => [listItem()],
      getDoc: async () => detail({ observers, severity: 2 }),
    };

    const d = startDispatcher({
      db,
      apiBaseUrl: 'http://localhost:8080',
      log: pino({ level: 'silent' }),
      client,
      pollOnce: true,
      now: () => 1_760_000_200,
      send: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    });

    const first = await d.tick();
    expect(first.sent).toBe(1);
    expect(sent[0]?.text).toMatch(/^UNCONFIRMED:/);
    expect(sent[0]?.chatId).toBe(99);

    const second = await d.tick();
    expect(second.sent).toBe(0);

    observers = 2;
    const third = await d.tick();
    expect(third.sent).toBe(1);
    expect(sent[1]?.text).toMatch(/^CONFIRMED:/);

    d.stop();
    db.close();
  });

  it('respects the 5 alerts per chat per hour cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronicle-bot-'));
    dirs.push(dir);
    const db = new BotDb(join(dir, 'bot.db'));
    db.addSubscription(7, 'department', 'demo-dept', 1);
    db.setMeta('changed_since_cursor', '1');
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      db.recordAlert(7, `d${i}`.padEnd(64, '0'), `h${i}`.padEnd(64, '0'), 'unconfirmed', now - 10);
    }

    const sent: string[] = [];
    const client: IndexerClient = {
      listChangedSince: async () => [listItem({ last_change_ts: now })],
      getDoc: async () => detail({ observers: 1, severity: 2 }),
    };
    const d = startDispatcher({
      db,
      apiBaseUrl: 'http://localhost:8080',
      log: pino({ level: 'silent' }),
      client,
      pollOnce: true,
      now: () => now,
      send: async (_c, text) => {
        sent.push(text);
      },
    });
    expect((await d.tick()).sent).toBe(0);
    expect(sent).toHaveLength(0);
    d.stop();
    db.close();
  });
});
