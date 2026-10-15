/**
 * Stage 1 probe: measures what Arkiv (Tiramisu testnet, SDK 0.8.x) can and cannot do.
 * Writes arkiv/probe-results.json and refreshes the probe section of arkiv/friction.md.
 *
 * Run: pnpm probe   (needs WATCHER_PRIVATE_KEY; PROBE_SECOND_PRIVATE_KEY enables the other-wallet tests)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadConfig } from '../packages/core/src/config.js';
import { LiveArkivClient } from '../packages/core/src/arkiv/live.js';
import {
  addr,
  ARKIV_PROCESSOR_ADDRESS,
  bool,
  createPublicClient,
  dec,
  ENTITY_EVENTS_ABI,
  eq,
  ExpirationTime,
  gt,
  gte,
  i32,
  jsonToPayload,
  key,
  lt,
  lte,
  and,
  startsWith,
  str,
  tiramisu,
  u64,
  webSocket,
} from '../packages/core/src/arkiv/sdk.js';
import type { AttributeInputs, Expression } from '../packages/core/src/arkiv/sdk.js';

type Details = Record<string, unknown>;
interface Result {
  ok: boolean;
  title: string;
  details: Details;
  error?: string;
  ms: number;
}
interface Friction {
  experiment?: string;
  title: string;
  tried: string;
  expected: string;
  actual: string;
  impact: string;
  fix: string;
}

const require = createRequire(import.meta.url);
const SDK_VERSION = (
  JSON.parse(
    readFileSync(require.resolve('@arkiv-network/sdk/package.json', { paths: ['packages/core'] }), 'utf8'),
  ) as { version: string }
).version;

const secondKey = process.env.PROBE_SECOND_PRIVATE_KEY?.trim() || undefined;
if (secondKey !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(secondKey)) {
  throw new Error('PROBE_SECOND_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key');
}
const env = { PROBE_SECOND_PRIVATE_KEY: secondKey };
const config = loadConfig(process.env, { require: ['WATCHER_PRIVATE_KEY'] });
const liveOpts = { chainId: config.arkiv.chainId, rpcHttp: config.arkiv.rpcHttp, rpcWs: config.arkiv.rpcWs };
const A = new LiveArkivClient({ ...liveOpts, privateKey: config.watcher.privateKey as string });
const B = env.PROBE_SECOND_PRIVATE_KEY
  ? new LiveArkivClient({ ...liveOpts, privateKey: env.PROBE_SECOND_PRIVATE_KEY })
  : null;
const pub = A.raw.publicClient;
const walletA = A.raw.walletClient!;
const walletB = B?.raw.walletClient;
const addrA = A.address()!;
const addrB = B?.address() ?? null;

const runId = `p${Date.now().toString(36)}`;
const today = new Date().toISOString().slice(0, 10);
const results: Record<string, Result> = {};
const friction: Friction[] = [];
let canWrite = true;
let canWriteB = false;
let currentId = '';
/** `--only=e05_query,e06_created_after_block` re-runs a subset and merges into the previous results. */
const only = process.argv
  .find((a) => a.startsWith('--only='))
  ?.slice('--only='.length)
  .split(/[,\s]+/)
  .filter(Boolean);

const log = (msg: string) => process.stdout.write(`${msg}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errText(e: unknown): string {
  const x = e as { name?: string; shortMessage?: string; message?: string };
  return `${x.name ?? 'Error'}: ${x.shortMessage ?? x.message ?? String(e)}`.replace(/\s+/g, ' ').slice(0, 600);
}

async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

function note(f: Friction) {
  friction.push({ experiment: currentId, ...f });
}

async function experiment(id: string, title: string, fn: (d: Details) => Promise<void>, needsWrite = true) {
  if (only && id !== 'e01_connectivity' && !only.some((o) => id.startsWith(o))) return;
  currentId = id;
  const started = Date.now();
  const details: Details = {};
  log(`\n== ${id}: ${title}`);
  if (needsWrite && !canWrite) {
    results[id] = { ok: false, title, details, error: 'skipped: wallet A has no balance', ms: 0 };
    log('   skipped (no balance)');
    return;
  }
  try {
    await fn(details);
    results[id] = { ok: true, title, details, ms: Date.now() - started };
    log(`   ok (${Date.now() - started} ms)`);
  } catch (e) {
    const error = errText(e);
    results[id] = { ok: false, title, details, error, ms: Date.now() - started };
    log(`   FAILED: ${error}`);
    note({
      title: `Probe ${id} (${title}) failed`,
      tried: `scripts/arkiv-probe.ts experiment ${id}`,
      expected: 'The experiment completes',
      actual: error,
      impact: 'Recorded in probe-results.json; see details there',
      fix: 'Investigate; docs should describe this behavior',
    });
  }
}

const common = { type: 'probe', probe_run: runId };

async function mk(
  attrs: AttributeInputs,
  opts: { payload?: Uint8Array; expires?: ReturnType<typeof ExpirationTime.atBlock> } = {},
) {
  const t0 = Date.now();
  const r = await walletA.createEntity({
    attributes: { ...common, ...attrs },
    payload: opts.payload ?? jsonToPayload({ probe: runId }),
    contentType: opts.payload ? 'text/plain' : 'application/json',
    expires: opts.expires ?? ExpirationTime.fromDays(1),
  });
  return { ...r, ms: Date.now() - t0 };
}

async function gasOf(txHash: `0x${string}`) {
  const r = await pub.getTransactionReceipt({ hash: txHash });
  return {
    gasUsed: r.gasUsed,
    effectiveGasPrice: r.effectiveGasPrice,
    feeWei: r.gasUsed * r.effectiveGasPrice,
    block: r.blockNumber,
  };
}

async function count(expr: Expression | string, atBlock?: bigint): Promise<number> {
  const r = await pub.query(expr, { limit: 200, ...(atBlock !== undefined && { atBlock }) });
  return r.entities.length;
}

async function waitForBlock(target: bigint, timeoutMs = 120_000) {
  const t0 = Date.now();
  while ((await pub.getBlockNumber()) < target) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for block ${target}`);
    await sleep(1000);
  }
}

const runQ = (extra: Expression) => and(eq('type', 'probe'), eq('probe_run', runId), extra);

async function main() {
  log(`Arkiv probe ${runId}  sdk=${SDK_VERSION}  rpc=${config.arkiv.rpcHttp}`);
  log(`wallet A ${addrA}${addrB ? `  wallet B ${addrB}` : '  (no wallet B)'}`);
  let balanceBefore = 0n;

  // 1. Connectivity
  await experiment(
    'e01_connectivity',
    'chain id, balances, current block',
    async (d) => {
      const chainId = await pub.getChainId();
      d.chainId = chainId;
      d.chainIdMatches = chainId === config.arkiv.chainId;
      balanceBefore = await A.balance();
      d.balanceA = balanceBefore;
      d.balanceB = B ? await B.balance() : null;
      d.currentBlock = await pub.getBlockNumber();
      d.blockTiming = await pub.getBlockTiming();
      d.entityCount = await pub.getEntityCount();
      canWrite = balanceBefore > 0n;
      canWriteB = typeof d.balanceB === 'bigint' && d.balanceB > 0n;
      if (!d.chainIdMatches) throw new Error(`chain id ${chainId} != ${config.arkiv.chainId}`);
      if (!canWrite) {
        note({
          title: 'Wallet A has no testnet balance',
          tried: `getBalance(${addrA})`,
          expected: 'A funded wallet',
          actual: '0 wei',
          impact: 'Every write experiment was skipped',
          fix: 'Fund the wallet from the Tiramisu faucet and re-run pnpm probe',
        });
      }
    },
    false,
  );

  // 2. Create with string attributes, read back
  let basic: { entityKey: `0x${string}`; txHash: `0x${string}` } | null = null;
  await experiment('e02_create_read', 'create with string attributes and read back', async (d) => {
    const r = await mk({ label: 'basic', note: 'hello' });
    basic = r;
    d.createMs = r.ms;
    d.entityKey = r.entityKey;
    d.txHash = r.txHash;
    d.expiresAtReturned = r.expiresAt;
    d.gas = await gasOf(r.txHash);
    const raw = await pub.getEntity(r.entityKey);
    d.rawFieldsPresent = Object.entries(raw)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    d.raw = {
      owner: raw.owner,
      creator: raw.creator,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      expiresAt: raw.expiresAt,
      contentType: raw.contentType,
      creationFlags: raw.creationFlags,
      attributes: raw.attributes,
    };
    d.txHashOnEntity = 'txHash' in raw;
    const rec = await A.getEntity(r.entityKey);
    d.wrapperRecord = rec && { ...rec, payloadBytes: rec.payloadBytes?.length };
    d.txHashViaLogsMatches = rec?.txHash === r.txHash.toLowerCase();
  });

  // 3. Attribute types and limits
  await experiment('e03_attribute_types', 'attribute types, long strings, attribute count', async (d) => {
    const mixed = await attempt(() =>
      mk({
        s: 'text',
        n_i32: i32(42),
        n_u64_large: u64(2n ** 40n),
        n_dec: dec('3.5'),
        flag: bool(true),
        empty_str: str(''),
      }),
    );
    d.mixedTypes = mixed.ok ? { ok: true, entityKey: mixed.value.entityKey } : mixed;
    if (mixed.ok) d.mixedReadBack = (await pub.getEntity(mixed.value.entityKey)).attributes;
    d.bareFloat = await attempt(() => mk({ f: 1.5 }));
    d.bareLargeNumber = await attempt(() => mk({ big: 2 ** 40 }));
    d.bareBoolean = await attempt(async () => (await mk({ flag_bare: true })).entityKey);
    for (const len of [128, 129, 256, 1024]) {
      const r = await attempt(async () => (await mk({ long: 'x'.repeat(len) })).entityKey);
      d[`string_${len}`] = r.ok ? { ok: true } : r;
    }
    for (const n of [10, 20, 30, 31, 40, 80]) {
      const attrs: Record<string, number> = {};
      for (let i = 0; i < n - 2; i++) attrs[`a${i}`] = i;
      const r = await attempt(async () => (await mk(attrs)).entityKey);
      d[`attributes_${n}`] = r.ok ? { ok: true } : r;
    }
    d.reservedName = await attempt(() => mk({ key: 'x' }));
    d.nameWithDollar = await attempt(() => mk({ $x: 'x' }));
  });

  // 4. Payload sizes
  await experiment('e04_payload_size', 'payload size limits', async (d) => {
    let maxOk = 0;
    for (const kb of [1, 4, 16, 64, 120, 129]) {
      const payload = new Uint8Array(kb * 1024).fill(0x61);
      const r = await attempt(() => mk({ label: `payload-${kb}k` }, { payload }));
      if (r.ok) {
        maxOk = kb;
        d[`kb_${kb}`] = { ok: true, ms: r.value.ms, gas: await gasOf(r.value.txHash) };
      } else d[`kb_${kb}`] = r;
    }
    d.maxAcceptedKb = maxOk;
  });

  // 5. Query semantics
  await experiment('e05_query', 'eq, prefix, ranges, AND, $creator/$owner/$key, ordering, pagination', async (d) => {
    const creates = [1, 2, 3, 4, 5].map((n) => ({
      attributes: { ...common, label: 'q', qn: u64(n), qtag: `${n % 2 ? 'odd' : 'even'}-${n}` },
      payload: jsonToPayload({ n }),
      contentType: 'application/json' as const,
      expires: ExpirationTime.fromDays(1),
    }));
    const batch = await walletA.executeBatch({ creates });
    d.batchTx = batch.txHash;
    const keys = batch.createdEntities;
    const Q = (e: Expression) => runQ(and(eq('label', 'q'), e));
    d.eq_string = await count(Q(eq('qtag', 'odd-3')));
    d.prefix_odd = await count(Q(startsWith('qtag', 'odd-')));
    d.gt_3 = await count(Q(gt('qn', u64(3))));
    d.gte_3 = await count(Q(gte('qn', u64(3))));
    d.lt_2 = await count(Q(lt('qn', u64(2))));
    d.lte_2 = await count(Q(lte('qn', u64(2))));
    d.and_prefix_gte = await count(Q(and(startsWith('qtag', 'odd-'), gte('qn', u64(3)))));
    d.bare_number_eq_on_u64 = await count(Q(eq('qn', 2)));
    d.creator_filter = await count(Q(eq('$creator', addr(addrA))));
    d.owner_filter = await count(Q(eq('$owner', addr(addrA))));
    d.creator_filter_other = await count(Q(eq('$creator', addr('0x' + '1'.repeat(40)))));
    d.key_filter = keys[0] ? await count(eq('$key', key(keys[0]))) : null;
    d.string_range_raw = await attempt(() =>
      count(`type = str('probe') AND probe_run = str('${runId}') AND qtag > str('a')`),
    );
    d.glob_raw = await attempt(() => count(`probe_run = str('${runId}') AND qtag GLOB str('odd-*')`));
    d.tilde_raw = await attempt(() => count(`probe_run = str('${runId}') AND qtag ~ str('odd-*')`));
    const all = await pub.query(Q(gte('qn', u64(0))), { limit: 200 });
    d.resultOrder = all.entities.map((e) => e.attributes?.qn?.value?.toString());
    d.creationOrder = ['1', '2', '3', '4', '5'];
    const pages: number[] = [];
    let cursor: string | undefined;
    do {
      const p = await pub.query(Q(gte('qn', u64(0))), { limit: 2, ...(cursor !== undefined && { cursor }) });
      pages.push(p.entities.length);
      cursor = p.cursor;
      if (pages.length === 1) d.cursorSample = cursor?.slice(0, 24);
    } while (cursor !== undefined && pages.length < 10);
    d.pageSizes = pages;
    d.orderBySupported = false;
    if (d.bare_number_eq_on_u64 === 0) {
      note({
        title: 'A bare JS number in a query silently matches nothing against u64 attributes',
        tried: "client.query(eq('qn', 2)) where qn was written as u64(2)",
        expected: 'Numeric equality matches the stored number',
        actual: '0 results, no error. A bare number is an i32 literal, and a type mismatch matches nothing',
        impact: 'Easy to miss in application code; Chronicle always wraps numbers in u64() in the ArkivClient wrapper',
        fix: 'Warn or error in the SDK when a predicate type cannot match the attribute type; document prominently',
      });
    }
  });

  // 6. "Created after block N"
  let syncStrategy: 'block' | 'observed_at_window' = 'observed_at_window';
  await experiment('e06_created_after_block', 'query by creation block; event logs as a sync source', async (d) => {
    const marker = await mk({ label: 'created-after' });
    const createdAt = (await pub.getEntity(marker.entityKey)).createdAt ?? 0n;
    d.markerCreatedAt = createdAt;
    d.createdAtQuerySdk = await attempt(async () => count(gt('$createdAt', u64(createdAt - 1n))));
    const scoped = `type = str('probe') AND probe_run = str('${runId}') AND label = str('created-after')`;
    d.createdAtRaw_gte_own_block = await attempt(() => count(`${scoped} AND $createdAt >= u64(${createdAt})`));
    d.createdAtRaw_gt_own_block = await attempt(() => count(`${scoped} AND $createdAt > u64(${createdAt})`));
    d.createdAtRaw_lt_own_block = await attempt(() => count(`${scoped} AND $createdAt < u64(${createdAt})`));
    const rawWorks =
      (d.createdAtRaw_gte_own_block as { ok: boolean; value?: number }).value === 1 &&
      (d.createdAtRaw_gt_own_block as { ok: boolean; value?: number }).value === 0 &&
      (d.createdAtRaw_lt_own_block as { ok: boolean; value?: number }).value === 0;
    d.createdAtRawFilterCorrect = rawWorks;
    if (rawWorks) {
      note({
        title: 'The node filters on $createdAt, but the SDK refuses to build that predicate',
        tried: `gt('$createdAt', u64(N)) via @arkiv-network/sdk/query, then the raw string "... AND $createdAt >= u64(N)" via client.query(string)`,
        expected: 'Either both work or both fail (the SDK says $createdAt "carries no index")',
        actual:
          'The SDK throws InvalidPredicateError; the raw string query returns correct results (>= own block: 1, > own block: 0, < own block: 0)',
        impact: 'Incremental sync by creation block needs an unchecked raw query string, or event logs',
        fix: 'Allow $createdAt in QUERYABLE_SYSTEM_ATTRIBUTES, or document that the node supports it',
      });
    }

    const head = await pub.getBlockNumber();
    const logs = await A.createdEvents(head - 200n, head);
    d.logsLast200Blocks = logs.length;
    d.logsIncludeMarker = logs.some(
      (l) => l.key === marker.entityKey.toLowerCase() && l.txHash === marker.txHash.toLowerCase(),
    );
    let maxRange = 0n;
    for (const range of [1_000n, 2_000n, 5_000n, 10_000n, 50_000n]) {
      const r = await attempt(async () => (await A.createdEvents(head - range, head)).length);
      d[`logsRange_${range}`] = r;
      if (r.ok) maxRange = range;
    }
    d.maxLogRangeBlocks = maxRange;
    if (maxRange < 50_000n) {
      note({
        title: 'eth_getLogs rejects wide block ranges with a generic error',
        tried: `publicClient.getLogs({ address: ${ARKIV_PROCESSOR_ADDRESS}, event: EntityCreated, fromBlock: head-50000, toBlock: head })`,
        expected: 'Either results or an error naming the maximum range',
        actual: `InvalidParamsRpcError "Invalid parameters were provided to the RPC method". Largest range that worked: ${maxRange} blocks`,
        impact: 'Indexer must page event logs in windows of at most the working range',
        fix: 'Document the eth_getLogs range limit and return it in the error message',
      });
    }
    if (logs.length > 0 && maxRange > 0n) syncStrategy = 'block';
    d.syncStrategy = syncStrategy;
    d.reason =
      syncStrategy === 'block'
        ? `EntityCreated logs list every entity created in a block range (with tx hash); page in windows of <= ${maxRange} blocks`
        : 'event logs unavailable; fall back to observed_at windows';
  });

  // 7. Expiry
  await experiment('e07_expiry', 'min/max expiresIn, behavior after expiry, extend', async (d) => {
    d.minLifetimeOneBlock = await attempt(async () => {
      const r = await mk({ label: 'exp-1block' }, { expires: ExpirationTime.fromBlocks(1) });
      const after = await attempt(() => pub.getEntity(r.entityKey));
      return { entityKey: r.entityKey, expiresAt: r.expiresAt, readableRightAfter: after.ok };
    });
    const one = d.minLifetimeOneBlock as { ok: boolean; value?: { readableRightAfter: boolean } };
    if (one.ok && one.value?.readableRightAfter === false) {
      note({
        title: 'A one-block lifetime is accepted but the entity is never readable',
        tried: 'createEntity({ ..., expires: ExpirationTime.fromBlocks(1) }) then getEntity(key)',
        expected: 'Either rejected as dead on arrival, or readable for one block',
        actual: 'The create succeeds (gas is spent), but getEntity right after the receipt throws NoEntityFoundError',
        impact: 'None for Chronicle (we use 180 days); a trap for short-lived data',
        fix: 'Reject lifetimes that cannot outlive the inclusion block, or document the minimum useful lifetime',
      });
    }
    d.oddSeconds = await attempt(async () => ExpirationTime.fromSeconds(3));
    const short = await mk({ label: 'exp-short' }, { expires: ExpirationTime.fromSeconds(12) });
    const created = await pub.getEntity(short.entityKey);
    d.short = {
      entityKey: short.entityKey,
      createdAt: created.createdAt,
      expiresAt: created.expiresAt,
      txHash: short.txHash,
    };
    await waitForBlock((created.expiresAt ?? 0n) + 1n);
    d.afterExpiry_getEntity = await attempt(async () => (await pub.getEntity(short.entityKey)).key);
    d.afterExpiry_query = await count(runQ(eq('label', 'exp-short')));
    d.afterExpiry_queryAtBlockBefore = await attempt(() =>
      count(runQ(eq('label', 'exp-short')), (created.expiresAt ?? 1n) - 1n),
    );

    const ext = await mk({ label: 'exp-extend' }, { expires: ExpirationTime.fromMinutes(5) });
    const extended = await walletA.extendEntity({ entityKey: ext.entityKey, expires: ExpirationTime.fromMinutes(30) });
    const readBack = await pub.getEntity(ext.entityKey);
    d.extend = {
      before: ext.expiresAt,
      returned: extended.expiresAt,
      readBack: readBack.expiresAt,
      deltaBlocks: (readBack.expiresAt ?? 0n) - ext.expiresAt,
    };
    d.extendShorter = await attempt(() =>
      walletA.extendEntity({ entityKey: ext.entityKey, expires: ExpirationTime.fromMinutes(1) }),
    );
    const viaWrapper = await attempt(() => A.extendEntity(ext.entityKey, 3600));
    d.extendViaWrapper = viaWrapper.ok ? { ok: true, expiresAtBlock: viaWrapper.value.expiresAtBlock } : viaWrapper;

    const longLived = await attempt(async () => {
      const r = await mk({ label: 'exp-10y' }, { expires: ExpirationTime.fromYears(10) });
      await walletA.deleteEntity({ entityKey: r.entityKey });
      return { expiresAt: r.expiresAt, deletedAfter: true };
    });
    d.tenYears = longLived;
    const permanent = await attempt(async () => {
      const r = await mk({ label: 'exp-permanent' }, { expires: ExpirationTime.permanent() });
      await walletA.deleteEntity({ entityKey: r.entityKey });
      return { expiresAt: r.expiresAt, deletedAfter: true };
    });
    d.permanent = permanent;
  });

  // 8. Mutation permissions
  await experiment('e08_permissions', 'owner update/delete vs. other wallet', async (d) => {
    const x = await mk({ label: 'perm', state: 'v1' });
    const ownerPatch = await attempt(() => A.patchAttributes(x.entityKey, { state: 'v2' }));
    d.ownerPatch = ownerPatch.ok ? { ok: true } : ownerPatch;
    const afterPatch = await pub.getEntity(x.entityKey);
    d.afterOwnerPatch = {
      state: afterPatch.attributes?.state,
      createdAt: afterPatch.createdAt,
      updatedAt: afterPatch.updatedAt,
    };
    if (B && walletB) {
      d.walletBFunded = canWriteB;
      d.otherPatch = await attempt(() => B.patchAttributes(x.entityKey, { state: 'hijack' }));
      d.otherExtend = await attempt(() => B.extendEntity(x.entityKey, 86400 * 2));
      d.otherDelete = await attempt(() => B.deleteEntity(x.entityKey));
      d.otherTransfer = await attempt(() => B.transferOwnership(x.entityKey, addrB!));
      const still = await pub.getEntity(x.entityKey);
      d.unchangedAfterOtherAttempts = still.attributes?.state?.value === 'v2';
      const otherErr = (d.otherPatch as { error?: string }).error ?? '';
      if (!canWriteB && /without revert data/.test(otherErr)) {
        note({
          title: 'Non-owner mutation from an unfunded wallet fails without a reason',
          tried:
            'patchEntity / extendEntity / deleteEntity / changeOwnership from a wallet with 0 balance on an entity it does not own',
          expected: 'A NotOwner(entityKey, caller, owner) error, as the SDK reports for funded callers',
          actual: `EntityMutationError: "${otherErr}"`,
          impact: 'Cannot tell "not the owner" apart from "no gas" when testing permissions',
          fix: 'Decode the revert during simulation regardless of balance, or say that the caller has no funds',
        });
      }
      const transfer = await attempt(() => A.transferOwnership(x.entityKey, addrB!));
      d.ownerTransferToB = transfer.ok ? { ok: true } : transfer;
      const moved = await pub.getEntity(x.entityKey);
      d.afterTransfer = { owner: moved.owner, creator: moved.creator };
      d.formerOwnerPatch = await attempt(() => A.patchAttributes(x.entityKey, { state: 'v3' }));
      if (canWriteB) {
        const newOwnerPatch = await attempt(() => B.patchAttributes(x.entityKey, { state: 'v3-by-b' }));
        d.newOwnerPatch = newOwnerPatch.ok ? { ok: true } : newOwnerPatch;
        const finalState = await pub.getEntity(x.entityKey);
        d.afterNewOwnerPatch = {
          state: finalState.attributes?.state,
          creator: finalState.creator,
          owner: finalState.owner,
        };
      }
    } else {
      d.walletB = 'not configured (set PROBE_SECOND_PRIVATE_KEY)';
    }
  });

  // 9 + 10. Delete behavior and calldata recovery
  let deleted: { key: `0x${string}`; createTx: `0x${string}`; payloadHex: string } | null = null;
  await experiment('e09_delete', 'getEntity/query after delete; historical query', async (d) => {
    const payload = jsonToPayload({ probe: runId, marker: 'delete-me-payload' });
    const y = await mk({ label: 'del' }, { payload });
    const created = await pub.getEntity(y.entityKey);
    const del = await walletA.deleteEntity({ entityKey: y.entityKey });
    const delGas = await gasOf(del.txHash);
    d.createdAt = created.createdAt;
    d.deletedInBlock = delGas.block;
    d.getEntityAfterDelete = await attempt(async () => (await pub.getEntity(y.entityKey)).key);
    d.queryAfterDelete = await count(runQ(eq('label', 'del')));
    d.queryAtBlockBeforeDelete = await attempt(() => count(runQ(eq('label', 'del')), delGas.block - 1n));
    d.wrapperGetEntity = await A.getEntity(y.entityKey);
    deleted = { key: y.entityKey, createTx: y.txHash, payloadHex: Buffer.from(payload).toString('hex') };
  });

  await experiment('e10_calldata_recovery', 'original payload recoverable from the creating transaction', async (d) => {
    if (!deleted) throw new Error('e09 did not produce a deleted entity');
    const tx = await pub.getTransaction({ hash: deleted.createTx });
    d.txTo = tx.to;
    d.txFrom = tx.from;
    d.inputBytes = (tx.input.length - 2) / 2;
    d.payloadFoundInCalldata = tx.input.toLowerCase().includes(deleted.payloadHex);
    const expired = results.e07_expiry?.details.short as { txHash?: `0x${string}` } | undefined;
    if (expired?.txHash) {
      const etx = await pub.getTransaction({ hash: expired.txHash });
      d.expiredEntityTxStillAvailable = etx.hash === expired.txHash;
      d.expiredPayloadFoundInCalldata = etx.input
        .toLowerCase()
        .includes(Buffer.from(jsonToPayload({ probe: runId })).toString('hex'));
    }
  });

  // 11. Subscription
  await experiment('e11_subscription', 'event subscription (HTTP polling and WebSocket)', async (d) => {
    const measure = async (label: string, client: typeof pub) => {
      let seenAt = 0;
      let target: string | null = null;
      const seen = new Set<string>();
      const stop = client.watchEntityEvents({
        onEntityCreated: (ev) => {
          seen.add(ev.entityKey.toLowerCase());
          if (target && ev.entityKey.toLowerCase() === target && seenAt === 0) seenAt = Date.now();
        },
        onError: () => undefined,
      });
      await sleep(1500);
      const t0 = Date.now();
      const r = await mk({ label: `sub-${label}` });
      target = r.entityKey.toLowerCase();
      if (seen.has(target)) seenAt = Date.now();
      const deadline = Date.now() + 30_000;
      while (seenAt === 0 && Date.now() < deadline) await sleep(250);
      stop();
      return { received: seenAt > 0, msAfterCreateReturned: seenAt > 0 ? seenAt - (t0 + r.ms) : null, createMs: r.ms };
    };
    d.httpPolling = await attempt(() => measure('http', pub));
    d.webSocket = await attempt(async () => {
      const wsClient = createPublicClient({ chain: tiramisu, transport: webSocket(config.arkiv.rpcWs) });
      return measure('ws', wsClient as unknown as typeof pub);
    });
    const viaWrapper = await attempt(async () => {
      let got = false;
      const stop = await A.subscribe!(() => {
        got = true;
      });
      await sleep(1500);
      await mk({ label: 'sub-wrapper' });
      const deadline = Date.now() + 30_000;
      while (!got && Date.now() < deadline) await sleep(250);
      stop();
      return got;
    });
    d.wrapperSubscribe = viaWrapper;
  });

  // 12. Throughput
  await experiment('e12_throughput', '20 sequential creates vs one batch of 20', async (d) => {
    const t0 = Date.now();
    let gasSeq = 0n;
    let feeSeq = 0n;
    for (let i = 0; i < 20; i++) {
      const r = await mk({ label: 'tp-seq', i: u64(i) });
      const g = await gasOf(r.txHash);
      gasSeq += g.gasUsed;
      feeSeq += g.feeWei;
    }
    d.sequential = {
      count: 20,
      ms: Date.now() - t0,
      msPerEntity: (Date.now() - t0) / 20,
      gasTotal: gasSeq,
      feeWei: feeSeq,
    };
    const t1 = Date.now();
    const batch = await walletA.executeBatch({
      creates: Array.from({ length: 20 }, (_, i) => ({
        attributes: { ...common, label: 'tp-batch', i: u64(i) },
        payload: jsonToPayload({ i }),
        contentType: 'application/json' as const,
        expires: ExpirationTime.fromDays(1),
      })),
    });
    const g = await gasOf(batch.txHash);
    d.batch = { count: batch.createdEntities.length, ms: Date.now() - t1, gasTotal: g.gasUsed, feeWei: g.feeWei };
  });

  // 13. Block timestamp
  await experiment(
    'e13_block_timestamp',
    'timestamp of an entity creation block',
    async (d) => {
      const k = (basic as { entityKey: `0x${string}` } | null)?.entityKey;
      if (!k) throw new Error('no entity from e02');
      const rec = await A.getEntity(k);
      if (!rec) throw new Error('e02 entity missing');
      const ts = await A.blockTimestamp(rec.createdAtBlock);
      d.createdAtBlock = rec.createdAtBlock;
      d.blockTimestamp = ts;
      d.blockTimestampIso = new Date(ts * 1000).toISOString();
      const now = Math.floor(Date.now() / 1000);
      d.localNow = now;
      d.secondsAgo = now - ts;
      const head = await pub.getBlock();
      d.headBlock = head.number;
      d.headTimestamp = head.timestamp;
    },
    true,
  );

  // 14. Explorer link format
  await experiment(
    'e14_explorer_links',
    'explorer URL formats',
    async (d) => {
      const k = (basic as { entityKey: string; txHash: string } | null) ?? null;
      const base = config.arkiv.explorerBase;
      const candidates: Record<string, string> = {
        base,
        address: `${base}/address/${addrA}`,
        processor: `${base}/address/${ARKIV_PROCESSOR_ADDRESS}`,
        block: `${base}/block/${await pub.getBlockNumber()}`,
      };
      if (k) {
        candidates.tx = `${base}/tx/${k.txHash}`;
        candidates.entity = `${base}/entity/${k.entityKey}`;
        candidates.entities = `${base}/entities/${k.entityKey}`;
      }
      for (const [name, url] of Object.entries(candidates)) {
        d[name] = { url, status: await attempt(async () => (await fetch(url, { redirect: 'follow' })).status) };
      }
    },
    false,
  );

  const balanceAfter = canWrite ? await A.balance() : 0n;
  const previous = only ? readPrevious() : null;
  const ranIds = new Set(Object.keys(results));
  const mergedFriction = [...(previous?.friction ?? []).filter((f) => !ranIds.has(f.experiment ?? '')), ...friction];
  const out = {
    probe_run: previous ? `${previous.probe_run}+${runId}` : runId,
    date: new Date().toISOString(),
    sdk_version: SDK_VERSION,
    rpc: config.arkiv.rpcHttp,
    chain_id: config.arkiv.chainId,
    wallet_a: addrA,
    wallet_b: addrB,
    arkiv_processor_address: ARKIV_PROCESSOR_ADDRESS,
    sync_strategy: ranIds.has('e06_created_after_block') || !previous ? syncStrategy : previous.sync_strategy,
    spent_wei: (BigInt(previous?.spent_wei ?? '0') + balanceBefore - balanceAfter).toString(),
    experiments: { ...(previous?.experiments ?? {}), ...results },
    friction: mergedFriction,
  };
  writeFileSync(
    'arkiv/probe-results.json',
    JSON.stringify(out, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n',
  );
  writeFriction(mergedFriction, out.probe_run);
  const all = Object.values(out.experiments);
  log(`\nWrote arkiv/probe-results.json (${all.filter((r) => r.ok).length}/${all.length} ok)`);
  log(
    `Spent ${out.spent_wei} wei in total. Sync strategy: ${out.sync_strategy}. Friction entries: ${mergedFriction.length}`,
  );
}

interface PreviousRun {
  probe_run: string;
  sync_strategy: 'block' | 'observed_at_window';
  spent_wei: string;
  experiments: Record<string, Result>;
  friction?: Friction[];
}

function readPrevious(): PreviousRun | null {
  try {
    return JSON.parse(readFileSync('arkiv/probe-results.json', 'utf8')) as PreviousRun;
  } catch {
    return null;
  }
}

function writeFriction(entries: Friction[], run: string) {
  const path = 'arkiv/friction.md';
  const START = '<!-- probe:start -->';
  const END = '<!-- probe:end -->';
  const body = entries
    .map(
      (f) => `### ${f.title}
- Date: ${today}
- What I tried: ${f.tried}
- Expected: ${f.expected}
- Actual: ${f.actual}
- Reproduce: 1. Set WATCHER_PRIVATE_KEY (funded) in .env. 2. Run \`pnpm probe -- --only=${f.experiment ?? 'all'}\`. SDK @arkiv-network/sdk ${SDK_VERSION}, endpoint ${config.arkiv.rpcHttp}, probe run ${run}.
- Impact: ${f.impact}
- Suggested fix: ${f.fix}
`,
    )
    .join('\n');
  const section = `${START}\n## Automatically recorded by \`pnpm probe\` (run ${run}, ${today})\n\n${body || '_No failures or surprises in this run._\n'}${END}`;
  const current = readFileSync(path, 'utf8');
  const next = current.includes(START)
    ? current.replace(new RegExp(`${START}[\\s\\S]*?${END}`), section)
    : `${current.trimEnd()}\n\n${section}\n`;
  writeFileSync(path, next);
}

main().catch((e) => {
  process.stderr.write(`probe crashed: ${errText(e)}\n`);
  process.exitCode = 1;
});
