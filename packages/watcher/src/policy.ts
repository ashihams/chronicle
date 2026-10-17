import { NO_CONTENT_STATES, type ObservationState } from '@chronicle/core';

/** `unreachable` is only written after this many consecutive failed checks. */
export const UNREACHABLE_AFTER_FAILURES = 2;

export interface FailureDecision {
  consecutiveFailures: number;
  /** True when this check failed but not often enough yet to publish `unreachable`. */
  suppress: boolean;
}

export function applyFailureRule(state: ObservationState, previousFailures: number): FailureDecision {
  if (state !== 'unreachable') return { consecutiveFailures: 0, suppress: false };
  const consecutiveFailures = previousFailures + 1;
  return { consecutiveFailures, suppress: consecutiveFailures < UNREACHABLE_AFTER_FAILURES };
}

export interface WriteInput {
  state: ObservationState;
  /** State of the last observation this watcher wrote for the doc. */
  lastState: ObservationState | null;
  lastWriteTs: number | null;
  now: number;
  heartbeatSeconds: number;
}

export interface WriteDecision {
  write: boolean;
  reason: string;
}

/** Section 4.2 step 7: which checks become Arkiv entities. */
export function decideWrite(i: WriteInput): WriteDecision {
  const sinceWrite = i.lastWriteTs === null ? Infinity : i.now - i.lastWriteTs;
  if (i.state === 'first_seen' || i.state === 'changed') return { write: true, reason: i.state };
  if (NO_CONTENT_STATES.has(i.state)) {
    if (i.lastState === i.state && sinceWrite < i.heartbeatSeconds) {
      return { write: false, reason: `${i.state} already written within the heartbeat window` };
    }
    return { write: true, reason: i.state };
  }
  // present
  if (i.lastState !== null && NO_CONTENT_STATES.has(i.lastState)) {
    return { write: true, reason: `back after ${i.lastState}` };
  }
  if (sinceWrite >= i.heartbeatSeconds) return { write: true, reason: 'heartbeat due' };
  return { write: false, reason: 'unchanged within the heartbeat window' };
}
