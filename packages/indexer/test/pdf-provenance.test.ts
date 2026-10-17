import { describe, expect, it } from 'vitest';
import type { ObsInput } from '../src/derive.js';
import { latestContentObs, pdfProvenanceFlags } from '../src/pdf-provenance.js';
import type { ObservationAttrs } from '../src/schema.js';

const DOC = 'a'.repeat(64);
const NORM = 'b'.repeat(64);
const RAW = 'c'.repeat(64);

function obs(over: {
  key: string;
  createdBlock?: number;
  state?: ObservationAttrs['state'];
  status?: ObsInput['status'];
  attrs?: Partial<ObservationAttrs> & Record<string, unknown>;
}): ObsInput {
  return {
    key: over.key,
    creator: '0xabc',
    createdBlock: over.createdBlock ?? 1,
    createdTs: 1_700_000_000,
    status: over.status ?? 'live',
    summaryEn: null,
    attrs: {
      type: 'observation',
      schema_v: 1,
      doc_id: DOC,
      notice_id: 'demo-1',
      source_kind: 'pdf',
      vantage: 'in-vps',
      observed_at: 1_700_000_000,
      normalizer_version: '1',
      state: over.state ?? 'first_seen',
      http_status: 200,
      redirect_chain_len: 0,
      raw_sha256: RAW,
      norm_sha256: NORM,
      text_extracted: 1,
      department: 'demo',
      severity: 0,
      ...over.attrs,
    },
  };
}

describe('pdfProvenanceFlags', () => {
  it('opens sig_invalid for modified or invalid signatures', () => {
    const flags = pdfProvenanceFlags([
      obs({ key: 'k1', attrs: { sig_status: 'signed_modified', sig_signer_org: 'City' } }),
    ]);
    expect(flags).toEqual([
      expect.objectContaining({
        kind: 'sig_invalid',
        severity: 3,
        entityKeys: ['k1'],
        details: expect.objectContaining({ sig_status: 'signed_modified' }),
      }),
    ]);
  });

  it('does not flag unsigned or intact signatures', () => {
    expect(pdfProvenanceFlags([obs({ key: 'k1', attrs: { sig_status: 'unsigned' } })])).toEqual([]);
    expect(pdfProvenanceFlags([obs({ key: 'k1', attrs: { sig_status: 'signed_valid' } })])).toEqual([]);
  });

  it('opens soft metadata_inconsistent for online editors and late CreationDate', () => {
    const printed = Date.UTC(2026, 0, 1) / 1000;
    const created = printed + 40 * 86400;
    const flags = pdfProvenanceFlags([
      obs({
        key: 'k2',
        attrs: {
          sig_status: 'unsigned',
          pdf_producer: 'iLovePDF',
          pdf_created_ts: created,
          printed_date_ts: printed,
        },
      }),
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      kind: 'metadata_inconsistent',
      severity: 1,
      details: { reasons: expect.arrayContaining(['online_editor', 'created_after_printed']) },
    });
  });

  it('uses the latest content observation', () => {
    const flags = pdfProvenanceFlags([
      obs({ key: 'old', createdBlock: 1, attrs: { sig_status: 'signed_invalid' } }),
      obs({ key: 'new', createdBlock: 2, attrs: { sig_status: 'signed_valid' } }),
    ]);
    expect(flags).toEqual([]);
    expect(latestContentObs([
      obs({ key: 'old', createdBlock: 1 }),
      obs({ key: 'new', createdBlock: 2 }),
    ])?.key).toBe('new');
  });
});
