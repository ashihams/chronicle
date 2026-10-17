import { NO_CONTENT_STATES, type Change, type NoticeFields, type ObservationState } from '@chronicle/core';

function describeFields(f: NoticeFields | null): string {
  if (f === null) return '';
  const parts: string[] = [];
  if (f.deadline_date !== null) parts.push(`deadline ${f.deadline_date}`);
  if (f.amount_paise !== null) parts.push(`amount Rs. ${(f.amount_paise / 100).toFixed(2)}`);
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

function describeChange(c: Change): string | null {
  const from = c.from ?? 'none';
  const to = c.to ?? 'none';
  switch (c.field) {
    case 'deadline':
      return `deadline changed from ${from} to ${to}`;
    case 'amount':
      return `amount changed from Rs. ${from} to Rs. ${to}`;
    default:
      return null;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A neutral one-line summary built only from the state and extracted fields, never from document text. */
export function ruleSummary(input: {
  state: ObservationState;
  previousState: ObservationState | null;
  changes: Change[];
  fields: NoticeFields | null;
}): string {
  switch (input.state) {
    case 'first_seen':
      return `First observation of this notice by this watcher${describeFields(input.fields)}.`;
    case 'changed': {
      const parts = input.changes.map(describeChange).filter((s): s is string => s !== null);
      return parts.length === 0 ? 'The notice text changed.' : `${capitalize(parts.join('; '))}.`;
    }
    case 'present':
      return input.previousState !== null && NO_CONTENT_STATES.has(input.previousState)
        ? `The notice is available again after ${input.previousState}, with content seen before.`
        : 'The notice is unchanged since the last observation.';
    case 'removed_404':
      return 'The notice URL returned HTTP 404 (not found).';
    case 'removed_410':
      return 'The notice URL returned HTTP 410 (gone).';
    case 'redirected':
      return 'The notice URL now redirects away from the notice.';
    case 'soft_removed':
      return 'The notice URL responds but no longer shows the notice.';
    case 'unreachable':
      return 'The notice URL could not be reached on consecutive checks.';
    case 'delisted':
      return 'The notice is no longer listed on its index page.';
  }
}
