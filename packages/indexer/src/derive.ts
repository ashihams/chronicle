import { REMOVAL_STATES, type ObservationState } from '@chronicle/core';
import type { EntityStatus, FlagInput, VersionRow } from './db.js';
import type { ObservationAttrs } from './schema.js';

export const CURRENT_WINDOW_SECONDS = 24 * 3600;
/** Flag kinds owned by derivation; recomputation opens, updates and resolves only these. */
export const DERIVED_FLAG_KINDS = ['vantage_disagreement', 'backdated', 'clock_skew', 'reverted'] as const;

const CONTENT_STATES: ReadonlySet<ObservationState> = new Set(['first_seen', 'present', 'changed']);
const ACCEPTED_STATUSES: ReadonlySet<EntityStatus> = new Set(['live', 'expired']);

export interface ObsInput {
  key: string;
  creator: string;
  createdBlock: number;
  /** Chain time of the creation block (unix seconds). */
  createdTs: number;
  status: EntityStatus;
  attrs: ObservationAttrs;
  summaryEn: string | null;
}

export interface DeriveParams {
  /** Chain time "now" (unix seconds). */
  nowTs: number;
  disagreeWindowSeconds: number;
  backdateSeconds: number;
  clockSkewSeconds: number;
}

export interface DocStatus {
  currentState: ObservationState | null;
  currentSeq: number | null;
  lastSeenTs: number | null;
  lastChangeTs: number | null;
}

export interface Derived {
  versions: Omit<VersionRow, 'docId'>[];
  flags: FlagInput[];
  status: DocStatus;
}

/** Chain order: creation block, then entity key. */
export function chainOrder(a: ObsInput, b: ObsInput): number {
  if (a.createdBlock !== b.createdBlock) return a.createdBlock - b.createdBlock;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function isAccepted(o: ObsInput): boolean {
  return ACCEPTED_STATUSES.has(o.status) && CONTENT_STATES.has(o.attrs.state) && o.attrs.norm_sha256 !== undefined;
}

/** Latest observation per creator, in chain order, among the given ones. */
export function latestPerCreator(obs: ObsInput[]): ObsInput[] {
  const latest = new Map<string, ObsInput>();
  for (const o of [...obs].sort(chainOrder)) latest.set(o.creator, o);
  return [...latest.values()].sort(chainOrder);
}

/**
 * Step 1: the version chain of one normalizer version. Hashes are ordered by their earliest
 * observation in chain order. The current version is the hash most creators saw in their latest
 * observation within the last 24 hours (ties go to the later version); when no creator has a recent
 * content observation, it is the hash of the latest accepted observation.
 */
export function versionChain(obs: ObsInput[], nowTs: number): Omit<VersionRow, 'docId'>[] {
  const accepted = obs.filter(isAccepted).sort(chainOrder);
  if (accepted.length === 0) return [];
  const normalizerVersion = accepted[0]?.attrs.normalizer_version ?? '';

  const byHash = new Map<string, ObsInput[]>();
  for (const o of accepted) {
    const h = o.attrs.norm_sha256 as string;
    const list = byHash.get(h) ?? [];
    list.push(o);
    byHash.set(h, list);
  }
  const ordered = [...byHash.entries()].sort(([, a], [, b]) => chainOrder(a[0] as ObsInput, b[0] as ObsInput));

  const votes = new Map<string, number>();
  const recent = obs.filter((o) => ACCEPTED_STATUSES.has(o.status) && nowTs - o.createdTs <= CURRENT_WINDOW_SECONDS);
  for (const o of latestPerCreator(recent)) {
    if (isAccepted(o)) votes.set(o.attrs.norm_sha256 as string, (votes.get(o.attrs.norm_sha256 as string) ?? 0) + 1);
  }
  let current = accepted[accepted.length - 1]?.attrs.norm_sha256 as string;
  let best = 0;
  ordered.forEach(([hash]) => {
    const v = votes.get(hash) ?? 0;
    if (v > 0 && v >= best) {
      best = v;
      current = hash;
    }
  });

  return ordered.map(([hash, list], i) => {
    const first = list[0] as ObsInput;
    return {
      normalizerVersion,
      seq: i + 1,
      normSha256: hash,
      firstSeenBlock: first.createdBlock,
      firstSeenTs: first.createdTs,
      firstEntityKey: first.key,
      observerCount: new Set(list.map((o) => o.creator)).size,
      status: hash === current ? 'current' : 'superseded',
      deadlineTs: first.attrs.deadline_ts ?? null,
      amountPaise: first.attrs.amount_paise ?? null,
      summaryEn: first.summaryEn,
    };
  });
}

function conflict(a: ObsInput, b: ObsInput): boolean {
  const ca = CONTENT_STATES.has(a.attrs.state);
  const cb = CONTENT_STATES.has(b.attrs.state);
  if (ca && cb) {
    return a.attrs.normalizer_version === b.attrs.normalizer_version && a.attrs.norm_sha256 !== b.attrs.norm_sha256;
  }
  return (ca && REMOVAL_STATES.has(b.attrs.state)) || (cb && REMOVAL_STATES.has(a.attrs.state));
}

/** Step 2: latest observations of two creators close in chain time that disagree. */
export function vantageDisagreement(obs: ObsInput[], windowSeconds: number): FlagInput | null {
  const latest = latestPerCreator(obs.filter((o) => ACCEPTED_STATUSES.has(o.status)));
  const involved = new Set<ObsInput>();
  for (let i = 0; i < latest.length; i++) {
    for (let j = i + 1; j < latest.length; j++) {
      const a = latest[i] as ObsInput;
      const b = latest[j] as ObsInput;
      if (Math.abs(a.createdTs - b.createdTs) <= windowSeconds && conflict(a, b)) {
        involved.add(a);
        involved.add(b);
      }
    }
  }
  if (involved.size === 0) return null;
  const list = [...involved].sort(chainOrder);
  return {
    kind: 'vantage_disagreement',
    severity: 2,
    details: {
      observers: list.map((o) => ({
        creator: o.creator,
        vantage: o.attrs.vantage,
        state: o.attrs.state,
        norm_sha256: o.attrs.norm_sha256 ?? null,
        created_ts: o.createdTs,
        key: o.key,
      })),
    },
    entityKeys: list.map((o) => o.key).sort(),
  };
}

function minDefined(values: (number | undefined)[]): number | null {
  const defined = values.filter((v): v is number => v !== undefined);
  return defined.length === 0 ? null : Math.min(...defined);
}

/**
 * Step 3: a later version (seq > 1) whose printed date or Last-Modified claims a time more than
 * `backdateSeconds` before the version was first seen. The printed date only counts when it differs
 * from the previous version's, so an amendment that keeps the original date is not flagged.
 */
export function backdating(
  versions: Omit<VersionRow, 'docId'>[],
  obs: ObsInput[],
  backdateSeconds: number,
): FlagInput[] {
  const flags: FlagInput[] = [];
  const accepted = obs.filter(isAccepted);
  const ofHash = (h: string): ObsInput[] => accepted.filter((o) => o.attrs.norm_sha256 === h);
  for (const v of versions) {
    if (v.seq <= 1) continue;
    const mine = ofHash(v.normSha256);
    const prev = versions.find((p) => p.seq === v.seq - 1);
    const printed = minDefined(mine.map((o) => o.attrs.printed_date_ts));
    const prevPrinted =
      prev === undefined ? null : minDefined(ofHash(prev.normSha256).map((o) => o.attrs.printed_date_ts));
    const lastModified = minDefined(mine.map((o) => o.attrs.last_modified_ts));
    const reasons: { field: string; claimed_ts: number }[] = [];
    if (printed !== null && printed !== prevPrinted && v.firstSeenTs - printed > backdateSeconds) {
      reasons.push({ field: 'printed_date_ts', claimed_ts: printed });
    }
    if (lastModified !== null && v.firstSeenTs - lastModified > backdateSeconds) {
      reasons.push({ field: 'last_modified_ts', claimed_ts: lastModified });
    }
    if (reasons.length === 0) continue;
    flags.push({
      kind: 'backdated',
      severity: 2,
      details: { seq: v.seq, first_seen_ts: v.firstSeenTs, previous_printed_ts: prevPrinted, reasons },
      entityKeys: [v.firstEntityKey],
    });
  }
  return flags;
}

/** Step 4: the watcher's `observed_at` far from the chain time of its block. */
export function clockSkew(obs: ObsInput[], skewSeconds: number): FlagInput[] {
  return obs
    .filter((o) => Math.abs(o.attrs.observed_at - o.createdTs) > skewSeconds)
    .sort(chainOrder)
    .map((o) => ({
      kind: 'clock_skew',
      severity: 1,
      details: {
        observed_at: o.attrs.observed_at,
        chain_ts: o.createdTs,
        delta_seconds: o.attrs.observed_at - o.createdTs,
      },
      entityKeys: [o.key],
    }));
}

/** Step 5: the current version is older than the newest one. */
export function reverted(versions: Omit<VersionRow, 'docId'>[]): FlagInput | null {
  const current = versions.find((v) => v.status === 'current');
  const maxSeq = Math.max(0, ...versions.map((v) => v.seq));
  if (current === undefined || current.seq >= maxSeq) return null;
  return {
    kind: 'reverted',
    severity: 1,
    details: { current_seq: current.seq, max_seq: maxSeq },
    entityKeys: [current.firstEntityKey],
  };
}

export function docStatus(obs: ObsInput[], versions: Omit<VersionRow, 'docId'>[]): DocStatus {
  const live = obs.filter((o) => ACCEPTED_STATUSES.has(o.status)).sort(chainOrder);
  const latest = live[live.length - 1];
  const changes = live.filter((o) => o.attrs.state === 'changed' || REMOVAL_STATES.has(o.attrs.state));
  return {
    currentState: latest?.attrs.state ?? null,
    currentSeq: versions.find((v) => v.status === 'current')?.seq ?? null,
    lastSeenTs: latest?.createdTs ?? null,
    lastChangeTs: changes.length === 0 ? null : Math.max(...changes.map((o) => o.createdTs)),
  };
}

/**
 * Everything derived for one doc. Versions are computed per normalizer version; flags and status
 * use the normalizer version of the latest accepted observation.
 */
export function deriveDoc(obs: ObsInput[], p: DeriveParams): Derived {
  const groups = new Map<string, ObsInput[]>();
  for (const o of obs) {
    const list = groups.get(o.attrs.normalizer_version) ?? [];
    list.push(o);
    groups.set(o.attrs.normalizer_version, list);
  }
  const versions = [...groups.keys()].sort().flatMap((nv) => versionChain(groups.get(nv) ?? [], p.nowTs));

  const accepted = obs.filter(isAccepted).sort(chainOrder);
  const primary = accepted[accepted.length - 1]?.attrs.normalizer_version;
  const primaryVersions = versions.filter((v) => v.normalizerVersion === primary);
  const primaryObs = obs.filter((o) => o.attrs.normalizer_version === primary);

  const flags: FlagInput[] = [];
  const disagreement = vantageDisagreement(obs, p.disagreeWindowSeconds);
  if (disagreement !== null) flags.push(disagreement);
  flags.push(...backdating(primaryVersions, primaryObs, p.backdateSeconds));
  flags.push(...clockSkew(obs, p.clockSkewSeconds));
  const rev = reverted(primaryVersions);
  if (rev !== null) flags.push(rev);

  return { versions, flags, status: docStatus(obs, primaryVersions) };
}
