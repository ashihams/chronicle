import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/hash.js';
import {
  buildDocAttrs,
  buildDocPayload,
  buildObservationAttrs,
  buildObservationPayload,
  describeChanges,
  MAX_OBSERVATION_PAYLOAD_BYTES,
  ObservationBuildError,
  truncateUtf8,
  type ObservationInput,
} from '../src/observation.js';
import { docIdFor } from '../src/url.js';

const URL_A = 'https://demo.gov.example/notices/scholarship';
const H1 = sha256Hex('one');
const H2 = sha256Hex('two');
const H3 = sha256Hex('three');

function obs(over: Partial<ObservationInput> = {}): ObservationInput {
  return {
    docId: docIdFor(URL_A),
    noticeId: 'demo-001',
    sourceKind: 'page',
    department: 'demo-department',
    vantage: 'in-vps',
    observedAt: 1_760_000_000,
    state: 'changed',
    httpStatus: 200,
    redirectChainLen: 0,
    rawSha256: H1,
    normSha256: H2,
    prevNormSha256: H3,
    textExtracted: true,
    severity: 2,
    ...over,
  };
}

describe('buildDocAttrs / buildDocPayload', () => {
  it('builds the section 5.2 shape', () => {
    expect(
      buildDocAttrs({
        noticeId: 'demo-001',
        sourceKind: 'page',
        sourceUrl: 'HTTPS://demo.gov.example/notices/scholarship/?utm_source=x',
        department: 'demo-department',
        scheme: 'demo-merit',
        lang: 'en',
      }),
    ).toEqual({
      type: 'doc',
      schema_v: 1,
      doc_id: docIdFor(URL_A),
      notice_id: 'demo-001',
      source_kind: 'page',
      source_url: URL_A,
      department: 'demo-department',
      scheme: 'demo-merit',
      lang: 'en',
    });
  });

  it('omits scheme when absent and source_url when longer than 128 bytes', () => {
    const longUrl = `https://demo.gov.example/${'p'.repeat(150)}`;
    const attrs = buildDocAttrs({
      noticeId: 'demo-002',
      sourceKind: 'pdf',
      sourceUrl: longUrl,
      department: 'demo-department',
      scheme: null,
      lang: 'hi',
    });
    expect(attrs).not.toHaveProperty('source_url');
    expect(attrs).not.toHaveProperty('scheme');
    expect(buildDocPayload({ title: 'T', registeredVantage: 'in-vps', sourceUrl: longUrl }).source_url).toBe(longUrl);
  });

  it.each([
    { noticeId: 'Demo 1' },
    { sourceKind: 'video' },
    { department: 'Demo Dept' },
    { scheme: 'x y' },
    { lang: 'english' },
    { sourceUrl: 'ftp://x' },
  ])('rejects invalid input %o', (bad) => {
    const base = {
      noticeId: 'demo-001',
      sourceKind: 'page',
      sourceUrl: URL_A,
      department: 'demo-department',
      lang: 'en',
    };
    expect(() => buildDocAttrs({ ...base, ...bad } as never)).toThrow();
  });

  it('builds the doc payload and truncates the title', () => {
    expect(buildDocPayload({ title: 't'.repeat(300), registeredVantage: 'in-vps', sourceUrl: URL_A })).toEqual({
      title: 't'.repeat(160),
      registered_vantage: 'in-vps',
      source_url: URL_A,
    });
    expect(buildDocPayload({ title: null, registeredVantage: 'eu-vps', sourceUrl: URL_A }).title).toBeNull();
    expect(() => buildDocPayload({ title: null, registeredVantage: 'EU VPS', sourceUrl: URL_A })).toThrow(
      ObservationBuildError,
    );
  });
});

describe('buildObservationAttrs', () => {
  it('builds the section 5.3 shape with optional fields', () => {
    const attrs = buildObservationAttrs(
      obs({
        scheme: 'demo-merit',
        lastModifiedTs: 1_759_000_000,
        printedDateTs: 1_758_000_000,
        deadlineTs: 1_761_762_600,
        deadlineDate: '2026-10-30',
        amountPaise: 150000,
      }),
    );
    expect(attrs).toEqual({
      type: 'observation',
      schema_v: 1,
      doc_id: docIdFor(URL_A),
      notice_id: 'demo-001',
      source_kind: 'page',
      vantage: 'in-vps',
      observed_at: 1_760_000_000,
      normalizer_version: 'n1',
      state: 'changed',
      http_status: 200,
      redirect_chain_len: 0,
      raw_sha256: H1,
      norm_sha256: H2,
      prev_norm_sha256: H3,
      text_extracted: 1,
      last_modified_ts: 1_759_000_000,
      printed_date_ts: 1_758_000_000,
      deadline_ts: 1_761_762_600,
      deadline_date: '2026-10-30',
      amount_paise: 150000,
      department: 'demo-department',
      scheme: 'demo-merit',
      severity: 2,
    });
  });

  it('omits absent optional attributes', () => {
    const attrs = buildObservationAttrs(obs({ prevNormSha256: null, state: 'first_seen', severity: 0 }));
    for (const k of [
      'prev_norm_sha256',
      'scheme',
      'deadline_ts',
      'deadline_date',
      'amount_paise',
      'last_modified_ts',
    ]) {
      expect(attrs).not.toHaveProperty(k);
    }
    expect(Object.values(attrs)).not.toContain('');
  });

  it('records text_extracted = 0 for a scanned PDF', () => {
    expect(buildObservationAttrs(obs({ sourceKind: 'pdf', textExtracted: false })).text_extracted).toBe(0);
  });

  it.each(['removed_404', 'removed_410', 'redirected', 'soft_removed', 'unreachable', 'delisted'] as const)(
    'drops content hashes for %s',
    (state) => {
      const attrs = buildObservationAttrs(obs({ state, httpStatus: state === 'unreachable' ? 0 : 404, severity: 3 }));
      expect(attrs).not.toHaveProperty('raw_sha256');
      expect(attrs).not.toHaveProperty('norm_sha256');
      expect(attrs).not.toHaveProperty('text_extracted');
      expect(attrs.prev_norm_sha256).toBe(H3);
    },
  );

  it('requires hashes for content states', () => {
    expect(() => buildObservationAttrs(obs({ normSha256: null }))).toThrow(/needs raw_sha256/);
  });

  it('adds stretch attributes and truncates free text to 128 bytes', () => {
    const attrs = buildObservationAttrs(
      obs({
        sourceKind: 'pdf',
        extras: {
          simhashHex: '0123456789abcdef',
          sigStatus: 'signed_valid',
          sigSignerOrg: '  Demo   Signing Authority  ',
          pdfProducer: `Producer\u0000${'ü'.repeat(100)}`,
          pdfCreatedTs: 1_757_000_000,
        },
      }),
    );
    expect(attrs.simhash_hex).toBe('0123456789abcdef');
    expect(attrs.sig_status).toBe('signed_valid');
    expect(attrs.sig_signer_org).toBe('Demo Signing Authority');
    expect(Buffer.byteLength(String(attrs.pdf_producer))).toBeLessThanOrEqual(128);
    expect(String(attrs.pdf_producer)).toMatch(/^Producer ü+$/);
    expect(attrs.pdf_created_ts).toBe(1_757_000_000);
    expect(Object.keys(attrs).length).toBeLessThanOrEqual(30);
  });

  it('fits all baseline and stretch attributes within the 30-attribute limit', () => {
    const attrs = buildObservationAttrs(
      obs({
        scheme: 'demo-merit',
        lastModifiedTs: 1,
        printedDateTs: 1,
        deadlineTs: 1,
        deadlineDate: '2026-10-30',
        amountPaise: 1,
        extras: {
          simhashHex: '0'.repeat(16),
          sigStatus: 'signed_valid',
          sigSignerOrg: 'o',
          pdfProducer: 'p',
          pdfCreatedTs: 1,
        },
      }),
    );
    expect(Object.keys(attrs)).toHaveLength(28);
  });

  it.each<[string, Partial<ObservationInput>]>([
    ['bad doc_id', { docId: 'abc' }],
    ['uppercase hash', { rawSha256: H1.toUpperCase() }],
    ['bad prev hash', { prevNormSha256: 'x' }],
    ['bad vantage', { vantage: 'In VPS' }],
    ['bad notice id', { noticeId: '' }],
    ['bad kind', { sourceKind: 'doc' as never }],
    ['bad department', { department: 'A B' }],
    ['bad scheme', { scheme: 'A B' }],
    ['bad state', { state: 'gone' as never }],
    ['negative observed_at', { observedAt: -1 }],
    ['fractional observed_at', { observedAt: 1.5 }],
    ['bad http status', { httpStatus: 1000 }],
    ['bad redirect count', { redirectChainLen: -1 }],
    ['severity out of range', { severity: 4 }],
    ['negative amount', { amountPaise: -100 }],
    ['bad deadline_date', { deadlineDate: '30/10/2026' }],
    ['bad simhash', { extras: { simhashHex: 'xyz' } }],
    ['bad sig_status', { extras: { sigStatus: 'Valid!' } }],
    ['bad pdf_created_ts', { extras: { pdfCreatedTs: -5 } }],
  ])('rejects %s', (_n, over) => {
    expect(() => buildObservationAttrs(obs(over))).toThrow(ObservationBuildError);
  });
});

describe('buildObservationPayload', () => {
  const base = {
    title: 'Synthetic Scholarship Notice 2026',
    summaryEn: 'The deadline moved from 30 October to 20 October 2026.',
    finalUrl: URL_A,
    changes: [{ field: 'deadline' as const, from: '2026-10-30', to: '2026-10-20' }],
    extractor: { model: 'stub-model', confidence: 0.9 },
  };

  it('builds the section 5.3 payload shape', () => {
    expect(buildObservationPayload(base)).toEqual({
      title: 'Synthetic Scholarship Notice 2026',
      summary_en: 'The deadline moved from 30 October to 20 October 2026.',
      summary_ta: null,
      summary_hi: null,
      final_url: URL_A,
      changes: [{ field: 'deadline', from: '2026-10-30', to: '2026-10-20' }],
      extractor: { model: 'stub-model', confidence: 0.9 },
      declared_supersedes: null,
    });
  });

  it('truncates long fields', () => {
    const p = buildObservationPayload({
      ...base,
      title: 't'.repeat(500),
      summaryEn: 's'.repeat(500),
      summaryHi: '  ',
      declaredSupersedes: 'Circular No. 14/2026',
      changes: [{ field: 'text', from: 'a'.repeat(500), to: null }],
    });
    expect(p.title).toHaveLength(160);
    expect(p.summary_en).toHaveLength(240);
    expect(p.summary_hi).toBeNull();
    expect(p.declared_supersedes).toBe('Circular No. 14/2026');
    expect(p.changes[0]?.from).toHaveLength(160);
  });

  it('rejects payloads over 4 KB and bad confidence', () => {
    const huge = { ...base, finalUrl: `https://demo.gov.example/${'x'.repeat(MAX_OBSERVATION_PAYLOAD_BYTES)}` };
    expect(() => buildObservationPayload(huge)).toThrow(/4096/);
    expect(() => buildObservationPayload({ ...base, extractor: { model: 'm', confidence: 2 } })).toThrow(
      ObservationBuildError,
    );
  });
});

describe('describeChanges', () => {
  const prevFields = { deadline_date: '2026-10-30', amount_paise: 150000 };

  it('lists deadline, amount and text changes', () => {
    expect(
      describeChanges({
        state: 'changed',
        prevNormSha256: H1,
        normSha256: H2,
        prevFields,
        nextFields: { deadline_date: '2026-10-20', amount_paise: 200050 },
      }),
    ).toEqual([
      { field: 'deadline', from: '2026-10-30', to: '2026-10-20' },
      { field: 'amount', from: '1500.00', to: '2000.50' },
      { field: 'text', from: H1, to: H2 },
    ]);
  });

  it('reports amounts that appear or disappear', () => {
    const c = describeChanges({
      state: 'changed',
      prevFields: { deadline_date: null, amount_paise: null },
      nextFields: { deadline_date: null, amount_paise: 100 },
    });
    expect(c).toContainEqual({ field: 'amount', from: null, to: '1.00' });
    expect(
      describeChanges({ state: 'changed', prevFields, nextFields: { ...prevFields, amount_paise: null } }),
    ).toContainEqual({ field: 'amount', from: '1500.00', to: null });
  });

  it('only a text change when fields are unknown', () => {
    expect(describeChanges({ state: 'changed', prevNormSha256: H1, normSha256: H2 })).toEqual([
      { field: 'text', from: H1, to: H2 },
    ]);
  });

  it('a removal records the state transition', () => {
    expect(describeChanges({ state: 'removed_404', prevState: 'present' })).toEqual([
      { field: 'removed', from: 'present', to: 'removed_404' },
    ]);
    expect(describeChanges({ state: 'soft_removed' })).toEqual([{ field: 'removed', from: null, to: 'soft_removed' }]);
  });

  it.each(['present', 'first_seen', 'unreachable'] as const)('%s has no changes', (state) => {
    expect(describeChanges({ state })).toEqual([]);
  });
});

describe('truncateUtf8', () => {
  it('never splits a multi-byte character', () => {
    expect(truncateUtf8('aé€😀', 6)).toBe('aé€');
    expect(truncateUtf8('short', 128)).toBe('short');
  });
});
