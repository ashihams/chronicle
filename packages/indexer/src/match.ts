import { sha256Hex } from '@chronicle/core';
import type { DocRow, VersionRow } from './db.js';

export type MatchResultKind = 'exact_match' | 'no_match';

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
}

export interface MatchResponse {
  result: MatchResultKind;
  match: MatchHit | null;
  note: string;
}

export interface VersionLookup {
  version: VersionRow;
  doc: DocRow;
  /** Same normalizer version, ordered by seq. */
  siblings: VersionRow[];
}

const NO_MATCH_NOTE = 'No exact match. Treat as unverified. This does not mean it is forged.';

/**
 * Plain-language note for an exact hash match. Dates are UTC calendar days.
 */
export function matchNote(hit: MatchHit, formatDay: (ts: number) => string = utcDay): string {
  if (hit.status === 'current') {
    return `Matches version ${hit.version_seq}, which is the current version.`;
  }
  const when = hit.superseded_at === null ? '' : ` on ${formatDay(hit.superseded_at)}`;
  const current = hit.current_seq === null ? 'A later version' : `Version ${hit.current_seq}`;
  return `Matches version ${hit.version_seq}, which was superseded${when}. ${current} is current.`;
}

function utcDay(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/**
 * Builds the `/api/match` payload from version rows that share a content or raw-bytes hash.
 * When several docs match, the one whose matched version is current wins; otherwise the
 * highest matched `seq` wins, then the lower `doc_id`.
 */
export function buildMatchResponse(lookups: VersionLookup[]): MatchResponse {
  if (lookups.length === 0) {
    return { result: 'no_match', match: null, note: NO_MATCH_NOTE };
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
  };
  return { result: 'exact_match', match: hit, note: matchNote(hit) };
}

/** Content hash of already-normalized text (same as `norm_sha256` on observations). */
export function hashNormalizedText(normalized: string): string {
  return sha256Hex(normalized);
}
