import { describe, expect, it } from 'vitest';
import { IndexerDb } from '../src/db.js';
import { FULL_SYNC_INTERVAL_SECONDS, Indexer, STATE_KEYS } from '../src/indexer.js';
import { ADDR_A, ADDR_B, Chain, DAY, DOC_ID, DOC_ID_2, H, SETTINGS, docAttrs, obsAttrs, silentLog } from './helpers.js';

function setup(): { chain: Chain; db: IndexerDb; indexer: Indexer } {
  const chain = new Chain();
  const db = new IndexerDb(':memory:');
  // the indexer reads through a client without a wallet of its own
  const reader = chain.a.withAddress('0x00000000000000000000000000000000000000ff');
  return { chain, db, indexer: new Indexer(reader, db, SETTINGS, silentLog) };
}

const kinds = (db: IndexerDb, docId = DOC_ID, open = true): string[] =>
  db
    .flagsForDoc(docId, open)
    .map((f) => f.kind)
    .sort();

describe('Indexer.sync', () => {
  it('mirrors docs and observations and builds the version chain', async () => {
    const { chain, db, indexer } = setup();
    const docKey = await chain.doc(chain.a);
    const k1 = await chain.observe(chain.a, { state: 'first_seen', hash: H(1), deadlineTs: 1_900_000_000 });
    chain.advance(DAY);
    const k2 = await chain.observe(chain.a, { state: 'changed', hash: H(2) }, { summary_en: 'Deadline moved.' });

    const s = await indexer.sync();
    expect(s).toMatchObject({ full: true, added: 3, ignored: 0, docs: 1 });
    expect(db.getDoc(DOC_ID)).toMatchObject({
      docEntityKey: docKey,
      title: 'Synthetic circular',
      sourceUrl: 'https://example.test/circulars/1',
      currentState: 'changed',
      currentSeq: 2,
    });
    const versions = db.versionsForDoc(DOC_ID);
    expect(versions.map((v) => [v.seq, v.normSha256, v.firstEntityKey, v.status])).toEqual([
      [1, H(1), k1, 'superseded'],
      [2, H(2), k2, 'current'],
    ]);
    expect(versions[0]?.deadlineTs).toBe(1_900_000_000);
    expect(versions[1]?.summaryEn).toBe('Deadline moved.');
    const mirrored = db.getEntity(k1);
    expect(mirrored).toMatchObject({ creator: ADDR_A, owner: ADDR_A, status: 'live' });
    expect(mirrored?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(mirrored?.createdTs).toBe(chain.network.timestampOf(BigInt(mirrored?.createdBlock ?? 0)));
    expect(db.getStateNumber(STATE_KEYS.chainHead)).toBe(s.head);
    expect(kinds(db)).toEqual([]);

    expect((await indexer.sync()).added).toBe(0);
  });

  it('ignores entities that fail validation and does not fetch them again', async () => {
    const { chain, db, indexer } = setup();
    const bad = await chain.a.createEntity({
      attributes: { type: 'observation', schema_v: 1, doc_id: 'not-a-hash' },
      payload: {},
      ttlSeconds: DAY,
    });
    await chain.a.createEntity({ attributes: { type: 'doc', schema_v: 2 }, payload: {}, ttlSeconds: DAY });
    expect(await indexer.sync()).toMatchObject({ added: 0, ignored: 2, docs: 0 });
    expect(db.isIgnored(bad.key)).toBe(true);
    expect(await indexer.sync()).toMatchObject({ added: 0, ignored: 0 });
  });

  it('creates the doc from observations and lets the earliest doc entity win', async () => {
    const { chain, db, indexer } = setup();
    await chain.observe(chain.b, { hash: H(1), docId: DOC_ID_2 }, { title: 'From observation' });
    await indexer.sync();
    expect(db.getDoc(DOC_ID_2)).toMatchObject({
      docEntityKey: null,
      title: 'From observation',
      department: 'synthetic-dept',
    });

    const early = await chain.doc(chain.b, DOC_ID_2, 'Earliest doc');
    await chain.doc(chain.a, DOC_ID_2, 'Later duplicate');
    await indexer.sync();
    expect(db.getDoc(DOC_ID_2)).toMatchObject({ docEntityKey: early, title: 'Earliest doc' });
  });

  it('queries a window of observed_at between full passes', async () => {
    const { chain, db, indexer } = setup();
    await chain.observe(chain.a, { hash: H(1) });
    expect((await indexer.sync()).full).toBe(true);

    // a watcher that claims a time far in the past is outside the window, so only a full pass sees it
    const odd = await chain.observe(chain.b, { hash: H(1), observedAt: chain.t - 5 * DAY });
    chain.advance(60);
    expect(await indexer.sync()).toMatchObject({ full: false, added: 0 });
    chain.advance(FULL_SYNC_INTERVAL_SECONDS);
    expect(await indexer.sync()).toMatchObject({ full: true, added: 1 });
    expect(db.hasEntity(odd)).toBe(true);
    expect(kinds(db)).toEqual(['clock_skew']);
  });

  it('flags vantage disagreement and clears it when the watchers agree again', async () => {
    const { chain, db, indexer } = setup();
    await chain.observe(chain.a, { hash: H(1), vantage: 'in-a' });
    chain.advance(120);
    await chain.observe(chain.b, { hash: H(2), vantage: 'eu-b' });
    await indexer.sync();
    expect(kinds(db)).toEqual(['vantage_disagreement']);
    expect(db.versionsForDoc(DOC_ID)).toHaveLength(2);

    chain.advance(120);
    await chain.observe(chain.a, { hash: H(2), state: 'changed', vantage: 'in-a' });
    await indexer.sync();
    expect(kinds(db)).toEqual([]);
    expect(kinds(db, DOC_ID, false)).toEqual(['vantage_disagreement']);
  });

  it('flags backdating and clock skew from scripted observations', async () => {
    const { chain, db, indexer } = setup();
    await chain.observe(chain.a, { hash: H(1), printedDateTs: chain.t - DAY });
    chain.advance(30 * DAY);
    await chain.observe(chain.a, { hash: H(2), state: 'changed', printedDateTs: chain.t - 20 * DAY });
    await chain.observe(chain.b, { hash: H(2), observedAt: chain.t + 3 * 3600 });
    await indexer.sync();
    expect(kinds(db)).toEqual(['backdated', 'clock_skew']);
  });
});

describe('Indexer.liveness', () => {
  it('detects owner modification, deletion, expiry and transfers', async () => {
    const { chain, db, indexer } = setup();
    const docKey = await chain.doc(chain.a);
    const modified = await chain.observe(chain.a, { hash: H(1) });
    const relabelled = await chain.observe(chain.a, { hash: H(1) });
    const deleted = await chain.observe(chain.a, { hash: H(2), state: 'changed' });
    const expired = (
      await chain.b.createEntity({
        attributes: obsAttrs({ observedAt: chain.t, hash: H(1) }),
        payload: {},
        ttlSeconds: DAY,
      })
    ).key;
    await indexer.sync();
    expect(db.versionsForDoc(DOC_ID)).toHaveLength(2);

    chain.network.__setPayload(modified, { summary_en: 'rewritten' });
    chain.network.__setAttributes(relabelled, { severity: 0, department: 'other-dept' });
    chain.network.__delete(deleted);
    chain.network.__transfer(docKey, ADDR_B);
    chain.advance(2 * DAY);

    const s = await indexer.liveness();
    expect(s).toEqual({ checked: 5, expired: 1, deleted: 1, modified: 2, ownerChanged: 1 });
    expect(db.getEntity(modified)?.status).toBe('modified');
    expect(db.getEntity(relabelled)?.status).toBe('modified');
    expect(db.getEntity(deleted)?.status).toBe('deleted');
    expect(db.getEntity(expired)?.status).toBe('expired');
    expect(db.getEntity(docKey)).toMatchObject({ status: 'live', owner: ADDR_B, mirrorOwner: ADDR_A });

    const flags = db.flagsForDoc(DOC_ID, true);
    expect(flags.filter((f) => f.kind === 'owner_modified').map((f) => [f.severity, f.entityKeys[0]])).toEqual([
      [3, modified],
      [3, relabelled],
    ]);
    expect(flags.find((f) => f.kind === 'missing')).toMatchObject({ severity: 2, entityKeys: [deleted] });
    expect(flags.find((f) => f.kind === 'owner_modified' && f.entityKeys[0] === modified)?.details).toMatchObject({
      payload_changed: true,
      attributes_changed: false,
    });

    // the deleted version is gone from the chain; the expired observation still counts
    expect(db.versionsForDoc(DOC_ID).map((v) => [v.normSha256, v.observerCount])).toEqual([[H(1), 1]]);

    expect(await indexer.liveness()).toMatchObject({ checked: 1, modified: 0 });
    expect(db.flagsForDoc(DOC_ID).filter((f) => f.kind === 'missing')).toHaveLength(1);
    expect(db.getStateNumber(STATE_KEYS.lastLivenessTs)).not.toBeNull();
  });

  it('skips an entity whose read fails and checks it next time', async () => {
    const { chain, db, indexer } = setup();
    const key = await chain.observe(chain.a, { hash: H(1) });
    await indexer.sync();
    const failing = new Indexer(
      Object.assign(Object.create(chain.a) as typeof chain.a, {
        getEntity: () => Promise.reject(new Error('rpc down')),
      }),
      db,
      SETTINGS,
      silentLog,
    );
    expect(await failing.liveness()).toMatchObject({ checked: 1, deleted: 0 });
    expect(db.getEntity(key)?.status).toBe('live');
  });

  it('flags a deleted doc entity as missing on its doc', async () => {
    const { chain, db, indexer } = setup();
    const k = await chain.a.createEntity({ attributes: docAttrs(DOC_ID), payload: {}, ttlSeconds: DAY });
    await indexer.sync();
    chain.network.__delete(k.key);
    await indexer.liveness();
    expect(db.flagsForDoc(DOC_ID).map((f) => f.kind)).toEqual(['missing']);
  });
});
