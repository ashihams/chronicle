import type { NoticeFields, ObservationState } from '@chronicle/core';
import { describe, expect, it } from 'vitest';
import { ruleSummary } from '../src/summary.js';

const FIELDS: NoticeFields = {
  title: null,
  department: null,
  scheme: null,
  printed_date_ts: null,
  deadline_ts: 1_793_000_000,
  deadline_date: '2026-10-30',
  amount_paise: 150_000,
  declared_supersedes: null,
  summary_en: 'x',
};

function s(state: ObservationState, extra: Partial<Parameters<typeof ruleSummary>[0]> = {}): string {
  return ruleSummary({ state, previousState: null, changes: [], fields: null, ...extra });
}

describe('ruleSummary', () => {
  it('describes a first observation with the extracted fields', () => {
    expect(s('first_seen', { fields: FIELDS })).toBe(
      'First observation of this notice by this watcher (deadline 2026-10-30, amount Rs. 1500.00).',
    );
    expect(s('first_seen')).toBe('First observation of this notice by this watcher.');
    expect(s('first_seen', { fields: { ...FIELDS, deadline_date: null, amount_paise: null } })).toBe(
      'First observation of this notice by this watcher.',
    );
  });

  it('lists deadline and amount changes', () => {
    expect(
      s('changed', {
        changes: [
          { field: 'deadline', from: '2026-10-30', to: '2026-10-20' },
          { field: 'amount', from: null, to: '2000.00' },
          { field: 'text', from: 'a', to: 'b' },
        ],
      }),
    ).toBe('Deadline changed from 2026-10-30 to 2026-10-20; amount changed from Rs. none to Rs. 2000.00.');
    expect(s('changed', { changes: [{ field: 'text', from: 'a', to: 'b' }] })).toBe('The notice text changed.');
  });

  it('distinguishes a heartbeat from a notice that came back', () => {
    expect(s('present', { previousState: 'first_seen' })).toBe('The notice is unchanged since the last observation.');
    expect(s('present', { previousState: 'removed_404' })).toContain('available again after removed_404');
  });

  it.each([
    ['removed_404', 'HTTP 404'],
    ['removed_410', 'HTTP 410'],
    ['redirected', 'redirects away'],
    ['soft_removed', 'no longer shows'],
    ['unreachable', 'could not be reached'],
    ['delisted', 'no longer listed'],
  ] as const)('describes %s', (state, text) => {
    expect(s(state)).toContain(text);
  });
});
