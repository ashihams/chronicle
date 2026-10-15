import { diffArrays } from 'diff';
import { REMOVAL_STATES, type ObservationState } from './states.js';

export const MAX_DIFF_HUNKS = 12;
export const MAX_HUNK_CHARS = 300;

export interface DiffHunk {
  op: '+' | '-';
  text: string;
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=\. )|\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Sentence-level diff of two normalized texts. Local only; hunks are never published. */
export function diffText(prev: string, next: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  for (const change of diffArrays(splitSentences(prev), splitSentences(next))) {
    if (!change.added && !change.removed) continue;
    hunks.push({ op: change.added ? '+' : '-', text: truncate(change.value.join(' '), MAX_HUNK_CHARS) });
    if (hunks.length === MAX_DIFF_HUNKS) break;
  }
  return hunks;
}

/** The extracted fields that drive severity. */
export interface SeverityFields {
  deadline_ts: number | null;
  amount_paise: number | null;
}

export type Severity = 0 | 1 | 2 | 3;

export function ruleSeverity(
  state: ObservationState,
  prevFields: SeverityFields | null,
  nextFields: SeverityFields | null,
): Severity {
  if (REMOVAL_STATES.has(state)) return 3;
  if (state !== 'changed') return 0;
  if (prevFields && nextFields) {
    if (prevFields.deadline_ts !== nextFields.deadline_ts || prevFields.amount_paise !== nextFields.amount_paise) {
      return 2;
    }
  }
  return 1;
}

export function clampSeverity(n: number): Severity {
  if (!Number.isFinite(n)) return 0;
  return Math.min(3, Math.max(0, Math.round(n))) as Severity;
}

export function finalSeverity(rule: number, llm: number | null | undefined): Severity {
  return clampSeverity(Math.max(rule, llm ?? 0));
}
