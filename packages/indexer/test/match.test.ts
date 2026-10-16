import { normalizeText, sha256Hex } from '@chronicle/core';
import { describe, expect, it } from 'vitest';
import { IndexerDb, type DocRow, type VersionRow } from '../src/db.js';
import { lookupMatch } from '../src/match-lookup.js';
import { buildMatchResponse, hashNormalizedText, matchNote, type VersionLookup } from '../src/match.js';
import { DOC_ID, DOC_ID_2, H, T0, obsAttrs } from './helpers.js';

function doc(over: Partial<DocRow> = {}): DocRow {
  return {
    docId: DOC_ID,
    noticeId: 'n1',
    sourceUrl: 'https://example.test/a',
    sourceKind: 'page',
    department: 'demo-dept',
    scheme: null,
    lang: 'en',
    title: 'Scholarship notice',
    docEntityKey: null,
    currentState: 'changed',
    currentSeq: 2,
    lastSeenTs: T0 + 100,
    lastChangeTs: T0 + 100,
    ...over,
  };
}

function ver(over: Partial<VersionRow> = {}): VersionRow {
  return {
    docId: DOC_ID,
    normalizerVersion: 'n1',
    seq: 1,
    normSha256: H(1),
    firstSeenBlock: 1,
    firstSeenTs: T0,
    firstEntityKey: '0x1',
    observerCount: 2,
    status: 'superseded',
    deadlineTs: null,
    amountPaise: null,
    summaryEn: 'First version.',
    ...over,
  };
}

function seedTwoVersions(db: IndexerDb): void {
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
  db.setDocStatus(DOC_ID, { currentState: 'changed', currentSeq: 2, lastSeenTs: T0 + 100, lastChangeTs: T0 + 100 });
  db.replaceVersions(DOC_ID, [
    ver({ seq: 1, normSha256: H(1), status: 'superseded', summaryEn: 'First version.' }),
    ver({
      seq: 2,
      normSha256: H(2),
      status: 'current',
      firstSeenTs: T0 + 100,
      firstEntityKey: '0x2',
      summaryEn: 'Deadline moved.',
    }),
  ]);
}

describe('buildMatchResponse and matchNote', () => {
  it('returns the honest no-match note with a null match', () => {
    expect(buildMatchResponse([])).toEqual({
      result: 'no_match',
      match: null,
      note: 'No exact match. Treat as unverified. This does not mean it is forged.',
    });
  });

  it('describes a current and a superseded match', () => {
    const siblings = [
      ver({ seq: 1, status: 'superseded' }),
      ver({ seq: 2, normSha256: H(2), status: 'current', firstSeenTs: T0 + 100, summaryEn: 'Deadline moved.' }),
    ];
    const current: VersionLookup = { version: siblings[1] as VersionRow, doc: doc(), siblings };
    const old: VersionLookup = { version: siblings[0] as VersionRow, doc: doc(), siblings };
    expect(buildMatchResponse([current]).match).toMatchObject({
      version_seq: 2,
      status: 'current',
      superseded_at: null,
      changes_since: [],
      timeline_url: `/docs/${DOC_ID}`,
    });
    expect(buildMatchResponse([current]).note).toContain('current version');

    const superseded = buildMatchResponse([old]);
    expect(superseded.match).toMatchObject({
      version_seq: 1,
      status: 'superseded',
      superseded_at: T0 + 100,
      current_seq: 2,
      changes_since: [{ seq: 2, summary_en: 'Deadline moved.', first_seen_ts: T0 + 100 }],
    });
    expect(matchNote(superseded.match!, (ts) => `day-${ts}`)).toBe(
      `Matches version 1, which was superseded on day-${T0 + 100}. Version 2 is current.`,
    );
  });

  it('prefers a current version when several docs match', () => {
    const a: VersionLookup = {
      version: ver({ status: 'superseded' }),
      doc: doc(),
      siblings: [ver({ status: 'superseded' }), ver({ seq: 2, status: 'current', normSha256: H(2) })],
    };
    const b: VersionLookup = {
      version: ver({ docId: DOC_ID_2, status: 'current', observerCount: 1 }),
      doc: doc({ docId: DOC_ID_2, title: 'Other' }),
      siblings: [ver({ docId: DOC_ID_2, status: 'current' })],
    };
    expect(buildMatchResponse([a, b]).match?.doc_id).toBe(DOC_ID_2);
  });
});

describe('lookupMatch', () => {
  it('matches by norm hash and by raw hash via an observation', () => {
    const db = new IndexerDb(':memory:');
    seedTwoVersions(db);
    expect(lookupMatch(db, { normSha256: H(1) }).result).toBe('exact_match');
    expect(lookupMatch(db, { normSha256: H(1) }).match?.version_seq).toBe(1);
    expect(lookupMatch(db, { normSha256: H(9) }).result).toBe('no_match');

    const raw = H(99);
    const attrs = obsAttrs({ observedAt: T0, hash: H(1) });
    attrs.raw_sha256 = raw;
    db.insertEntity({
      key: '0xraw',
      type: 'observation',
      creator: '0x1',
      owner: '0x1',
      createdBlock: 1,
      createdTs: T0,
      txHash: null,
      expiresBlock: null,
      attrs,
      payload: {},
      payloadSha256: 'p',
      mirrorAttrsSha256: 'a',
      mirrorPayloadSha256: 'p',
      mirrorOwner: '0x1',
      status: 'live',
      firstSyncedTs: T0,
      lastCheckedTs: T0,
    });
    expect(lookupMatch(db, { normSha256: H(8), rawSha256: raw }).match?.version_seq).toBe(1);
  });

  it('hashes normalized text the same way as watchers', () => {
    const text = '  Hello\nWorld  ';
    expect(hashNormalizedText(normalizeText(text))).toBe(sha256Hex(normalizeText(text)));
  });
});
