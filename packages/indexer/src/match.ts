import { sha256Hex } from '@chronicle/core';
import type { DocRow, VersionRow } from './db.js';
import { forgeryReportNote, localizedMatchNote, type ReplyLang } from './match-i18n.js';

export type MatchResultKind = 'exact_match' | 'similar_match' | 'no_match';

export interface MatchChange {
  seq: number;
  summary_en: string | null;
  first_seen_ts: number;
}

export interface MatchHit {
  doc_id: string;
  title: string | null;
  department: string | null;
  version_seq: number;
  current_seq: number | null;
  status: 'current' | 'superseded';
  superseded_at: number | null;
  observer_count: number;
  changes_since: MatchChange[];
  timeline_url: string;
  /** Present for similar_match. */
  hamming_distance?: number;
}

export interface ForgeryReportSummary {
  distinct_creators: number;
  reason_codes: string[];
  note: string | null;
}

export interface MatchResponse {
  result: MatchResultKind;
  match: MatchHit | null;
  note: string;
  /** Stretch S5 label when result is similar_match. */
  similar_label?: string;
  forgery_reports: ForgeryReportSummary;
}

export interface VersionLookup {
  version: VersionRow;
  doc: DocRow;
  /** Same normalizer version, ordered by seq. */
  siblings: VersionRow[];
  hammingDistance?: number;
}

export interface BuildMatchOptions {
  lang?: ReplyLang;
  forgery?: { distinctCreators: number; reasonCodes: string[] };
  similar?: boolean;
}

/**
 * Builds the `/api/match` payload from version rows that share a content or raw-bytes hash.
 * When several docs match, the one whose matched version is current wins; otherwise the
 * highest matched `seq` wins, then the lower `doc_id`.
 */
export function buildMatchResponse(lookups: VersionLookup[], opts: BuildMatchOptions = {}): MatchResponse {
  const lang = opts.lang ?? 'en';
  const forgeryCreators = opts.forgery?.distinctCreators ?? 0;
  const forgeryCodes = opts.forgery?.reasonCodes ?? [];
  const forgery_reports: ForgeryReportSummary = {
    distinct_creators: forgeryCreators,
    reason_codes: forgeryCodes,
    note: forgeryReportNote(forgeryCreators, lang),
  };

  if (lookups.length === 0) {
    return {
      result: 'no_match',
      match: null,
      note: localizedMatchNote('no_match', null, lang),
      forgery_reports,
    };
  }
  const ranked = [...lookups].sort((a, b) => {
    const ac = a.version.status === 'current' ? 1 : 0;
    const bc = b.version.status === 'current' ? 1 : 0;
    if (ac !== bc) return bc - ac;
    if (a.version.seq !== b.version.seq) return b.version.seq - a.version.seq;
    return a.doc.docId < b.doc.docId ? -1 : a.doc.docId > b.doc.docId ? 1 : 0;
  });
  const best = ranked[0] as VersionLookup;
  const current = best.siblings.find((v) => v.status === 'current') ?? null;
  const next = best.siblings.find((v) => v.seq === best.version.seq + 1) ?? null;
  const changes_since: MatchChange[] = best.siblings
    .filter((v) => v.seq > best.version.seq && (current === null || v.seq <= current.seq))
    .map((v) => ({ seq: v.seq, summary_en: v.summaryEn, first_seen_ts: v.firstSeenTs }));
  const result: MatchResultKind = opts.similar === true ? 'similar_match' : 'exact_match';
  const hit: MatchHit = {
    doc_id: best.doc.docId,
    title: best.doc.title,
    department: best.doc.department,
    version_seq: best.version.seq,
    current_seq: current?.seq ?? best.doc.currentSeq,
    status: best.version.status,
    superseded_at: best.version.status === 'superseded' ? (next?.firstSeenTs ?? current?.firstSeenTs ?? null) : null,
    observer_count: best.version.observerCount,
    changes_since,
    timeline_url: `/docs/${best.doc.docId}`,
    ...(best.hammingDistance !== undefined ? { hamming_distance: best.hammingDistance } : {}),
  };
  return {
    result,
    match: hit,
    note: localizedMatchNote(result, hit, lang),
    ...(result === 'similar_match' ? { similar_label: 'similar, not identical' } : {}),
    forgery_reports,
  };
}

/** English note for an exact-hash hit (tests and callers that do not pass `lang`). */
export function matchNote(hit: MatchHit, formatDay?: (ts: number) => string): string {
  return localizedMatchNote('exact_match', hit, 'en', formatDay);
}

/** Content hash of already-normalized text (same as `norm_sha256` on observations). */
export function hashNormalizedText(normalized: string): string {
  return sha256Hex(normalized);
}
