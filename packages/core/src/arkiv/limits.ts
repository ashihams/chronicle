import { ArkivValidationError, type Attrs, type QueryInput } from './types.js';

/**
 * Limits from @arkiv-network/sdk 0.8.1 (src/attr). One operation carries at most 32 cells, and
 * `$payload` plus `$contentType` use two of them.
 */
export const MAX_CELLS = 32;
export const MAX_USER_ATTRIBUTES = MAX_CELLS - 2;
export const MAX_STRING_BYTES = 128;
export const MAX_NAME_BYTES = 32;
export const MAX_PAYLOAD_BYTES = 128 * 1024;
export const MAX_QUERY_LIMIT = 200;
export const BLOCK_TIME_SECONDS = 2;

const NAME_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;
const RESERVED_NAMES = new Set([
  'and',
  'or',
  'not',
  'true',
  'false',
  'startswith',
  'exists',
  'typeof',
  'bool',
  'i32',
  'u64',
  'u256',
  'dec',
  'bytes32',
  'bytes',
  'str',
  'addr',
  'key',
]);

export function validateAttrName(name: string): void {
  if (!NAME_RE.test(name)) throw new ArkivValidationError(`attribute name "${name}" is not a valid identifier`);
  if (name.length > MAX_NAME_BYTES) throw new ArkivValidationError(`attribute name "${name}" exceeds 32 bytes`);
  if (name.includes('--')) throw new ArkivValidationError(`attribute name "${name}" contains "--"`);
  if (RESERVED_NAMES.has(name.toLowerCase())) throw new ArkivValidationError(`attribute name "${name}" is reserved`);
}

export function utf8Length(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function validateStringValue(name: string, value: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new ArkivValidationError(`attribute "${name}" contains a control character`);
  }
  const bytes = utf8Length(value);
  if (bytes > MAX_STRING_BYTES) {
    throw new ArkivValidationError(`attribute "${name}" is ${bytes} bytes; the limit is ${MAX_STRING_BYTES}`);
  }
}

/** Numbers are stored as u64, so they must be non-negative safe integers. */
export function validateNumberValue(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ArkivValidationError(`attribute "${name}" must be a non-negative safe integer, got ${value}`);
  }
}

export function validateAttrs(attrs: Attrs): void {
  const entries = Object.entries(attrs);
  if (entries.length > MAX_USER_ATTRIBUTES) {
    throw new ArkivValidationError(`${entries.length} attributes; the limit is ${MAX_USER_ATTRIBUTES}`);
  }
  for (const [name, value] of entries) {
    validateAttrName(name);
    if (typeof value === 'string') {
      if (value === '') throw new ArkivValidationError(`attribute "${name}" is empty; omit it instead`);
      validateStringValue(name, value);
    } else if (typeof value === 'number') {
      validateNumberValue(name, value);
    } else {
      throw new ArkivValidationError(`attribute "${name}" must be a string or number`);
    }
  }
}

export function encodePayload(payload: unknown): Uint8Array {
  const json = JSON.stringify(payload ?? null);
  const bytes = new TextEncoder().encode(json);
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    throw new ArkivValidationError(`payload is ${bytes.length} bytes; the limit is ${MAX_PAYLOAD_BYTES}`);
  }
  return bytes;
}

export function decodePayload(bytes: Uint8Array | null): unknown | null {
  if (bytes === null || bytes.length === 0) return null;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

/** Expiry is counted in 2-second blocks; round up so an entity never lives shorter than asked. */
export function ttlToBlocks(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new ArkivValidationError(`ttlSeconds must be positive, got ${ttlSeconds}`);
  }
  return Math.ceil(ttlSeconds / BLOCK_TIME_SECONDS);
}

export function validateQuery(q: QueryInput): void {
  if (q.where.length === 0 && q.creator === undefined && q.owner === undefined) {
    throw new ArkivValidationError('a query needs at least one filter');
  }
  if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > MAX_QUERY_LIMIT)) {
    throw new ArkivValidationError(`limit must be an integer in 1..${MAX_QUERY_LIMIT}`);
  }
  for (const w of q.where) {
    if (!w.attr.startsWith('$')) validateAttrName(w.attr);
    if (w.op === 'prefix' && typeof w.value !== 'string') {
      throw new ArkivValidationError(`prefix on "${w.attr}" needs a string value`);
    }
    if ((w.op === 'gt' || w.op === 'gte' || w.op === 'lt' || w.op === 'lte') && typeof w.value !== 'number') {
      throw new ArkivValidationError(`range operator on "${w.attr}" needs a numeric value; strings are equality-only`);
    }
    if (typeof w.value === 'string') validateStringValue(w.attr, w.value);
    else validateNumberValue(w.attr, w.value);
  }
}

export function normalizeAddress(a: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new ArkivValidationError(`"${a}" is not an address`);
  return a.toLowerCase();
}

export function normalizeKey(k: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new ArkivValidationError(`"${k}" is not a 32-byte entity key`);
  return k.toLowerCase();
}
