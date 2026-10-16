import type { IndexerDb } from './db.js';
import { buildMatchResponse, type MatchResponse, type VersionLookup } from './match.js';

/**
 * Resolves `/api/match` against the mirror: versions with this `norm_sha256`, and (for PDFs)
 * the version whose content hash is the `norm_sha256` of an observation that recorded this
 * exact `raw_sha256` (byte-identical file).
 */
export function lookupMatch(db: IndexerDb, hashes: { normSha256: string; rawSha256?: string }): MatchResponse {
  const byKey = new Map<string, VersionLookup>();

  const addVersion = (docId: string, normSha256: string): void => {
    const doc = db.getDoc(docId);
    if (doc === null) return;
    for (const v of db.versionsForDoc(docId)) {
      if (v.normSha256 !== normSha256) continue;
      const siblings = db.versionsForDoc(docId).filter((s) => s.normalizerVersion === v.normalizerVersion);
      byKey.set(`${v.docId}|${v.normalizerVersion}|${v.seq}`, { version: v, doc, siblings });
    }
  };

  for (const v of db.versionsByNormSha256(hashes.normSha256)) {
    addVersion(v.docId, v.normSha256);
  }

  if (hashes.rawSha256 !== undefined) {
    for (const hit of db.observationsByRawSha256(hashes.rawSha256)) {
      addVersion(hit.docId, hit.normSha256 ?? hashes.normSha256);
    }
  }

  return buildMatchResponse([...byKey.values()]);
}
