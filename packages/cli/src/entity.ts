import type { ArkivClient } from '@chronicle/core';

/** Live entity dump for `chronicle entity <key>`. */
export async function formatEntity(arkiv: ArkivClient, key: string): Promise<string> {
  const normalized = key.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('key must be 0x followed by 64 hex characters');
  }
  const rec = await arkiv.getEntity(normalized);
  if (rec === null) return `null (no live entity ${normalized})`;
  return JSON.stringify(
    {
      key: rec.key,
      creator: rec.creator,
      owner: rec.owner,
      created_block: Number(rec.createdAtBlock),
      expires_block: rec.expiresAtBlock === null ? null : Number(rec.expiresAtBlock),
      tx_hash: rec.txHash,
      attributes: rec.attributes,
      payload_sha256: rec.payloadSha256,
      payload: rec.payload,
    },
    null,
    2,
  );
}
