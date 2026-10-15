import type { AttrValue, Where } from './types.js';

/**
 * Evaluates one predicate the way the Arkiv engine does: a value of a different type never
 * matches (a string attribute is not equal to a number), range operators only apply to numbers,
 * and `prefix` only applies to strings.
 */
export function matchesWhere(actual: AttrValue | undefined, w: Where): boolean {
  if (actual === undefined || typeof actual !== typeof w.value) return false;
  switch (w.op) {
    case 'eq':
      return actual === w.value;
    case 'prefix':
      return typeof actual === 'string' && actual.startsWith(w.value as string);
    case 'gt':
      return (actual as number) > (w.value as number);
    case 'gte':
      return (actual as number) >= (w.value as number);
    case 'lt':
      return (actual as number) < (w.value as number);
    case 'lte':
      return (actual as number) <= (w.value as number);
  }
}

/** Human-readable form of a where list, used by API responses to show the exact query. */
export function describeWhere(where: Where[], extra: { creator?: string; owner?: string } = {}): string {
  const ops: Record<Where['op'], string> = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=', prefix: 'STARTSWITH' };
  const parts = where.map(
    (w) => `${w.attr} ${ops[w.op]} ${typeof w.value === 'string' ? `str('${w.value}')` : `u64(${w.value})`}`,
  );
  if (extra.creator) parts.push(`$creator = addr(${extra.creator})`);
  if (extra.owner) parts.push(`$owner = addr(${extra.owner})`);
  return parts.join(' AND ');
}
