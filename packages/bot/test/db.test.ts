import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BotDb } from '../src/db.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

function openDb(): BotDb {
  const dir = mkdtempSync(join(tmpdir(), 'chronicle-bot-'));
  dirs.push(dir);
  return new BotDb(join(dir, 'bot.db'));
}

describe('BotDb', () => {
  it('stores subscriptions and alert dedupe without exposing APIs', () => {
    const db = openDb();
    expect(db.addSubscription(42, 'department', 'demo-dept', 100)).toBe(true);
    expect(db.addSubscription(42, 'department', 'demo-dept', 100)).toBe(false);
    expect(db.listSubscriptions(42)).toHaveLength(1);
    expect(db.removeSubscription(42, 'department', 'demo-dept')).toBe(true);

    const doc = 'a'.repeat(64);
    const hash = 'b'.repeat(64);
    expect(db.wasAlerted(42, doc, hash, 'unconfirmed')).toBe(false);
    db.recordAlert(42, doc, hash, 'unconfirmed', 200);
    expect(db.wasAlerted(42, doc, hash, 'unconfirmed')).toBe(true);
    expect(db.alertsInWindow(42, 150)).toBe(1);
    expect(db.alertsInWindow(42, 250)).toBe(0);
    db.close();
  });

  it('persists the changed_since cursor in meta', () => {
    const db = openDb();
    expect(db.getMeta('changed_since_cursor')).toBeNull();
    db.setMeta('changed_since_cursor', '1760000000');
    expect(db.getMeta('changed_since_cursor')).toBe('1760000000');
    db.close();
  });
});
