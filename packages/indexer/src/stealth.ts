import type { FlagInput } from './db.js';

export const STEALTH_FLAG_KINDS = ['delisted', 'stealth_removed', 'declared_withdrawn'] as const;
export type StealthFlagKind = (typeof STEALTH_FLAG_KINDS)[number];

export const WITHDRAWAL_TITLE_RE = /\b(withdrawn|cancelled|canceled|corrigendum|superseded)\b/i;

export interface SnapshotLink {
  docId: string;
  title: string;
}

export interface IndexSnapshotView {
  key: string;
  creator: string;
  indexId: string;
  createdBlock: number;
  links: SnapshotLink[];
}

export interface DocObservationHint {
  /** Latest content or removal observation for the vanished doc. */
  state: string | null;
  httpStatus: number | null;
  title: string | null;
}

/**
 * Classify a doc that disappeared between two consecutive snapshots from the same creator.
 * New index titles that look like withdrawal notices become `declared_withdrawn`.
 */
export function classifyVanishedDoc(hint: DocObservationHint, newIndexTitles: string[]): StealthFlagKind {
  if (newIndexTitles.some((t) => WITHDRAWAL_TITLE_RE.test(t))) return 'declared_withdrawn';
  if (
    hint.state === 'removed_404' ||
    hint.state === 'removed_410' ||
    hint.httpStatus === 404 ||
    hint.httpStatus === 410
  ) {
    return 'stealth_removed';
  }
  // Still reachable (or unknown): treated as removed from the listing only.
  return 'delisted';
}

export function vanishedDocIds(prev: SnapshotLink[], next: SnapshotLink[]): string[] {
  const keep = new Set(next.map((l) => l.docId));
  return prev.filter((l) => !keep.has(l.docId)).map((l) => l.docId);
}

export function newTitles(prev: SnapshotLink[], next: SnapshotLink[]): string[] {
  const old = new Set(prev.map((l) => l.docId));
  return next.filter((l) => !old.has(l.docId)).map((l) => l.title);
}

/**
 * Diff consecutive snapshots per creator. Returns one desired flag per vanished doc_id
 * (highest severity wins when creators disagree on kind; corroboration raises severity).
 */
export function stealthFlagsFromSnapshots(
  snapshots: IndexSnapshotView[],
  hintFor: (docId: string) => DocObservationHint,
): Map<string, FlagInput> {
  const byIndex = new Map<string, IndexSnapshotView[]>();
  for (const s of snapshots) {
    const list = byIndex.get(s.indexId) ?? [];
    list.push(s);
    byIndex.set(s.indexId, list);
  }

  /** docId → kind → set of creators that reported it */
  const votes = new Map<string, Map<StealthFlagKind, Set<string>>>();
  /** docId → entity keys involved */
  const keys = new Map<string, Set<string>>();

  for (const [, list] of byIndex) {
    const byCreator = new Map<string, IndexSnapshotView[]>();
    for (const s of list) {
      const c = byCreator.get(s.creator) ?? [];
      c.push(s);
      byCreator.set(s.creator, c);
    }
    for (const [creator, snaps] of byCreator) {
      const ordered = [...snaps].sort((a, b) =>
        a.createdBlock === b.createdBlock ? a.key.localeCompare(b.key) : a.createdBlock - b.createdBlock,
      );
      for (let i = 1; i < ordered.length; i += 1) {
        const prev = ordered[i - 1]!;
        const next = ordered[i]!;
        const titles = newTitles(prev.links, next.links);
        for (const docId of vanishedDocIds(prev.links, next.links)) {
          const kind = classifyVanishedDoc(hintFor(docId), titles);
          let kinds = votes.get(docId);
          if (kinds === undefined) {
            kinds = new Map();
            votes.set(docId, kinds);
          }
          let creators = kinds.get(kind);
          if (creators === undefined) {
            creators = new Set();
            kinds.set(kind, creators);
          }
          creators.add(creator);
          let ek = keys.get(docId);
          if (ek === undefined) {
            ek = new Set();
            keys.set(docId, ek);
          }
          ek.add(prev.key);
          ek.add(next.key);
        }
      }
    }
  }

  const out = new Map<string, FlagInput>();
  for (const [docId, kinds] of votes) {
    // Prefer stealth_removed > delisted > declared_withdrawn when multiple kinds appear.
    const order: StealthFlagKind[] = ['stealth_removed', 'delisted', 'declared_withdrawn'];
    let best: StealthFlagKind | null = null;
    let creators = 0;
    for (const k of order) {
      const c = kinds.get(k);
      if (c !== undefined && c.size > 0) {
        best = k;
        creators = c.size;
        break;
      }
    }
    if (best === null) continue;
    const corroborated = creators >= 2;
    const severity =
      best === 'declared_withdrawn' ? 1 : best === 'stealth_removed' ? (corroborated ? 3 : 1) : corroborated ? 2 : 1;
    const wording =
      best === 'stealth_removed'
        ? 'removed from listing without a withdrawal notice'
        : best === 'delisted'
          ? 'still reachable but no longer listed on the index'
          : 'index gained a withdrawal-style notice when this link disappeared';
    out.set(docId, {
      kind: best,
      severity,
      details: {
        notice_badge: wording,
        creators,
        corroborated,
      },
      entityKeys: [...(keys.get(docId) ?? [])].sort(),
    });
  }
  return out;
}
