import { describe, expect, it } from 'vitest';
import { canonicalJson, NORMALIZER_VERSION, sha256Hex, sha256Of } from '../src/hash.js';

describe('sha256Hex', () => {
  it('hashes strings and bytes identically', () => {
    const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(sha256Hex('abc')).toBe(abc);
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(abc);
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every level and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('is independent of insertion order', () => {
    expect(sha256Of({ x: 1, y: 2 })).toBe(sha256Of({ y: 2, x: 1 }));
  });

  it('skips undefined properties and turns undefined array items into null', () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
  });

  it('keeps unicode as UTF-8 text', () => {
    expect(canonicalJson({ t: 'सूचना' })).toBe('{"t":"सूचना"}');
  });

  it.each([[NaN], [Infinity], [10n], [() => 1], [Symbol('s')]])('rejects %s', (v) => {
    expect(() => canonicalJson({ v })).toThrow(TypeError);
  });

  it('rejects circular references but allows shared ones', () => {
    const shared = { k: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}');
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => canonicalJson(loop)).toThrow(/circular/);
  });

  it('encodes top-level primitives', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('s')).toBe('"s"');
    expect(canonicalJson(true)).toBe('true');
  });
});

describe('NORMALIZER_VERSION', () => {
  it('is n1', () => {
    expect(NORMALIZER_VERSION).toBe('n1');
  });
});
