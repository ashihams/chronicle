import { describe, expect, it } from 'vitest';
import {
  decodePayload,
  encodePayload,
  MAX_USER_ATTRIBUTES,
  normalizeAddress,
  normalizeKey,
  ttlToBlocks,
  validateAttrName,
  validateAttrs,
  validateQuery,
} from '../src/arkiv/limits.js';
import { describeWhere, matchesWhere } from '../src/arkiv/where.js';

describe('attribute validation', () => {
  it('accepts the names Chronicle uses', () => {
    for (const n of ['type', 'schema_v', 'doc_id', 'observed_at', 'norm_sha256', 'prev_norm_sha256']) {
      expect(() => validateAttrName(n)).not.toThrow();
    }
  });

  it.each(['key', 'KEY', 'and', 'str', '1abc', '_x', 'a--b', 'a b', 'x'.repeat(33), '$owner'])(
    'rejects invalid or reserved name %s',
    (n) => {
      expect(() => validateAttrName(n)).toThrow();
    },
  );

  it('enforces value rules', () => {
    expect(() => validateAttrs({ a: 'x'.repeat(128) })).not.toThrow();
    expect(() => validateAttrs({ a: 'é'.repeat(65) })).toThrow(/128/);
    expect(() => validateAttrs({ a: '' })).toThrow(/empty/);
    expect(() => validateAttrs({ a: 'line\nbreak' })).toThrow(/control/);
    expect(() => validateAttrs({ a: 1.5 })).toThrow(/integer/);
    expect(() => validateAttrs({ a: -1 })).toThrow(/integer/);
    expect(() => validateAttrs({ a: 2 ** 53 })).toThrow(/integer/);
    expect(() => validateAttrs({ a: 2 ** 40 })).not.toThrow();
  });

  it('enforces the attribute count', () => {
    const ok = Object.fromEntries(Array.from({ length: MAX_USER_ATTRIBUTES }, (_, i) => [`a${i}`, i]));
    expect(() => validateAttrs(ok)).not.toThrow();
    expect(() => validateAttrs({ ...ok, extra: 1 })).toThrow(/limit/);
  });
});

describe('payload codec', () => {
  it('round-trips JSON and tolerates non-JSON bytes', () => {
    expect(decodePayload(encodePayload({ a: 1 }))).toEqual({ a: 1 });
    expect(decodePayload(encodePayload(null))).toBeNull();
    expect(decodePayload(new Uint8Array([0xff, 0xfe]))).toBeNull();
    expect(decodePayload(null)).toBeNull();
  });
});

describe('ttlToBlocks', () => {
  it('rounds up to whole 2-second blocks', () => {
    expect(ttlToBlocks(2)).toBe(1);
    expect(ttlToBlocks(3)).toBe(2);
    expect(ttlToBlocks(180 * 86400)).toBe(7_776_000);
    expect(() => ttlToBlocks(0)).toThrow();
  });
});

describe('normalization', () => {
  it('lowercases addresses and keys and rejects malformed ones', () => {
    expect(normalizeAddress('0x' + 'AB'.repeat(20))).toBe('0x' + 'ab'.repeat(20));
    expect(() => normalizeAddress('0x123')).toThrow();
    expect(normalizeKey('0x' + 'CD'.repeat(32))).toBe('0x' + 'cd'.repeat(32));
    expect(() => normalizeKey('0x' + 'cd'.repeat(20))).toThrow();
  });
});

describe('query semantics', () => {
  it('matches typed values only', () => {
    expect(matchesWhere('a', { attr: 'x', op: 'eq', value: 'a' })).toBe(true);
    expect(matchesWhere(1, { attr: 'x', op: 'eq', value: '1' })).toBe(false);
    expect(matchesWhere(undefined, { attr: 'x', op: 'eq', value: 'a' })).toBe(false);
    expect(matchesWhere('abc', { attr: 'x', op: 'prefix', value: 'ab' })).toBe(true);
    expect(matchesWhere('xabc', { attr: 'x', op: 'prefix', value: 'ab' })).toBe(false);
    expect(matchesWhere(5, { attr: 'x', op: 'gt', value: 4 })).toBe(true);
    expect(matchesWhere(5, { attr: 'x', op: 'lt', value: 5 })).toBe(false);
  });

  it('validates queries', () => {
    expect(() => validateQuery({ where: [] })).toThrow();
    expect(() => validateQuery({ where: [], creator: '0x' + 'a'.repeat(40) })).not.toThrow();
    expect(() => validateQuery({ where: [{ attr: 'x', op: 'gte', value: 'a' }] })).toThrow();
    expect(() => validateQuery({ where: [{ attr: 'x', op: 'eq', value: 'a' }], limit: 0 })).toThrow();
  });

  it('describes where clauses in Arkiv query syntax', () => {
    expect(
      describeWhere(
        [
          { attr: 'type', op: 'eq', value: 'observation' },
          { attr: 'observed_at', op: 'gte', value: 100 },
        ],
        { creator: '0xabc' },
      ),
    ).toBe("type = str('observation') AND observed_at >= u64(100) AND $creator = addr(0xabc)");
  });
});
