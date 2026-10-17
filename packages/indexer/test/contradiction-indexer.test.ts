import { FakeArkivClient, FakeArkivNetwork } from '@chronicle/core';
import { describe, expect, it } from 'vitest';
import { IndexerDb } from '../src/db.js';
import { Indexer } from '../src/indexer.js';
import { ADDR_A, DOC_ID, DOC_ID_2, H, SETTINGS, T0, silentLog } from './helpers.js';

describe('Indexer.recomputeContradictions', () => {
  it('opens contradiction on page and pdf docs when deadlines differ', () => {
    const db = new IndexerDb(':memory:');
    const noticeId = 'demo-001';
    db.upsertDoc({
      docId: DOC_ID,
      noticeId,
      sourceUrl: 'https://example.test/a',
      sourceKind: 'page',
      department: 'demo-dept',
      scheme: null,
      lang: 'en',
      title: 'page',
      docEntityKey: null,
    });
    db.upsertDoc({
      docId: DOC_ID_2,
      noticeId,
      sourceUrl: 'https://example.test/a.pdf',
      sourceKind: 'pdf',
      department: 'demo-dept',
      scheme: null,
      lang: 'en',
      title: 'pdf',
      docEntityKey: null,
    });

    const insertObs = (
      docId: string,
      key: string,
      sourceKind: 'page' | 'pdf',
      deadlineTs: number,
      deadlineDate: string,
    ): void => {
      db.insertEntity({
        key,
        type: 'observation',
        creator: ADDR_A,
        owner: ADDR_A,
        createdBlock: 10,
        createdTs: T0,
        txHash: '0x1',
        expiresBlock: null,
        attrs: {
          type: 'observation',
          schema_v: 1,
          doc_id: docId,
          notice_id: noticeId,
          source_kind: sourceKind,
          vantage: 'in-vps',
          observed_at: T0,
          normalizer_version: 'n1',
          state: 'first_seen',
          http_status: 200,
          redirect_chain_len: 0,
          raw_sha256: H(1),
          norm_sha256: H(sourceKind === 'page' ? 1 : 2),
          deadline_ts: deadlineTs,
          deadline_date: deadlineDate,
          department: 'demo-dept',
          severity: 0,
        },
        payload: { title: 't', summary_en: 's' },
        payloadSha256: H(9),
        mirrorAttrsSha256: H(8),
        mirrorPayloadSha256: H(9),
        mirrorOwner: ADDR_A,
        status: 'live',
        firstSyncedTs: T0,
        lastCheckedTs: T0,
      });
    };

    insertObs(DOC_ID, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'page', 200, '2026-11-20');
    insertObs(DOC_ID_2, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'pdf', 100, '2026-10-30');

    const indexer = new Indexer(new FakeArkivClient(undefined, new FakeArkivNetwork()), db, SETTINGS, silentLog);
    indexer.recomputeContradictions(T0);

    const pageFlags = db.flagsForDoc(DOC_ID, true);
    const pdfFlags = db.flagsForDoc(DOC_ID_2, true);
    expect(pageFlags.map((f) => f.kind)).toEqual(['contradiction']);
    expect(pdfFlags.map((f) => f.kind)).toEqual(['contradiction']);
    expect(pageFlags[0]?.details).toMatchObject({
      notice_badge: 'sources disagree: page says 2026-11-20, PDF says 2026-10-30',
    });

    // Align deadlines → resolve
    db.db.prepare(`DELETE FROM entities WHERE key LIKE '0x%'`).run();
    insertObs(DOC_ID, '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 'page', 100, '2026-10-30');
    insertObs(DOC_ID_2, '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 'pdf', 100, '2026-10-30');
    indexer.recomputeContradictions(T0 + 1);
    expect(db.flagsForDoc(DOC_ID, true)).toEqual([]);
    expect(db.flagsForDoc(DOC_ID_2, true)).toEqual([]);
  });
});
