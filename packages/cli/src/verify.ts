import type { ArkivClient, BundleEntry, EvidenceBundle } from '@chronicle/core';
import { parseAndCheckBundle } from '@chronicle/core';

export type EntryState = 'PASS' | 'FAIL' | 'EXPIRED' | 'DELETED' | 'OWNER_CHANGED';

export interface EntryResult {
  entity_key: string;
  state: EntryState;
  creator: string;
  vantage: string | null;
  detail: string;
}

export interface VerifyReport {
  results: EntryResult[];
  creators: string[];
  /** Spec exit codes: 0 ok, 1 fail/deleted, 2 expired only. */
  exitCode: 0 | 1 | 2;
  disclaimer: string;
}

export const VERIFY_DISCLAIMER =
  'This verifies the bundle against Arkiv records. It shows what watchers recorded and when. It does not prove a document is authentic or why it changed. Not legal advice.';

function vantageOf(attrs: Record<string, string | number>): string | null {
  const v = attrs.vantage;
  return typeof v === 'string' ? v : null;
}

function attrsMatch(expected: Record<string, string | number>, live: Record<string, string | number>): string | null {
  for (const [k, v] of Object.entries(expected)) {
    if (live[k] !== v) return `attribute ${k}: bundle=${JSON.stringify(v)} live=${JSON.stringify(live[k])}`;
  }
  return null;
}

async function creationTxStillPresent(
  arkiv: ArkivClient,
  entry: BundleEntry,
): Promise<{ present: boolean; detail: string }> {
  try {
    const events = await arkiv.createdEvents(BigInt(entry.creation_block), BigInt(entry.creation_block));
    const hit = events.find((e) => e.key === entry.entity_key);
    if (hit === undefined) {
      return { present: false, detail: 'creating EntityCreated log not found in the claimed block' };
    }
    if (entry.tx_hash !== null && hit.txHash !== entry.tx_hash) {
      return {
        present: true,
        detail: `creating log present but tx_hash differs (bundle ${entry.tx_hash}, chain ${hit.txHash})`,
      };
    }
    return { present: true, detail: `creating tx ${hit.txHash} still in block ${entry.creation_block}` };
  } catch (err) {
    return {
      present: false,
      detail: `could not look up creation logs: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkEntry(arkiv: ArkivClient, entry: BundleEntry, head: bigint): Promise<EntryResult> {
  const base = {
    entity_key: entry.entity_key,
    creator: entry.creator,
    vantage: vantageOf(entry.attributes),
  };
  const live = await arkiv.getEntity(entry.entity_key);

  if (live === null) {
    const expired = entry.expiry_block !== null && BigInt(entry.expiry_block) <= head;
    const tx = await creationTxStillPresent(arkiv, entry);
    const state: EntryState = expired ? 'EXPIRED' : 'DELETED';
    return {
      ...base,
      state,
      detail: `${state.toLowerCase()}; ${tx.detail}`,
    };
  }

  const problems: string[] = [];
  if (live.creator !== entry.creator) problems.push(`creator: bundle=${entry.creator} live=${live.creator}`);
  if (Number(live.createdAtBlock) !== entry.creation_block) {
    problems.push(`creation_block: bundle=${entry.creation_block} live=${Number(live.createdAtBlock)}`);
  }
  const liveExpiry = live.expiresAtBlock === null ? null : Number(live.expiresAtBlock);
  if (liveExpiry !== entry.expiry_block) {
    problems.push(`expiry_block: bundle=${String(entry.expiry_block)} live=${String(liveExpiry)}`);
  }
  if (live.payloadSha256 !== entry.payload_sha256) {
    problems.push(`payload_sha256 mismatch`);
  }
  const attrProblem = attrsMatch(entry.attributes, live.attributes);
  if (attrProblem !== null) problems.push(attrProblem);

  if (entry.tx_hash !== null) {
    if (live.txHash !== null) {
      if (live.txHash !== entry.tx_hash) {
        problems.push(`tx_hash: bundle=${entry.tx_hash} live=${live.txHash}`);
      }
    } else {
      const tx = await creationTxStillPresent(arkiv, entry);
      if (!tx.present || tx.detail.includes('differs')) problems.push(tx.detail);
    }
  }

  if (problems.length > 0) {
    return { ...base, state: 'FAIL', detail: problems.join('; ') };
  }

  if (live.owner !== entry.owner) {
    return {
      ...base,
      state: 'OWNER_CHANGED',
      detail: `owner was ${entry.owner}, now ${live.owner}`,
    };
  }

  return { ...base, state: 'PASS', detail: 'matches live entity' };
}

export function exitCodeFor(results: EntryResult[]): 0 | 1 | 2 {
  if (results.some((r) => r.state === 'FAIL' || r.state === 'DELETED')) return 1;
  if (results.some((r) => r.state === 'EXPIRED')) return 2;
  return 0;
}

/**
 * Verifies a parsed evidence bundle against Arkiv. Recomputes `bundle_sha256` first
 * (via `parseAndCheckBundle` when given raw JSON).
 */
export async function verifyBundle(arkiv: ArkivClient, bundle: EvidenceBundle): Promise<VerifyReport> {
  const head = await arkiv.currentBlock();
  const results: EntryResult[] = [];
  for (const entry of bundle.entries) {
    results.push(await checkEntry(arkiv, entry, head));
  }
  const creators = [...new Set(results.map((r) => r.creator))].sort();
  return {
    results,
    creators,
    exitCode: exitCodeFor(results),
    disclaimer: VERIFY_DISCLAIMER,
  };
}

export async function verifyBundleJson(arkiv: ArkivClient, raw: unknown): Promise<VerifyReport> {
  const bundle = parseAndCheckBundle(raw);
  return verifyBundle(arkiv, bundle);
}

export function formatVerifyTable(report: VerifyReport): string {
  const rows = [
    ['entity', 'state', 'creator', 'vantage', 'detail'],
    ...report.results.map((r) => [
      r.entity_key.slice(0, 10) + '…',
      r.state,
      r.creator.slice(0, 8) + '…',
      r.vantage ?? '—',
      r.detail,
    ]),
  ];
  const widths = rows[0]!.map((_, i) => Math.min(60, Math.max(...rows.map((r) => (r[i] ?? '').length))));
  const line = (r: string[]): string => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  const out = [line(rows[0]!), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.slice(1).map(line)];
  out.push('');
  out.push(`Distinct creators (${report.creators.length}): ${report.creators.join(', ') || '(none)'}`);
  out.push('');
  out.push(report.disclaimer);
  return out.join('\n');
}
