export function formatWhen(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '—';
  return new Date(ts * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC');
}

export function formatDay(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '—';
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function shortHex(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function stateBadge(
  state: string | null,
  disputed: boolean,
  contradiction = false,
): { label: string; className: string } {
  if (contradiction) {
    return { label: 'Sources disagree', className: 'badge-disputed' };
  }
  if (disputed) {
    return { label: 'Disputed', className: 'badge-disputed' };
  }
  if (state === null) return { label: 'Unknown', className: 'badge-muted' };
  if (state === 'changed') return { label: 'Changed', className: 'badge-changed' };
  if (state === 'removed_404' || state === 'removed_410' || state === 'soft_removed' || state === 'delisted') {
    return { label: 'Removed', className: 'badge-removed' };
  }
  if (state === 'redirected') return { label: 'Redirected', className: 'badge-changed' };
  if (state === 'unreachable') return { label: 'Unreachable', className: 'badge-muted' };
  return { label: 'Current', className: 'badge-current' };
}

/** Plain-language flag copy. Never uses "fraud" or "fake". */
export function flagExplanation(kind: string): string {
  switch (kind) {
    case 'vantage_disagreement':
      return 'Sources disagree: two watchers recently reported different content (or one reported a removal) for the same notice.';
    case 'contradiction':
      return 'Sources disagree: page and PDF currently report different deadlines or amounts for the same notice.';
    case 'delisted':
      return 'Still reachable at its URL, but no longer listed on the watched index page.';
    case 'stealth_removed':
      return 'Removed from listing without a withdrawal notice.';
    case 'declared_withdrawn':
      return 'The index gained a withdrawal-style notice when this link disappeared.';
    case 'backdated':
      return 'A later version carries a printed date or Last-Modified far earlier than when watchers first saw that version.';
    case 'clock_skew':
      return "A watcher's claimed observation time is far from the chain time of its block.";
    case 'reverted':
      return 'The version currently seen by most recent watchers is older than a later version that was recorded.';
    case 'owner_modified':
      return "An on-chain entity's payload or attributes no longer match what was first mirrored.";
    case 'missing':
      return 'A mirrored entity is gone from Arkiv before its recorded expiry.';
    case 'sig_invalid':
      return 'The PDF digital signature did not validate, or the document appears modified after signing. This is not a judgment that the notice is fake.';
    case 'metadata_inconsistent':
      return 'PDF metadata looks inconsistent (for example an online editor producer, or CreationDate far after the printed date). Soft signal only.';
    default:
      return 'A derived condition on this document. Inspect the timeline for details.';
  }
}

/**
 * Stretch S3 UI copy for `sig_status`. Never says "authentic".
 * Unsigned is neutral — many genuine circulars have no digital signature.
 */
export type SummaryLang = 'en' | 'ta' | 'hi';

/** Pick a localized summary; fall back to English. TA/HI are machine-generated. */
export function pickSummary(
  lang: SummaryLang,
  summaries: { summary_en?: string | null; summary_ta?: string | null; summary_hi?: string | null },
): { text: string | null; machineGenerated: boolean } {
  if (lang === 'ta' && summaries.summary_ta) {
    return { text: summaries.summary_ta, machineGenerated: true };
  }
  if (lang === 'hi' && summaries.summary_hi) {
    return { text: summaries.summary_hi, machineGenerated: true };
  }
  const en = summaries.summary_en ?? null;
  return { text: en, machineGenerated: false };
}

export function signatureWording(status: string | null | undefined): string | null {
  switch (status) {
    case 'signed_valid':
      return 'Signature intact';
    case 'signed_modified':
      return 'Signature invalid: document appears modified after signing';
    case 'signed_invalid':
      return 'Signature invalid';
    case 'unsigned':
      return 'No digital signature. Many genuine circulars are unsigned.';
    default:
      return null;
  }
}
