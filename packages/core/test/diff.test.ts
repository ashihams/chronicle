import { describe, expect, it } from 'vitest';
import {
  clampSeverity,
  diffText,
  finalSeverity,
  MAX_DIFF_HUNKS,
  MAX_HUNK_CHARS,
  ruleSeverity,
  splitSentences,
} from '../src/diff.js';

describe('splitSentences', () => {
  it('splits on ". " and newlines and drops empties', () => {
    expect(splitSentences('a b. c d.\n\ne f. ')).toEqual(['a b.', 'c d.', 'e f.']);
  });
});

describe('diffText', () => {
  const prev = 'notice one. the last date is 30 october 2026. amount is rs 1500. contact the office.';

  it('returns nothing for identical texts', () => {
    expect(diffText(prev, prev)).toEqual([]);
  });

  it('reports a changed sentence as a removal and an addition', () => {
    const next = prev.replace('30 october', '20 october');
    expect(diffText(prev, next)).toEqual([
      { op: '-', text: 'the last date is 30 october 2026.' },
      { op: '+', text: 'the last date is 20 october 2026.' },
    ]);
  });

  it('reports added and removed sentences', () => {
    expect(diffText('a. b. c.', 'a. c. d.')).toEqual([
      { op: '-', text: 'b.' },
      { op: '+', text: 'd.' },
    ]);
  });

  it('caps hunks at 12 and truncates each to 300 chars', () => {
    const before = Array.from({ length: 40 }, (_, i) => `old ${i}.`).join(' ');
    const after = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? `new ${i}.` : `old ${i}.`)).join(' ');
    expect(diffText(before, after)).toHaveLength(MAX_DIFF_HUNKS);

    const long = diffText('', 'x'.repeat(1000));
    expect(long[0]?.text).toHaveLength(MAX_HUNK_CHARS);
    expect(long[0]?.text.endsWith('…')).toBe(true);
  });
});

describe('ruleSeverity', () => {
  const f = (deadline_ts: number | null, amount_paise: number | null) => ({ deadline_ts, amount_paise });

  it.each(['removed_404', 'removed_410', 'redirected', 'soft_removed', 'delisted'] as const)(
    '%s is severity 3',
    (state) => {
      expect(ruleSeverity(state, null, null)).toBe(3);
    },
  );

  it('deadline or amount change is 2', () => {
    expect(ruleSeverity('changed', f(100, 5), f(200, 5))).toBe(2);
    expect(ruleSeverity('changed', f(100, 5), f(100, 6))).toBe(2);
    expect(ruleSeverity('changed', f(100, 5), f(null, 5))).toBe(2);
  });

  it('other changes are 1', () => {
    expect(ruleSeverity('changed', f(100, 5), f(100, 5))).toBe(1);
    expect(ruleSeverity('changed', null, f(100, 5))).toBe(1);
  });

  it.each(['present', 'first_seen', 'unreachable'] as const)('%s is 0', (state) => {
    expect(ruleSeverity(state, f(1, 1), f(2, 2))).toBe(0);
  });
});

describe('finalSeverity', () => {
  it('takes the max of rule and LLM, clamped to 0..3', () => {
    expect(finalSeverity(1, 2)).toBe(2);
    expect(finalSeverity(3, 0)).toBe(3);
    expect(finalSeverity(1, null)).toBe(1);
    expect(finalSeverity(0, undefined)).toBe(0);
    expect(finalSeverity(1, 9)).toBe(3);
  });

  it('clampSeverity handles odd input', () => {
    expect(clampSeverity(-1)).toBe(0);
    expect(clampSeverity(1.6)).toBe(2);
    expect(clampSeverity(NaN)).toBe(0);
  });
});
