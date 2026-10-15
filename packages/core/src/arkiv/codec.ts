import { validateAttrs } from './limits.js';
import { addr, and, eq, gt, gte, key, lt, lte, startsWith, str, u64 } from './sdk.js';
import type { AnyArkivValue, ArkivValue, Expression } from './sdk.js';
import type { Attrs, AttrValue, QueryInput, Where } from './types.js';
import { ArkivValidationError } from './types.js';

/** Our convention: every string is a `str`, every number a `u64`. Reads and writes must agree. */
export function toSdkAttributes(attrs: Attrs): Record<string, ArkivValue> {
  validateAttrs(attrs);
  const out: Record<string, ArkivValue> = {};
  for (const [name, value] of Object.entries(attrs)) {
    out[name] = typeof value === 'string' ? str(value) : u64(value);
  }
  return out;
}

export function fromSdkValue(v: AnyArkivValue): AttrValue {
  switch (v.type) {
    case 'str':
      return v.value;
    case 'i32':
      return v.value;
    case 'u64':
    case 'u256': {
      const n = v.value;
      return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString();
    }
    case 'bool':
      return v.value ? 1 : 0;
    default:
      return String(v.value);
  }
}

export function fromSdkAttributes(attrs: Readonly<Record<string, AnyArkivValue>> | undefined): Attrs {
  const out: Attrs = {};
  for (const [name, v] of Object.entries(attrs ?? {})) out[name] = fromSdkValue(v);
  return out;
}

function literal(attr: string, value: AttrValue): ArkivValue {
  switch (attr) {
    case '$key':
      return key(String(value) as `0x${string}`);
    case '$owner':
    case '$creator':
      return addr(String(value));
    case '$expiresAt':
      return u64(Number(value));
    default:
      return typeof value === 'string' ? str(value) : u64(value);
  }
}

function whereToExpression(w: Where): Expression {
  const v = literal(w.attr, w.value);
  switch (w.op) {
    case 'eq':
      return eq(w.attr, v);
    case 'gt':
      return gt(w.attr, v);
    case 'gte':
      return gte(w.attr, v);
    case 'lt':
      return lt(w.attr, v);
    case 'lte':
      return lte(w.attr, v);
    case 'prefix':
      if (typeof w.value !== 'string') throw new ArkivValidationError('prefix needs a string');
      return startsWith(w.attr, w.value);
  }
}

export function toSdkExpression(q: QueryInput): Expression {
  const parts = q.where.map(whereToExpression);
  if (q.creator !== undefined) parts.push(eq('$creator', addr(q.creator)));
  if (q.owner !== undefined) parts.push(eq('$owner', addr(q.owner)));
  if (parts.length === 0) throw new ArkivValidationError('a query needs at least one filter');
  return and(parts);
}
