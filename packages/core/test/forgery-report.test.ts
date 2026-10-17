import { describe, expect, it } from 'vitest';
import { ObservationBuildError, buildForgeryReportAttrs } from '../src/forgery-report.js';

const H = 'a'.repeat(64);

describe('buildForgeryReportAttrs', () => {
  it('builds attrs with optional url truncated to 128 bytes', () => {
    const attrs = buildForgeryReportAttrs({
      normSha256: H,
      reasonCode: 'altered-content',
      realSourceUrl: `https://example.test/${'x'.repeat(200)}`,
    });
    expect(attrs).toMatchObject({
      type: 'forgery_report',
      schema_v: 1,
      norm_sha256: H,
      reason_code: 'altered-content',
    });
    expect(Buffer.byteLength(String(attrs.real_source_url))).toBeLessThanOrEqual(128);
  });

  it('rejects a bad hash', () => {
    expect(() => buildForgeryReportAttrs({ normSha256: 'nope', reasonCode: 'other' })).toThrow(
      ObservationBuildError,
    );
  });
});
