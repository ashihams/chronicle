import { buildForgeryReportAttrs, normalizeText, simhashHex } from '@chronicle/core';
import { describe, expect, it } from 'vitest';
import { IndexerDb } from '../src/db.js';
import { lookupMatch } from '../src/match-lookup.js';
import { DOC_ID, H, T0 } from './helpers.js';

function seedDoc(db: IndexerDb, norm: string, text: string): void {
  db.upsertDoc({
    docId: DOC_ID,
    noticeId: 'n1',
    sourceUrl: 'https://example.test/a',
    sourceKind: 'page',
    department: 'demo-dept',
    scheme: null,
    lang: 'en',
    title: 'Scholarship notice',
    docEntityKey: null,
  });
  db.replaceVersions(DOC_ID, [
    {
      docId: DOC_ID,
      normalizerVersion: 'n1',
      seq: 1,
      normSha256: norm,
      firstSeenBlock: 1,
      firstSeenTs: T0,
      firstEntityKey: '0x1',
      observerCount: 1,
      status: 'current',
      deadlineTs: null,
      amountPaise: null,
      summaryEn: 'Current.',
    },
  ]);
  db.insertEntity({
    key: '0xobs1',
    type: 'observation',
    creator: '0xwatcher',
    owner: '0xwatcher',
    createdBlock: 1,
    createdTs: T0,
    expiresBlock: null,
    status: 'live',
    attrs: {
      type: 'observation',
      schema_v: 1,
      doc_id: DOC_ID,
      notice_id: 'n1',
      source_kind: 'page',
      vantage: 'in-vps',
      observed_at: T0,
      normalizer_version: 'n1',
      state: 'first_seen',
      http_status: 200,
      redirect_chain_len: 0,
      raw_sha256: H(9),
      norm_sha256: norm,
      text_extracted: 1,
      department: 'demo-dept',
      severity: 0,
      simhash_hex: simhashHex(text),
    },
    payload: { title: 'Scholarship notice', summary_en: 'Current.' },
    payloadSha256: H(8),
    mirrorAttrsSha256: H(7),
    mirrorPayloadSha256: H(6),
    mirrorOwner: '0xwatcher',
    txHash: null,
    firstSyncedTs: T0,
    lastCheckedTs: T0,
  });
}

describe('stretch S5 match extras', () => {
  it('attaches forgery report counts for an exact match', () => {
    const db = new IndexerDb(':memory:');
    const text = 'synthetic scholarship notice deadline october';
    const norm = H(2);
    seedDoc(db, norm, text);
    const attrs = buildForgeryReportAttrs({ normSha256: norm, reasonCode: 'altered-content' });
    db.insertEntity({
      key: '0xforg1',
      type: 'forgery_report',
      creator: '0xreporter1',
      owner: '0xreporter1',
      createdBlock: 2,
      createdTs: T0 + 1,
      expiresBlock: null,
      status: 'live',
      attrs,
      payload: {},
      payloadSha256: H(5),
      mirrorAttrsSha256: H(4),
      mirrorPayloadSha256: H(3),
      mirrorOwner: '0xreporter1',
      txHash: null,
      firstSyncedTs: T0,
      lastCheckedTs: T0,
    });
    db.insertEntity({
      key: '0xforg2',
      type: 'forgery_report',
      creator: '0xreporter2',
      owner: '0xreporter2',
      createdBlock: 3,
      createdTs: T0 + 2,
      expiresBlock: null,
      status: 'live',
      attrs: buildForgeryReportAttrs({ normSha256: norm, reasonCode: 'wrong-source' }),
      payload: {},
      payloadSha256: H(15),
      mirrorAttrsSha256: H(14),
      mirrorPayloadSha256: H(13),
      mirrorOwner: '0xreporter2',
      txHash: null,
      firstSyncedTs: T0,
      lastCheckedTs: T0,
    });

    const res = lookupMatch(db, { normSha256: norm });
    expect(res.result).toBe('exact_match');
    expect(res.forgery_reports.distinct_creators).toBe(2);
    expect(res.forgery_reports.reason_codes).toEqual(['altered-content', 'wrong-source']);
    expect(res.forgery_reports.note).toMatch(/2 independent reporters/i);
    db.close();
  });

  it('returns similar_match for near text and localizes notes', () => {
    const db = new IndexerDb(':memory:');
    const base = 'synthetic demonstration notice demo department scholarship amount rupees payable';
    const near = 'syntietic demonstration notice demo department scholarship amount rupees payable';
    const norm = H(2);
    seedDoc(db, norm, normalizeText(base));

    const res = lookupMatch(db, {
      normSha256: H(99),
      normalizedText: normalizeText(near),
      lang: 'en',
    });
    expect(res.result).toBe('similar_match');
    expect(res.similar_label).toBe('similar, not identical');
    expect(res.match?.doc_id).toBe(DOC_ID);
    expect(res.note).toMatch(/Similar, not identical/i);

    const ta = lookupMatch(db, {
      normSha256: H(99),
      normalizedText: normalizeText(near),
      lang: 'ta',
    });
    expect(ta.note).not.toEqual(res.note);
    db.close();
  });
});
