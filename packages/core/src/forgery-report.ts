import { ArkivValidationError, type Attrs } from './arkiv/types.js';
import { MAX_STRING_BYTES, MAX_USER_ATTRIBUTES, validateAttrs } from './arkiv/limits.js';
import { SCHEMA_V, ObservationBuildError, truncateUtf8 } from './observation.js';

const HASH_RE = /^[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const FORGERY_REASON_CODES = ['altered_content', 'wrong_source', 'misleading_copy', 'other'] as const;
export type ForgeryReasonCode = (typeof FORGERY_REASON_CODES)[number];

export interface ForgeryReportInput {
  normSha256: string;
  reasonCode: string;
  /** Optional; omitted when empty or too long for a 128-byte attribute. */
  realSourceUrl?: string | null;
}

function fail(msg: string): never {
  throw new ObservationBuildError(msg);
}

function finish(attrs: Attrs): Attrs {
  if (Object.keys(attrs).length > MAX_USER_ATTRIBUTES) fail(`more than ${MAX_USER_ATTRIBUTES} attributes`);
  try {
    validateAttrs(attrs);
  } catch (err) {
    if (err instanceof ArkivValidationError) fail(err.message);
    throw err;
  }
  return attrs;
}

/**
 * Stretch S5: attributes for a `forgery_report` entity.
 * Reporter identity is Arkiv `$creator` (not an attribute). Never store personal data.
 */
export function buildForgeryReportAttrs(input: ForgeryReportInput): Attrs {
  if (!HASH_RE.test(input.normSha256)) fail('norm_sha256 must be 64 lowercase hex characters');
  if (!SLUG_RE.test(input.reasonCode)) fail(`reason_code "${input.reasonCode}" must be a lowercase slug`);
  const attrs: Attrs = {
    type: 'forgery_report',
    schema_v: SCHEMA_V,
    norm_sha256: input.normSha256,
    reason_code: input.reasonCode,
  };
  const url = input.realSourceUrl?.trim();
  if (url !== undefined && url !== '') {
    const truncated = truncateUtf8(url, MAX_STRING_BYTES);
    if (truncated.length > 0) attrs.real_source_url = truncated;
  }
  return finish(attrs);
}

export function buildForgeryReportPayload(): Record<string, never> {
  return {};
}
