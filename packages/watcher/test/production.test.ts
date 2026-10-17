import { describe, expect, it } from 'vitest';
import { assertProductionWatchlist, isDemoSource, ProductionWatchlistError } from '../src/production.js';
import { source } from './helpers.js';

describe('production watchlist guard', () => {
  it('detects demo sources', () => {
    expect(isDemoSource(source('http://127.0.0.1:4000/circulars/001'))).toBe(false);
    expect(isDemoSource({ ...source('http://example.test/a'), noticeId: 'demo-001' })).toBe(true);
    expect(isDemoSource({ ...source('http://example.test/a'), department: 'demo-dept' })).toBe(true);
    expect(isDemoSource({ ...source('http://example.test/a'), department: 'demo-dept-a' })).toBe(true);
  });

  it('allows demo sources outside production and with ALLOW_DEMO=1', () => {
    const demos = [{ ...source('http://example.test/a'), noticeId: 'demo-001', department: 'demo-dept' }];
    expect(() => assertProductionWatchlist(demos, { NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertProductionWatchlist(demos, { NODE_ENV: 'production', ALLOW_DEMO: '1' })).not.toThrow();
    expect(() => assertProductionWatchlist([], { NODE_ENV: 'production' })).not.toThrow();
  });

  it('refuses demo sources in production without ALLOW_DEMO', () => {
    const demos = [{ ...source('http://example.test/a'), noticeId: 'demo-001', department: 'demo-dept' }];
    expect(() => assertProductionWatchlist(demos, { NODE_ENV: 'production' })).toThrow(ProductionWatchlistError);
    expect(() => assertProductionWatchlist(demos, { NODE_ENV: 'production', ALLOW_DEMO: '0' })).toThrow(/ALLOW_DEMO=1/);
  });
});
