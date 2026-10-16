import { sealBundle, type BundleWithoutHash, type EvidenceBundle } from '@chronicle/core';
import type { IndexerDb } from './db.js';

export interface BundleBuildMeta {
  chainId: number;
  rpc: string;
  /** Unix seconds. */
  generatedAt: number;
}

/**
 * Builds a `bundle_version: 1` evidence bundle from the mirror. Entries are every mirrored
 * entity for the doc (doc + observations), ordered by `(creation_block, entity_key)`.
 */
export function buildEvidenceBundle(db: IndexerDb, docId: string, meta: BundleBuildMeta): EvidenceBundle | null {
  const doc = db.getDoc(docId);
  if (doc === null) return null;

  const entities = [...db.docEntities(docId), ...db.observationsForDoc(docId)].sort((a, b) => {
    if (a.createdBlock !== b.createdBlock) return a.createdBlock - b.createdBlock;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const versions = db.versionsForDoc(docId).map((v) => ({
    seq: v.seq,
    norm_sha256: v.normSha256,
    first_seen_ts: v.firstSeenTs,
    first_entity_key: v.firstEntityKey,
    status: v.status,
  }));

  const flags = db.flagsForDoc(docId, true).map((f) => ({
    kind: f.kind,
    severity: f.severity,
    entity_keys: f.entityKeys,
  }));

  const body: BundleWithoutHash = {
    bundle_version: 1,
    generated_at: meta.generatedAt,
    chain_id: meta.chainId,
    rpc: meta.rpc,
    doc: {
      doc_id: doc.docId,
      notice_id: doc.noticeId,
      source_url: doc.sourceUrl,
      department: doc.department,
      title: doc.title,
    },
    versions,
    flags,
    entries: entities.map((e) => ({
      entity_key: e.key,
      tx_hash: e.txHash,
      creator: e.creator,
      owner: e.owner,
      creation_block: e.createdBlock,
      creation_ts: e.createdTs,
      expiry_block: e.expiresBlock,
      attributes: { ...e.attrs },
      payload_sha256: e.payloadSha256,
    })),
  };

  return sealBundle(body);
}
