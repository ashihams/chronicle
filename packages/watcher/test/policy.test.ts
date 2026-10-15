import type { ObservationState } from '@chronicle/core';
import { describe, expect, it } from 'vitest';
import { UNREACHABLE_AFTER_FAILURES, applyFailureRule, decideWrite } from '../src/policy.js';

const HB = 24 * 3600;
const NOW = 1_800_000_000;

function decide(state: ObservationState, lastState: ObservationState | null, sinceWrite: number | null): boolean {
  return decideWrite({
    state,
    lastState,
    lastWriteTs: sinceWrite === null ? null : NOW - sinceWrite,
    now: NOW,
    heartbeatSeconds: HB,
  }).write;
}

describe('applyFailureRule', () => {
  it('publishes unreachable only on the second consecutive failure', () => {
    expect(UNREACHABLE_AFTER_FAILURES).toBe(2);
    expect(applyFailureRule('unreachable', 0)).toEqual({ consecutiveFailures: 1, suppress: true });
    expect(applyFailureRule('unreachable', 1)).toEqual({ consecutiveFailures: 2, suppress: false });
    expect(applyFailureRule('unreachable', 5)).toEqual({ consecutiveFailures: 6, suppress: false });
  });

  it('resets the counter on any other state', () => {
    for (const s of ['present', 'changed', 'removed_404', 'soft_removed'] as const) {
      expect(applyFailureRule(s, 3)).toEqual({ consecutiveFailures: 0, suppress: false });
    }
  });
});

describe('decideWrite', () => {
  it('always writes first_seen and changed', () => {
    expect(decide('first_seen', null, null)).toBe(true);
    expect(decide('changed', 'first_seen', 10)).toBe(true);
    expect(decide('changed', 'changed', 10)).toBe(true);
  });

  it('writes a present heartbeat only once the heartbeat window has passed', () => {
    expect(decide('present', 'first_seen', 60)).toBe(false);
    expect(decide('present', 'first_seen', HB - 1)).toBe(false);
    expect(decide('present', 'first_seen', HB)).toBe(true);
    expect(decide('present', 'changed', null)).toBe(true);
  });

  it('writes present right away when the notice comes back after a removal or outage', () => {
    expect(decide('present', 'removed_404', 60)).toBe(true);
    expect(decide('present', 'unreachable', 60)).toBe(true);
    expect(
      decideWrite({ state: 'present', lastState: 'soft_removed', lastWriteTs: NOW, now: NOW, heartbeatSeconds: HB })
        .reason,
    ).toBe('back after soft_removed');
  });

  it.each(['removed_404', 'removed_410', 'redirected', 'soft_removed', 'unreachable'] as const)(
    'writes %s once per heartbeat window',
    (state) => {
      expect(decide(state, 'first_seen', 60)).toBe(true);
      expect(decide(state, state, 60)).toBe(false);
      expect(decide(state, state, HB)).toBe(true);
    },
  );

  it('writes a different removal state immediately', () => {
    expect(decide('removed_410', 'removed_404', 60)).toBe(true);
  });
});
