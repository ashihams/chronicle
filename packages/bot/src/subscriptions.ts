import { FILTER_TYPES, type FilterType, type Subscription } from './db.js';

const DOC_ID_RE = /^[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ParsedFollow {
  filterType: FilterType;
  filterValue: string;
}

export interface FollowParseError {
  error: string;
}

/**
 * `/follow <type> <value>` with type in department|scheme|doc_id|keyword.
 * Shorthand: `/follow <64-hex>` → doc_id.
 */
export function parseFollowArgs(raw: string): ParsedFollow | FollowParseError {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) {
    return { error: 'Usage: /follow <department|scheme|doc_id|keyword> <value>  (or /follow <64-hex doc_id>)' };
  }
  if (parts.length === 1) {
    const only = parts[0] as string;
    if (DOC_ID_RE.test(only)) return { filterType: 'doc_id', filterValue: only };
    return { error: 'Usage: /follow <department|scheme|doc_id|keyword> <value>' };
  }
  const type = parts[0] as string;
  if (!(FILTER_TYPES as readonly string[]).includes(type)) {
    return { error: `Unknown filter type "${type}". Use department, scheme, doc_id, or keyword.` };
  }
  const filterType = type as FilterType;
  const filterValue = parts.slice(1).join(' ').trim().toLowerCase();
  if (filterValue === '') return { error: 'Filter value is required.' };
  if (filterType === 'doc_id' && !DOC_ID_RE.test(filterValue)) {
    return { error: 'doc_id must be 64 lowercase hex characters.' };
  }
  if ((filterType === 'department' || filterType === 'scheme') && !SLUG_RE.test(filterValue)) {
    return { error: `${filterType} must be a lowercase slug (letters, digits, hyphens).` };
  }
  if (filterType === 'keyword' && filterValue.length > 64) {
    return { error: 'keyword must be at most 64 characters.' };
  }
  return { filterType, filterValue };
}

export interface DocMatchFields {
  doc_id: string;
  notice_id: string | null;
  title: string | null;
  department: string | null;
  scheme: string | null;
  summary_en?: string | null;
}

/** Whether a subscription filter matches a document snapshot. */
export function matchesSubscription(doc: DocMatchFields, sub: Pick<Subscription, 'filterType' | 'filterValue'>): boolean {
  switch (sub.filterType) {
    case 'department':
      return (doc.department ?? '').toLowerCase() === sub.filterValue;
    case 'scheme':
      return (doc.scheme ?? '').toLowerCase() === sub.filterValue;
    case 'doc_id':
      return doc.doc_id === sub.filterValue;
    case 'keyword': {
      const k = sub.filterValue;
      const hay = [doc.title, doc.notice_id, doc.department, doc.scheme, doc.summary_en]
        .filter((x): x is string => typeof x === 'string' && x.length > 0)
        .join('\n')
        .toLowerCase();
      return hay.includes(k);
    }
    default:
      return false;
  }
}

/** Distinct chat IDs whose subscriptions match the doc. */
export function matchingChatIds(doc: DocMatchFields, subs: Subscription[]): number[] {
  const ids = new Set<number>();
  for (const s of subs) {
    if (matchesSubscription(doc, s)) ids.add(s.chatId);
  }
  return [...ids].sort((a, b) => a - b);
}
