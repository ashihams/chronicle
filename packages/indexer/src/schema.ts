import { OBSERVATION_STATES, SOURCE_KINDS, type Attrs } from '@chronicle/core';
import { z } from 'zod';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const ts = z.number().int().nonnegative();
const str = z.string().min(1).max(128);

/** Section 5.3. Unknown (stretch) attributes are kept. */
export const ObservationAttrsSchema = z
  .object({
    type: z.literal('observation'),
    schema_v: z.literal(1),
    doc_id: hex64,
    notice_id: str,
    source_kind: z.enum(SOURCE_KINDS),
    vantage: str,
    observed_at: ts,
    normalizer_version: str,
    state: z.enum(OBSERVATION_STATES),
    http_status: z.number().int().min(0).max(999),
    redirect_chain_len: z.number().int().nonnegative(),
    raw_sha256: hex64.optional(),
    norm_sha256: hex64.optional(),
    prev_norm_sha256: hex64.optional(),
    text_extracted: z.union([z.literal(0), z.literal(1)]).optional(),
    last_modified_ts: ts.optional(),
    printed_date_ts: ts.optional(),
    deadline_ts: ts.optional(),
    deadline_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    amount_paise: ts.optional(),
    department: str,
    scheme: str.optional(),
    severity: z.number().int().min(0).max(3),
  })
  .passthrough();
export type ObservationAttrs = z.infer<typeof ObservationAttrsSchema>;

/** Section 5.2. */
export const DocAttrsSchema = z
  .object({
    type: z.literal('doc'),
    schema_v: z.literal(1),
    doc_id: hex64,
    notice_id: str,
    source_kind: z.enum(SOURCE_KINDS),
    source_url: str.optional(),
    department: str,
    scheme: str.optional(),
    lang: str,
  })
  .passthrough();
export type DocAttrs = z.infer<typeof DocAttrsSchema>;

const nullableText = z.string().nullable().catch(null);

/** Payloads are read leniently: a malformed field becomes null instead of dropping the entity. */
export const ObservationPayloadSchema = z
  .object({
    title: nullableText.default(null),
    summary_en: nullableText.default(null),
    final_url: nullableText.default(null),
    changes: z
      .array(z.object({ field: z.string(), from: z.string().nullable(), to: z.string().nullable() }))
      .catch([])
      .default([]),
    extractor: z.object({ model: z.string(), confidence: z.number() }).nullable().catch(null).default(null),
    declared_supersedes: nullableText.default(null),
  })
  .catch({ title: null, summary_en: null, final_url: null, changes: [], extractor: null, declared_supersedes: null });
export type ObservationPayloadView = z.infer<typeof ObservationPayloadSchema>;

export const DocPayloadSchema = z
  .object({
    title: nullableText.default(null),
    registered_vantage: nullableText.default(null),
    source_url: nullableText.default(null),
  })
  .catch({ title: null, registered_vantage: null, source_url: null });
export type DocPayloadView = z.infer<typeof DocPayloadSchema>;

export const MIRRORED_TYPES = ['doc', 'observation', 'index_snapshot'] as const;
export type MirroredType = (typeof MIRRORED_TYPES)[number];

/** Why an entity is not mirrored, or null when its attributes are valid for its type. */
export function rejectReason(attrs: Attrs): string | null {
  const type = attrs.type;
  if (type === 'observation') return issues(ObservationAttrsSchema.safeParse(attrs));
  if (type === 'doc') return issues(DocAttrsSchema.safeParse(attrs));
  if (type === 'index_snapshot') return attrs.schema_v === 1 ? null : 'schema_v must be 1';
  return `unsupported type ${String(type)}`;
}

function issues(r: z.SafeParseReturnType<unknown, unknown>): string | null {
  if (r.success) return null;
  return r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}
