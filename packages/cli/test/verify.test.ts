import {
  FakeArkivClient,
  sealBundle,
  sha256Hex,
  type Attrs,
  type BundleEntry,
  type BundleWithoutHash,
} from '@chronicle/core';
import { describe, expect, it } from 'vitest';
import { exitCodeFor, formatVerifyTable, verifyBundle, verifyBundleJson } from '../src/verify.js';

const DOC = 'a'.repeat(64);

async function seed(): Promise<{
  arkiv: FakeArkivClient;
  body: BundleWithoutHash;
  key: string;
}> {
  const arkiv = new FakeArkivClient();
  const attrs: Attrs = {
    type: 'observation',
    schema_v: 1,
    doc_id: DOC,
    notice_id: 'n1',
    source_kind: 'page',
    vantage: 'test-vantage',
    observed_at: 1_800_000_000,
    normalizer_version: 'n1',
    state: 'first_seen',
    http_status: 200,
    redirect_chain_len: 0,
    department: 'demo',
    severity: 0,
    norm_sha256: 'b'.repeat(64),
    raw_sha256: 'b'.repeat(64),
  };
  const created = await arkiv.createEntity({
    attributes: attrs,
    payload: { summary_en: 'ok' },
    ttlSeconds: 180 * 86400,
  });
  const rec = await arkiv.getEntity(created.key);
  if (rec === null) throw new Error('missing');
  const entry: BundleEntry = {
    entity_key: rec.key,
    tx_hash: rec.txHash,
    creator: rec.creator,
    owner: rec.owner,
    creation_block: Number(rec.createdAtBlock),
    creation_ts: await arkiv.blockTimestamp(rec.createdAtBlock),
    expiry_block: rec.expiresAtBlock === null ? null : Number(rec.expiresAtBlock),
    attributes: { ...rec.attributes },
    payload_sha256: rec.payloadSha256,
  };
  const body: BundleWithoutHash = {
    bundle_version: 1,
    generated_at: 1_800_000_000,
    chain_id: 7738577,
    rpc: 'https://rpc.example.test',
    doc: { doc_id: DOC, notice_id: 'n1', source_url: null, department: 'demo', title: 'T' },
    versions: [
      {
        seq: 1,
        norm_sha256: 'b'.repeat(64),
        first_seen_ts: entry.creation_ts,
        first_entity_key: entry.entity_key,
        status: 'current',
      },
    ],
    flags: [],
    entries: [entry],
  };
  return { arkiv, body, key: created.key };
}

describe('verifyBundle', () => {
  it('passes a valid bundle', async () => {
    const { arkiv, body } = await seed();
    const report = await verifyBundle(arkiv, sealBundle(body));
    expect(report.results.map((r) => r.state)).toEqual(['PASS']);
    expect(report.exitCode).toBe(0);
    expect(formatVerifyTable(report)).toContain('Not legal advice');
    expect(report.creators).toEqual([arkiv.address()]);
  });

  it('fails when an attribute is tampered', async () => {
    const { arkiv, body } = await seed();
    const tampered = structuredClone(body);
    (tampered.entries[0] as BundleEntry).attributes.state = 'changed';
    const report = await verifyBundle(arkiv, sealBundle(tampered));
    expect(report.results[0]?.state).toBe('FAIL');
    expect(report.exitCode).toBe(1);
    expect(report.results[0]?.detail).toMatch(/attribute state/);
  });

  it('reports DELETED when the entity is gone before expiry', async () => {
    const { arkiv, body, key } = await seed();
    const sealed = sealBundle(body);
    arkiv.network.__delete(key);
    const report = await verifyBundle(arkiv, sealed);
    expect(report.results[0]?.state).toBe('DELETED');
    expect(report.exitCode).toBe(1);
    expect(report.results[0]?.detail).toMatch(/creating tx|EntityCreated/);
  });

  it('reports EXPIRED when the entity is gone and the bundle expiry has passed', async () => {
    const { arkiv, body, key } = await seed();
    const head = Number(await arkiv.currentBlock());
    const expired = structuredClone(body);
    (expired.entries[0] as BundleEntry).expiry_block = head;
    const sealed = sealBundle(expired);
    arkiv.network.__delete(key);
    const report = await verifyBundle(arkiv, sealed);
    expect(report.results[0]?.state).toBe('EXPIRED');
    expect(report.exitCode).toBe(2);
  });

  it('reports OWNER_CHANGED without failing the exit code', async () => {
    const { arkiv, body, key } = await seed();
    const sealed = sealBundle(body);
    const other = `0x${'b'.repeat(40)}`;
    arkiv.network.__transfer(key, other);
    const report = await verifyBundle(arkiv, sealed);
    expect(report.results[0]?.state).toBe('OWNER_CHANGED');
    expect(report.exitCode).toBe(0);
  });

  it('rejects a flipped bundle_sha256 before contacting Arkiv', async () => {
    const { arkiv, body } = await seed();
    const sealed = sealBundle(body);
    await expect(verifyBundleJson(arkiv, { ...sealed, bundle_sha256: sha256Hex('nope') })).rejects.toThrow(
      /bundle_sha256 mismatch/,
    );
  });

  it('maps result states to exit codes', () => {
    expect(exitCodeFor([{ state: 'PASS' } as never])).toBe(0);
    expect(exitCodeFor([{ state: 'OWNER_CHANGED' } as never])).toBe(0);
    expect(exitCodeFor([{ state: 'EXPIRED' } as never])).toBe(2);
    expect(exitCodeFor([{ state: 'DELETED' } as never])).toBe(1);
    expect(exitCodeFor([{ state: 'FAIL' } as never])).toBe(1);
  });
});
