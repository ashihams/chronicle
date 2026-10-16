import { z } from 'zod';
import { sha256Of } from './hash.js';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const entityKey = z.string().regex(/^0x[0-9a-f]{64}$/);

export const BundleDocSchema = z
  .object({
    doc_id: hex64,
    notice_id: z.string().nullable(),
    source_url: z.string().nullable(),
    department: z.string().nullable(),
    title: z.string().nullable(),
  })
  .strict();

export const BundleVersionSchema = z
  .object({
    seq: z.number().int().positive(),
    norm_sha256: hex64,
    first_seen_ts: z.number().int().nonnegative(),
    first_entity_key: entityKey,
    status: z.enum(['current', 'superseded']),
  })
  .strict();

export const BundleFlagSchema = z
  .object({
    kind: z.string().min(1),
    severity: z.number().int().min(0).max(3),
    entity_keys: z.array(entityKey),
  })
  .strict();

export const BundleEntrySchema = z
  .object({
    entity_key: entityKey,
    tx_hash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
    creator: address,
    owner: address,
    creation_block: z.number().int().nonnegative(),
    creation_ts: z.number().int().nonnegative(),
    expiry_block: z.number().int().nonnegative().nullable(),
    attributes: z.record(z.union([z.string(), z.number()])),
    payload_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const BundleSchema = z
  .object({
    bundle_version: z.literal(1),
    generated_at: z.number().int().nonnegative(),
    chain_id: z.number().int().positive(),
    rpc: z.string().url(),
    doc: BundleDocSchema,
    versions: z.array(BundleVersionSchema),
    flags: z.array(BundleFlagSchema),
    entries: z.array(BundleEntrySchema),
    bundle_sha256: hex64,
  })
  .strict();

export type EvidenceBundle = z.infer<typeof BundleSchema>;
export type BundleEntry = z.infer<typeof BundleEntrySchema>;
export type BundleWithoutHash = Omit<EvidenceBundle, 'bundle_sha256'>;

/** sha256 of the canonical JSON of the bundle without `bundle_sha256`. */
export function computeBundleSha256(body: BundleWithoutHash): string {
  return sha256Of(body);
}

/** Parses and checks the embedded hash. Throws zod errors or a plain Error on hash mismatch. */
export function parseAndCheckBundle(raw: unknown): EvidenceBundle {
  const bundle = BundleSchema.parse(raw);
  const { bundle_sha256: claimed, ...rest } = bundle;
  const actual = computeBundleSha256(rest);
  if (actual !== claimed) {
    throw new Error(`bundle_sha256 mismatch: claimed ${claimed}, recomputed ${actual}`);
  }
  return bundle;
}

/** Attaches `bundle_sha256` to a body that is otherwise complete. */
export function sealBundle(body: BundleWithoutHash): EvidenceBundle {
  return { ...body, bundle_sha256: computeBundleSha256(body) };
}
