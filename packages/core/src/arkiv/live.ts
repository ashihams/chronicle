import { defineChain, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sha256Hex } from '../hash.js';
import { fromSdkAttributes, toSdkAttributes, toSdkExpression } from './codec.js';
import {
  BLOCK_TIME_SECONDS,
  decodePayload,
  encodePayload,
  normalizeKey,
  ttlToBlocks,
  validateQuery,
} from './limits.js';
import {
  ARKIV_PROCESSOR_ADDRESS,
  createPublicClient,
  createWalletClient,
  ENTITY_EVENTS_ABI,
  ExpirationTime,
  NoEntityFoundError,
  tiramisu,
} from './sdk.js';
import type { Entity } from './sdk.js';
import type { ArkivClient, ArkivEntityRecord, Attrs, CreatedEvent, QueryInput, QueryResult } from './types.js';
import { ArkivReadOnlyError } from './types.js';

export interface LiveArkivOptions {
  chainId: number;
  rpcHttp: string;
  rpcWs?: string;
  privateKey?: string;
  timeoutMs?: number;
}

const ENTITY_CREATED = ENTITY_EVENTS_ABI[0];

function makeChain(o: LiveArkivOptions) {
  return defineChain({
    ...tiramisu,
    id: o.chainId,
    rpcUrls: { default: { http: [o.rpcHttp], ...(o.rpcWs !== undefined && { webSocket: [o.rpcWs] }) } },
  });
}

function makeClients(o: LiveArkivOptions) {
  const chain = makeChain(o);
  const transport = http(o.rpcHttp, { timeout: o.timeoutMs ?? 30_000, retryCount: 3 });
  const publicClient = createPublicClient({ chain, transport });
  const account = o.privateKey !== undefined ? privateKeyToAccount(o.privateKey as Hex) : undefined;
  const walletClient = account !== undefined ? createWalletClient({ chain, transport, account }) : undefined;
  return { publicClient, walletClient, account };
}

/** ArkivClient backed by @arkiv-network/sdk against a real chain. */
export class LiveArkivClient implements ArkivClient {
  private readonly clients: ReturnType<typeof makeClients>;
  private readonly tsCache = new Map<bigint, number>();

  constructor(private readonly opts: LiveArkivOptions) {
    this.clients = makeClients(opts);
  }

  /** Raw SDK clients, for the probe script only. */
  get raw() {
    return this.clients;
  }

  address(): string | null {
    return this.clients.account?.address.toLowerCase() ?? null;
  }

  private wallet() {
    const w = this.clients.walletClient;
    if (w === undefined) throw new ArkivReadOnlyError();
    return w;
  }

  async balance(): Promise<bigint> {
    const a = this.clients.account;
    if (a === undefined) throw new ArkivReadOnlyError();
    return this.clients.publicClient.getBalance({ address: a.address });
  }

  async currentBlock(): Promise<bigint> {
    return this.clients.publicClient.getBlockNumber();
  }

  async blockTimestamp(block: bigint): Promise<number> {
    const cached = this.tsCache.get(block);
    if (cached !== undefined) return cached;
    const b = await this.clients.publicClient.getBlock({ blockNumber: block });
    const ts = Number(b.timestamp);
    this.tsCache.set(block, ts);
    return ts;
  }

  async createEntity(i: {
    attributes: Attrs;
    payload: unknown;
    ttlSeconds: number;
  }): Promise<{ key: string; txHash: string; expiresAtBlock: bigint }> {
    const r = await this.wallet().createEntity({
      attributes: toSdkAttributes(i.attributes),
      payload: encodePayload(i.payload),
      contentType: 'application/json',
      expires: ExpirationTime.fromSeconds(ttlToBlocks(i.ttlSeconds) * BLOCK_TIME_SECONDS),
    });
    return { key: r.entityKey.toLowerCase(), txHash: r.txHash.toLowerCase(), expiresAtBlock: r.expiresAt };
  }

  async extendEntity(key: string, ttlSeconds: number): Promise<{ txHash: string; expiresAtBlock: bigint }> {
    const r = await this.wallet().extendEntity({
      entityKey: normalizeKey(key) as Hex,
      expires: ExpirationTime.fromSeconds(ttlToBlocks(ttlSeconds) * BLOCK_TIME_SECONDS),
    });
    return { txHash: r.txHash.toLowerCase(), expiresAtBlock: r.expiresAt };
  }

  /** Owner-only operations. Not part of ArkivClient; used by the probe to test mutation rules. */
  async deleteEntity(key: string): Promise<{ txHash: string }> {
    const r = await this.wallet().deleteEntity({ entityKey: normalizeKey(key) as Hex });
    return { txHash: r.txHash.toLowerCase() };
  }

  async patchAttributes(key: string, set: Attrs): Promise<{ txHash: string }> {
    const r = await this.wallet().patchEntity({ entityKey: normalizeKey(key) as Hex, set: toSdkAttributes(set) });
    return { txHash: r.txHash.toLowerCase() };
  }

  async transferOwnership(key: string, newOwner: string): Promise<{ txHash: string }> {
    const r = await this.wallet().changeOwnership({
      entityKey: normalizeKey(key) as Hex,
      newOwner: newOwner as Hex,
    });
    return { txHash: r.txHash.toLowerCase() };
  }

  async getEntity(key: string): Promise<ArkivEntityRecord | null> {
    let e: Entity;
    try {
      e = await this.clients.publicClient.getEntity(normalizeKey(key) as Hex);
    } catch (err) {
      if (err instanceof NoEntityFoundError) return null;
      throw err;
    }
    const record = toRecord(e);
    record.txHash = await this.creationTxHash(record.key, record.createdAtBlock);
    return record;
  }

  /** Looks up the EntityCreated log in the entity's creation block. */
  async creationTxHash(key: string, block: bigint): Promise<string | null> {
    const logs = await this.clients.publicClient.getLogs({
      address: ARKIV_PROCESSOR_ADDRESS,
      event: ENTITY_CREATED,
      args: { entityKey: normalizeKey(key) as Hex },
      fromBlock: block,
      toBlock: block,
    });
    return logs[0]?.transactionHash?.toLowerCase() ?? null;
  }

  async query(q: QueryInput): Promise<QueryResult> {
    validateQuery(q);
    const r = await this.clients.publicClient.query(toSdkExpression(q), {
      ...(q.limit !== undefined && { limit: q.limit }),
      ...(q.cursor !== undefined && { cursor: q.cursor }),
    });
    return {
      items: r.entities.map(toRecord),
      blockNumber: r.blockNumber,
      ...(r.cursor !== undefined && { nextCursor: r.cursor }),
    };
  }

  async createdEvents(fromBlock: bigint, toBlock: bigint): Promise<CreatedEvent[]> {
    const logs = await this.clients.publicClient.getLogs({
      address: ARKIV_PROCESSOR_ADDRESS,
      event: ENTITY_CREATED,
      fromBlock,
      toBlock,
    });
    const out: CreatedEvent[] = [];
    for (const l of logs) {
      if (l.blockNumber === null || l.transactionHash === null || l.logIndex === null) continue;
      if (l.args.entityKey === undefined || l.args.owner === undefined || l.args.expiresAt === undefined) continue;
      out.push({
        key: l.args.entityKey.toLowerCase(),
        owner: l.args.owner.toLowerCase(),
        block: l.blockNumber,
        txHash: l.transactionHash.toLowerCase(),
        logIndex: l.logIndex,
        expiresAtBlock: l.args.expiresAt,
      });
    }
    return out;
  }

  async subscribe(onEntity: (e: ArkivEntityRecord) => void): Promise<() => void> {
    return this.clients.publicClient.watchEntityEvents({
      onEntityCreated: (ev) => {
        void this.getEntity(ev.entityKey).then((rec) => {
          if (rec !== null) onEntity(rec);
        });
      },
      onError: () => {
        // Polling stays the source of truth; a dropped subscription only loses speed.
      },
    });
  }
}

function toRecord(e: Entity): ArkivEntityRecord {
  const payloadBytes = e.payload ?? null;
  return {
    key: (e.key ?? '').toLowerCase(),
    creator: (e.creator ?? '').toLowerCase(),
    owner: (e.owner ?? '').toLowerCase(),
    createdAtBlock: e.createdAt ?? 0n,
    expiresAtBlock: e.expiresAt ?? null,
    txHash: null,
    attributes: fromSdkAttributes(e.attributes),
    payloadBytes,
    payload: decodePayload(payloadBytes),
    payloadSha256: sha256Hex(payloadBytes ?? new Uint8Array()),
  };
}
