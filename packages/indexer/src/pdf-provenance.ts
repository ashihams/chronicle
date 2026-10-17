import { isOnlinePdfEditor, pdfCreatedAfterPrinted, SIG_STATUSES, type SigStatus } from '@chronicle/core';
import type { FlagInput } from './db.js';
import type { ObsInput } from './derive.js';
import { chainOrder } from './derive.js';

export const PDF_PROVENANCE_FLAG_KINDS = ['sig_invalid', 'metadata_inconsistent'] as const;
export type PdfProvenanceFlagKind = (typeof PDF_PROVENANCE_FLAG_KINDS)[number];

const CONTENT = new Set(['first_seen', 'present', 'changed']);

function asSigStatus(v: unknown): SigStatus | null {
  return typeof v === 'string' && (SIG_STATUSES as readonly string[]).includes(v) ? (v as SigStatus) : null;
}

function asOptString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function asOptTs(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/** Latest accepted content observation in chain order (any creator). */
export function latestContentObs(obs: ObsInput[]): ObsInput | null {
  const accepted = obs
    .filter((o) => (o.status === 'live' || o.status === 'expired') && CONTENT.has(o.attrs.state))
    .sort(chainOrder);
  return accepted.length === 0 ? null : (accepted[accepted.length - 1] as ObsInput);
}

/**
 * Stretch S3: derive `sig_invalid` (severity 3) and soft `metadata_inconsistent` (severity 1)
 * from the latest content observation's PDF provenance attributes.
 */
export function pdfProvenanceFlags(obs: ObsInput[]): FlagInput[] {
  const latest = latestContentObs(obs);
  if (latest === null) return [];

  const attrs = latest.attrs as Record<string, unknown>;
  const sigStatus = asSigStatus(attrs.sig_status);
  const producer = asOptString(attrs.pdf_producer);
  const pdfCreatedTs = asOptTs(attrs.pdf_created_ts);
  const printedDateTs = asOptTs(attrs.printed_date_ts);
  const flags: FlagInput[] = [];

  if (sigStatus === 'signed_invalid' || sigStatus === 'signed_modified') {
    flags.push({
      kind: 'sig_invalid',
      severity: 3,
      details: {
        sig_status: sigStatus,
        sig_signer_org: asOptString(attrs.sig_signer_org),
        reason:
          sigStatus === 'signed_modified'
            ? 'Document appears modified after signing'
            : 'Digital signature did not validate',
      },
      entityKeys: [latest.key],
    });
  }

  const reasons: string[] = [];
  if (isOnlinePdfEditor(producer)) reasons.push('online_editor');
  if (
    pdfCreatedTs !== null &&
    printedDateTs !== null &&
    pdfCreatedAfterPrinted(pdfCreatedTs, printedDateTs, 30)
  ) {
    reasons.push('created_after_printed');
  }
  if (reasons.length > 0) {
    flags.push({
      kind: 'metadata_inconsistent',
      severity: 1,
      details: {
        reasons,
        pdf_producer: producer,
        pdf_created_ts: pdfCreatedTs,
        printed_date_ts: printedDateTs,
      },
      entityKeys: [latest.key],
    });
  }

  return flags;
}
