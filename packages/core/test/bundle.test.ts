import { describe, expect, it } from 'vitest';
import { computeBundleSha256, parseAndCheckBundle, sealBundle, type BundleWithoutHash } from '../src/bundle.js';

function sample(): BundleWithoutHash {
  return {
    bundle_version: 1,
    generated_at: 1_760_000_000,
    chain_id: 7738577,
    rpc: 'https://rpc.example.test',
    doc: {
      doc_id: 'a'.repeat(64),
      notice_id: 'n1',
      source_url: 'https://example.test/a',
      department: 'demo',
      title: 'Title',
    },
    versions: [
      {
        seq: 1,
        norm_sha256: 'b'.repeat(64),
        first_seen_ts: 1_760_000_000,
        first_entity_key: `0x${'1'.repeat(64)}`,
        status: 'current',
      },
    ],
    flags: [],
    entries: [
      {
        entity_key: `0x${'1'.repeat(64)}`,
        tx_hash: `0x${'2'.repeat(64)}`,
        creator: `0x${'a'.repeat(40)}`,
        owner: `0x${'a'.repeat(40)}`,
        creation_block: 10,
        creation_ts: 1_760_000_020,
        expiry_block: 1000,
        attributes: { type: 'observation', state: 'first_seen' },
        payload_sha256: 'c'.repeat(64),
      },
    ],
  };
}

describe('evidence bundle hashing', () => {
  it('seals a stable sha256 and rejects a flipped hash', () => {
    const sealed = sealBundle(sample());
    expect(sealed.bundle_sha256).toBe(computeBundleSha256(sample()));
    expect(parseAndCheckBundle(sealed)).toEqual(sealed);

    const flipped = { ...sealed, bundle_sha256: 'd'.repeat(64) };
    expect(() => parseAndCheckBundle(flipped)).toThrow(/bundle_sha256 mismatch/);
  });

  it('changes the hash when an attribute byte changes', () => {
    const a = sealBundle(sample());
    const body = sample();
    (body.entries[0] as { attributes: Record<string, string | number> }).attributes.state = 'changed';
    const b = sealBundle(body);
    expect(a.bundle_sha256).not.toBe(b.bundle_sha256);
  });
});
