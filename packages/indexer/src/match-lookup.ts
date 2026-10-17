import { hammingDistanceHex, simhashHex } from '@chronicle/core';
import type { IndexerDb } from './db.js';
import { buildMatchResponse, type MatchResponse, type VersionLookup } from './match.js';
import type { ReplyLang } from './match-i18n.js';

/** Stretch S5: near-match when Hamming distance of 64-bit SimHashes is at most this. */
export const SIMHASH_HAMMING_MAX = 3;

export interface LookupMatchInput {
  normSha256: string;
  rawSha256?: string;
  /** Normalized text used to compute a query SimHash when no exact match. */
  normalizedText?: string;
  lang?: ReplyLang;
}

/**
 * Resolves `/api/match` against the mirror: exact hash first, then SimHash near-match
 * (stretch S5), always attaching forgery-report counts for the query or similar hit hash.
 */
export function lookupMatch(db: IndexerDb, input: LookupMatchInput): MatchResponse {
  const lang = input.lang ?? 'en';
  const byKey = new Map<string, VersionLookup>();

  const addVersion = (docId: string, normSha256: string, hamming?: number): void => {
    const doc = db.getDoc(docId);
    if (doc === null) return;
    for (const v of db.versionsForDoc(docId)) {
      if (v.normSha256 !== normSha256) continue;
      const siblings = db.versionsForDoc(docId).filter((s) => s.normalizerVersion === v.normalizerVersion);
      byKey.set(`${v.docId}|${v.normalizerVersion}|${v.seq}`, {
        version: v,
        doc,
        siblings,
        ...(hamming !== undefined ? { hammingDistance: hamming } : {}),
      });
    }
  };

  for (const v of db.versionsByNormSha256(input.normSha256)) {
    addVersion(v.docId, v.normSha256);
  }

  if (input.rawSha256 !== undefined) {
    for (const hit of db.observationsByRawSha256(input.rawSha256)) {
      addVersion(hit.docId, hit.normSha256 ?? input.normSha256);
    }
  }

  const exact = [...byKey.values()];
  if (exact.length > 0) {
    const stats = db.forgeryReportStats(input.normSha256);
    return buildMatchResponse(exact, {
      lang,
      forgery: { distinctCreators: stats.distinctCreators, reasonCodes: stats.reasonCodes },
    });
  }

  let similar: VersionLookup[] = [];
  if (input.normalizedText !== undefined && input.normalizedText.trim() !== '') {
    const queryHash = simhashHex(input.normalizedText);
    let bestDist = SIMHASH_HAMMING_MAX + 1;
    let bestNorm: string | null = null;
    for (const c of db.observationsWithSimhash()) {
      let dist: number;
      try {
        dist = hammingDistanceHex(queryHash, c.simhashHex);
      } catch {
        continue;
      }
      if (dist <= SIMHASH_HAMMING_MAX && (dist < bestDist || (dist === bestDist && (bestNorm === null || c.normSha256 < bestNorm)))) {
        bestDist = dist;
        bestNorm = c.normSha256;
      }
    }
    if (bestNorm !== null) {
      byKey.clear();
      for (const v of db.versionsByNormSha256(bestNorm)) {
        addVersion(v.docId, v.normSha256, bestDist);
      }
      similar = [...byKey.values()];
    }
  }

  const reportHash = similar[0]?.version.normSha256 ?? input.normSha256;
  const stats = db.forgeryReportStats(reportHash);
  return buildMatchResponse(similar, {
    lang,
    similar: similar.length > 0,
    forgery: { distinctCreators: stats.distinctCreators, reasonCodes: stats.reasonCodes },
  });
}
