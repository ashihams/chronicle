import type { AlertStage } from './db.js';

export const MAX_ALERTS_PER_CHAT_PER_HOUR = 5;

export interface AlertDecisionInput {
  /** Highest open flag severity, or observation severity when known. */
  severity: number;
  /** Distinct creators that saw the current norm hash. */
  observerCount: number;
}

/**
 * UNCONFIRMED when severity >= 2 and only one watcher so far;
 * CONFIRMED when 2+ creators agree on the same norm hash.
 */
export function decideAlertStage(input: AlertDecisionInput): AlertStage | null {
  if (input.observerCount >= 2) return 'confirmed';
  if (input.severity >= 2) return 'unconfirmed';
  return null;
}

export interface AlertMessageInput {
  stage: AlertStage;
  department: string;
  title: string;
  changeLine: string;
  severity: number;
  observerCount: number;
  firstSeenTs: number;
  timelineUrl: string;
}

function formatUtc(ts: number): string {
  return new Date(ts * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** Spec message body with UNCONFIRMED / CONFIRMED prefix. */
export function formatAlertMessage(input: AlertMessageInput): string {
  const prefix =
    input.stage === 'confirmed'
      ? 'CONFIRMED: 2+ distinct creators agree'
      : 'UNCONFIRMED: 1 watcher reports a change';
  return [
    prefix,
    `Chronicle alert: ${input.department} - ${input.title}`,
    `Change: ${input.changeLine} (severity ${input.severity})`,
    `Seen by: ${input.observerCount} watcher${input.observerCount === 1 ? '' : 's'}, first at ${formatUtc(input.firstSeenTs)}`,
    `Timeline: ${input.timelineUrl}`,
  ].join('\n');
}

export function timelineUrl(apiBaseUrl: string, docId: string): string {
  const base = apiBaseUrl.replace(/\/$/, '');
  return `${base}/docs/${docId}`;
}
