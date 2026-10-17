import { describe, expect, it } from 'vitest';
import { hammingDistanceHex, simhashHex } from '../src/simhash.js';

describe('simhashHex', () => {
  it('is stable and 16 hex chars', () => {
    const a = simhashHex('the last date to apply is 30 october 2026');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(simhashHex('the last date to apply is 30 october 2026')).toBe(a);
  });

  it('keeps near-identical text within Hamming 3', () => {
    const a = simhashHex('synthetic demonstration notice demo department scholarship amount');
    const b = simhashHex('synthetic demonstratdon notice demo department scholarship amount');
    expect(hammingDistanceHex(a, b)).toBeLessThanOrEqual(3);
  });

  it('separates unrelated text', () => {
    const a = simhashHex('synthetic demonstration notice demo department scholarship amount');
    const b = simhashHex('completely unrelated weather forecast for chennai tomorrow morning');
    expect(hammingDistanceHex(a, b)).toBeGreaterThan(3);
  });
});
