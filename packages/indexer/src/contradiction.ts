import type { FlagInput } from './db.js';

export const CONTRADICTION_FLAG_KIND = 'contradiction' as const;
export const CONTRADICTION_FLAG_KINDS = [CONTRADICTION_FLAG_KIND] as const;

/** Latest content snapshot for one source (page or PDF) of a notice. */
export interface SourceSnapshot {
  docId: string;
  sourceKind: 'page' | 'pdf';
  /** Observation entity key that carried these fields. */
  key: string;
  deadlineTs: number | null;
  deadlineDate: string | null;
  amountPaise: number | null;
}

/**
 * Stretch S1: when the same `notice_id` has both a page and a PDF source, and their latest
 * `deadline_ts` or `amount_paise` disagree, open a `contradiction` flag (severity 2).
 */
export function pagePdfContradiction(page: SourceSnapshot, pdf: SourceSnapshot): FlagInput | null {
  const diffs: {
    field: 'deadline' | 'amount';
    page: string | number | null;
    pdf: string | number | null;
  }[] = [];

  if (page.deadlineTs !== null && pdf.deadlineTs !== null && page.deadlineTs !== pdf.deadlineTs) {
    diffs.push({
      field: 'deadline',
      page: page.deadlineDate ?? page.deadlineTs,
      pdf: pdf.deadlineDate ?? pdf.deadlineTs,
    });
  }
  if (page.amountPaise !== null && pdf.amountPaise !== null && page.amountPaise !== pdf.amountPaise) {
    diffs.push({ field: 'amount', page: page.amountPaise, pdf: pdf.amountPaise });
  }
  if (diffs.length === 0) return null;

  const deadlineDiff = diffs.find((d) => d.field === 'deadline');
  const badge =
    deadlineDiff !== undefined
      ? `sources disagree: page says ${String(deadlineDiff.page)}, PDF says ${String(deadlineDiff.pdf)}`
      : `sources disagree: page says ${String(diffs[0]?.page)}, PDF says ${String(diffs[0]?.pdf)}`;

  return {
    kind: CONTRADICTION_FLAG_KIND,
    severity: 2,
    details: {
      notice_badge: badge,
      page: {
        doc_id: page.docId,
        key: page.key,
        deadline_ts: page.deadlineTs,
        deadline_date: page.deadlineDate,
        amount_paise: page.amountPaise,
      },
      pdf: {
        doc_id: pdf.docId,
        key: pdf.key,
        deadline_ts: pdf.deadlineTs,
        deadline_date: pdf.deadlineDate,
        amount_paise: pdf.amountPaise,
      },
      diffs,
    },
    entityKeys: [page.key, pdf.key].sort(),
  };
}
