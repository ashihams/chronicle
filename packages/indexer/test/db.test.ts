import { describe, expect, it } from 'vitest';
import { IndexerDb, type EntityRow } from '../src/db.js';
import { ADDR_A, ADDR_B, DOC_ID, DOC_ID_2, T0, obsAttrs } from './helpers.js';

function entity(key: string, over: Partial<EntityRow> = {}): EntityRow {
  return {
    key,
    type: 'observation',
    creator: ADDR_A,
    owner: ADDR_A,
    createdBlock: 10,
    createdTs: T0,
    txHash: null,
    expiresBlock: 1000,
    attrs: obsAttrs({ observedAt: T0 }),
    payload: { summary_en: 'x' },
    payloadSha256: 'p',
    mirrorAttrsSha256: 'a',
    mirrorPayloadSha256: 'p',
    mirrorOwner: ADDR_A,
    status: 'live',
    firstSyncedTs: T0,
    lastCheckedTs: T0,
    ...over,
  };
}

function doc(
  docId: string,
  over: Partial<Parameters<IndexerDb['upsertDoc']>[0]> = {},
): Parameters<IndexerDb['upsertDoc']>[0] {
  return {
    docId,
    noticeId: 'synthetic-001',
    sourceUrl: 'https://example.test/a',
    sourceKind: 'page',
    department: 'dept-a',
    scheme: null,
    lang: 'en',
    title: 'Synthetic title',
    docEntityKey: null,
    ...over,
  };
}

describe('IndexerDb', () => {
  it('stores sync state', () => {
    const db = new IndexerDb(':memory:');
    expect(db.getState('x')).toBeNull();
    db.setState('x', 5);
    db.setState('x', 7);
    expect(db.getStateNumber('x')).toBe(7);
    db.setState('y', 'not-a-number');
    expect(db.getStateNumber('y')).toBeNull();
  });

  it('inserts entities once and keeps the mirror columns on liveness updates', () => {
    const db = new IndexerDb(':memory:');
    db.insertEntity(entity('0x1'));
    db.insertEntity(entity('0x1', { owner: ADDR_B }));
    expect(db.entityCount()).toBe(1);
    db.updateEntityCheck('0x1', { status: 'modified', owner: ADDR_B, lastCheckedTs: T0 + 5 });
    expect(db.getEntity('0x1')).toMatchObject({
      status: 'modified',
      owner: ADDR_B,
      mirrorOwner: ADDR_A,
      expiresBlock: 1000,
      lastCheckedTs: T0 + 5,
    });
    db.updateEntityCheck('0x1', { status: 'expired', expiresBlock: null, lastCheckedTs: T0 + 6 });
    expect(db.getEntity('0x1')).toMatchObject({ status: 'expired', owner: ADDR_B, expiresBlock: null });
    expect(db.entitiesByStatus(['live'])).toEqual([]);
    expect(db.getEntity('0xnope')).toBeNull();
  });

  it('lists observations of a doc in chain order', () => {
    const db = new IndexerDb(':memory:');
    db.insertEntity(entity('0xb', { createdBlock: 5 }));
    db.insertEntity(entity('0xa', { createdBlock: 5 }));
    db.insertEntity(entity('0xc', { createdBlock: 4 }));
    db.insertEntity(entity('0xd', { attrs: obsAttrs({ observedAt: T0, docId: DOC_ID_2 }) }));
    expect(db.observationsForDoc(DOC_ID).map((e) => e.key)).toEqual(['0xc', '0xa', '0xb']);
    expect(db.observerCounts().get(DOC_ID)).toBe(1);
  });

  it('remembers ignored keys', () => {
    const db = new IndexerDb(':memory:');
    db.ignore('0x1', 'bad', T0);
    db.ignore('0x1', 'again', T0);
    expect(db.isIgnored('0x1')).toBe(true);
    expect(db.isIgnored('0x2')).toBe(false);
  });

  it('filters and searches docs', () => {
    const db = new IndexerDb(':memory:');
    db.upsertDoc(doc(DOC_ID, { title: 'Scholarship 100%_extended' }));
    db.upsertDoc(doc(DOC_ID_2, { department: 'dept-b', title: 'Other' }));
    db.setDocStatus(DOC_ID, { currentState: 'changed', currentSeq: 2, lastSeenTs: T0, lastChangeTs: T0 });
    db.setDocStatus(DOC_ID_2, { currentState: 'present', currentSeq: 1, lastSeenTs: T0 + 5, lastChangeTs: null });
    const ids = (f: Partial<Parameters<IndexerDb['listDocs']>[0]>): string[] =>
      db.listDocs({ limit: 50, offset: 0, ...f }).items.map((d) => d.docId);
    expect(ids({})).toEqual([DOC_ID_2, DOC_ID]);
    expect(ids({ department: 'dept-b' })).toEqual([DOC_ID_2]);
    expect(ids({ state: 'changed' })).toEqual([DOC_ID]);
    expect(ids({ changedSince: T0 })).toEqual([DOC_ID]);
    expect(ids({ q: '100%_' })).toEqual([DOC_ID]);
    expect(ids({ q: '%' })).toEqual([DOC_ID]);
    expect(ids({ q: 'OTHER' })).toEqual([DOC_ID_2]);
    expect(db.listDocs({ limit: 1, offset: 1 })).toMatchObject({ total: 2, items: [{ docId: DOC_ID }] });
  });

  it('reconciles derived flags: open, update in place, resolve', () => {
    const db = new IndexerDb(':memory:');
    const f = { kind: 'clock_skew', severity: 1, details: { d: 1 }, entityKeys: ['0x1'] };
    db.reconcileFlags(DOC_ID, ['clock_skew'], [f], T0);
    db.reconcileFlags(DOC_ID, ['clock_skew'], [{ ...f, details: { d: 2 } }], T0 + 1);
    let flags = db.flagsForDoc(DOC_ID);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ details: { d: 2 }, createdTs: T0, resolvedTs: null });
    db.openFlagOnce(DOC_ID, { kind: 'missing', severity: 2, details: {}, entityKeys: ['0x9'] }, T0);
    db.openFlagOnce(DOC_ID, { kind: 'missing', severity: 2, details: {}, entityKeys: ['0x9'] }, T0);
    db.reconcileFlags(DOC_ID, ['clock_skew'], [], T0 + 2);
    flags = db.flagsForDoc(DOC_ID);
    expect(flags.map((x) => [x.kind, x.resolvedTs])).toEqual([
      ['clock_skew', T0 + 2],
      ['missing', null],
    ]);
    expect(db.openFlagCounts().get(DOC_ID)).toEqual({ count: 1, kinds: ['missing'] });
  });

  it('replaces versions and summarizes watchers', () => {
    const db = new IndexerDb(':memory:');
    const v = {
      docId: DOC_ID,
      normalizerVersion: 'n1',
      seq: 1,
      normSha256: 'h',
      firstSeenBlock: 1,
      firstSeenTs: T0,
      firstEntityKey: '0x1',
      observerCount: 1,
      status: 'current' as const,
      deadlineTs: null,
      amountPaise: 5,
      summaryEn: null,
    };
    db.replaceVersions(DOC_ID, [v]);
    db.replaceVersions(DOC_ID, [v, { ...v, seq: 2, status: 'superseded' }]);
    expect(db.versionsForDoc(DOC_ID).map((x) => x.seq)).toEqual([1, 2]);

    db.insertEntity(entity('0x1', { createdTs: T0 }));
    db.insertEntity(
      entity('0x2', { createdTs: T0 + 9, attrs: obsAttrs({ observedAt: T0, vantage: 'other', docId: DOC_ID_2 }) }),
    );
    db.insertEntity(entity('0x3', { creator: ADDR_B }));
    expect(db.watcherSummaries()).toEqual([
      {
        creator: ADDR_A,
        vantages: ['other', 'test-vantage'],
        observationCount: 2,
        firstSeenTs: T0,
        lastSeenTs: T0 + 9,
        docsCovered: 2,
      },
      {
        creator: ADDR_B,
        vantages: ['test-vantage'],
        observationCount: 1,
        firstSeenTs: T0,
        lastSeenTs: T0,
        docsCovered: 1,
      },
    ]);
  });
});
