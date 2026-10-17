import { createHash } from 'node:crypto';

/**
 * Version of the normalization rules in `normalize/`. Any change that can alter a normalized hash
 * must bump this (n1 -> n2) and be documented in PROGRESS.md and arkiv/schema.md.
 */
export const NORMALIZER_VERSION = 'n1';

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** JSON with object keys sorted at every level and no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value, new Set()));
}

export function sha256Of(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function sortValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: ${value} is not a finite number`);
    return value;
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`canonicalJson: cannot encode a ${typeof value}`);
  }
  if (typeof value === 'undefined') return undefined;
  if (seen.has(value)) throw new TypeError('canonicalJson: circular reference');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : sortValue(v, seen)));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = sortValue((value as Record<string, unknown>)[k], seen);
      if (v !== undefined) out[k] = v;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
