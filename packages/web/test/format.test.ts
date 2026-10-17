import { describe, expect, it } from 'vitest';
import { flagExplanation, formatDay, shortHex, signatureWording, stateBadge } from '../src/format';

describe('format helpers', () => {
  it('formats days and short hex', () => {
    expect(formatDay(1_760_000_000)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(shortHex('0xabcdef0123456789', 4, 4)).toBe('0xab…6789');
  });

  it('maps states to plain badges without fraud language', () => {
    expect(stateBadge('changed', false).label).toBe('Changed');
    expect(stateBadge('present', true).label).toBe('Disputed');
    expect(stateBadge('present', false, true).label).toBe('Sources disagree');
    expect(stateBadge('removed_404', false).label).toBe('Removed');
    expect(flagExplanation('vantage_disagreement')).toMatch(/disagree/i);
    expect(flagExplanation('vantage_disagreement')).not.toMatch(/fraud|fake/i);
    expect(flagExplanation('contradiction')).toMatch(/page and PDF/i);
    expect(flagExplanation('contradiction')).not.toMatch(/fraud|fake/i);
    expect(flagExplanation('stealth_removed')).toMatch(/without a withdrawal notice/i);
    expect(flagExplanation('stealth_removed')).not.toMatch(/fraud|fake/i);
    expect(flagExplanation('sig_invalid')).toMatch(/signature/i);
    expect(flagExplanation('sig_invalid')).not.toMatch(/fraud|authentic/i);
    expect(flagExplanation('metadata_inconsistent')).toMatch(/metadata/i);
  });

  it('wording for PDF signatures never says authentic', () => {
    expect(signatureWording('signed_valid')).toBe('Signature intact');
    expect(signatureWording('unsigned')).toMatch(/Many genuine circulars are unsigned/i);
    expect(signatureWording('signed_valid')).not.toMatch(/authentic/i);
    expect(signatureWording('unsigned')).not.toMatch(/authentic/i);
    expect(signatureWording(null)).toBeNull();
  });
});
