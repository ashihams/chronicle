import { sha256Hex } from '../hash.js';
import {
  BLOCK_TIME_SECONDS,
  decodePayload,
  encodePayload,
  normalizeAddress,
  normalizeKey,
  ttlToBlocks,
  validateAttrs,
  validateQuery,
} from './limits.js';
import type {
  ArkivClient,
  ArkivEntityRecord,
  Attrs,
  AttrValue,
  CreatedEvent,
  QueryInput,
  QueryResult,
} from './types.js';
import { ArkivValidationError } from './types.js';
import { matchesWhere } from './where.js';

interface StoredEntity {
  key: string;
  creator: string;
  owner: string;
  createdAtBlock: bigint;
  expiresAtBlock: bigint;
  txHash: string;
  logIndex: number;
  attributes: Attrs;
  payloadBytes: Uint8Array;
  seq: number;
}

export class FakeArkivError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FakeArkivError';
  }
}

/**
 * Shared in-memory chain. Several FakeArkivClient instances (one per wallet address) can write to
 * the same network, which is how multi-writer scenarios are tested.
 */
export class FakeArkivNetwork {
  private block: bigint;
  private seq = 0;
  readonly entities = new Map<string, StoredEntity>();
  private readonly listeners = new Set<(e: ArkivEntityRecord) => void>();
  readonly balances = new Map<string, bigint>();

  constructor(readonly opts: { startBlock?: bigint; genesisTs?: number; blockTimeSeconds?: number } = {}) {
    this.block = opts.startBlock ?? 1000n;
  }

  get head(): bigint {
    return this.block;
  }

  advanceBlocks(n: number | bigint): bigint {
    this.block += BigInt(n);
    return this.block;
  }

  /** Advances the chain so that roughly `seconds` of chain time pass. */
  advanceSeconds(seconds: number): bigint {
    return this.advanceBlocks(Math.ceil(seconds / (this.opts.blockTimeSeconds ?? BLOCK_TIME_SECONDS)));
  }

  timestampOf(block: bigint): number {
    const genesis = this.opts.genesisTs ?? 1_760_000_000;
    return genesis + Number(block) * (this.opts.blockTimeSeconds ?? BLOCK_TIME_SECONDS);
  }

  /** Every write lands in a fresh block, like a sequential writer on a real chain. */
  mine(): bigint {
    this.block += 1n;
    return this.block;
  }

  nextSeq(): number {
    return ++this.seq;
  }

  isLive(e: StoredEntity): boolean {
    return e.expiresAtBlock > this.block;
  }

  emit(record: ArkivEntityRecord): void {
    for (const l of this.listeners) l(record);
  }

  addListener(l: (e: ArkivEntityRecord) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  toRecord(e: StoredEntity, withTx: boolean): ArkivEntityRecord {
    return {
      key: e.key,
      creator: e.creator,
      owner: e.owner,
      createdAtBlock: e.createdAtBlock,
      expiresAtBlock: e.expiresAtBlock,
      txHash: withTx ? e.txHash : null,
      attributes: { ...e.attributes },
      payloadBytes: e.payloadBytes.slice(),
      payload: decodePayload(e.payloadBytes),
      payloadSha256: sha256Hex(e.payloadBytes),
    };
  }

  // ---- test helpers: simulate what an owner can do to their own entities ----

  __delete(key: string): void {
    this.entities.delete(normalizeKey(key));
  }

  __setAttributes(key: string, set: Attrs): void {
    const e = this.mustGet(key);
    validateAttrs({ ...e.attributes, ...set });
    e.attributes = { ...e.attributes, ...set };
  }

  __setPayload(key: string, payload: unknown): void {
    this.mustGet(key).payloadBytes = encodePayload(payload);
  }

  __transfer(key: string, newOwner: string): void {
    this.mustGet(key).owner = normalizeAddress(newOwner);
  }

  __expireNow(key: string): void {
    this.mustGet(key).expiresAtBlock = this.block;
  }

  private mustGet(key: string): StoredEntity {
    const e = this.entities.get(normalizeKey(key));
    if (!e) throw new FakeArkivError(`no entity ${key}`);
    return e;
  }
}

function hex32(n: number, salt: string): string {
  return '0x' + sha256Hex(`${salt}:${n}`);
}

function systemValue(e: StoredEntity, attr: string): AttrValue | undefined {
  switch (attr) {
    case '$key':
      return e.key;
    case '$owner':
      return e.owner;
    case '$creator':
      return e.creator;
    case '$expiresAt':
      return Number(e.expiresAtBlock);
    default:
      return e.attributes[attr];
  }
}

/** Deterministic in-memory ArkivClient used by unit tests and ARKIV_MODE=fake. */
export class FakeArkivClient implements ArkivClient {
  readonly network: FakeArkivNetwork;
  private readonly addr: string;

  constructor(address = '0x000000000000000000000000000000000000a11c', network = new FakeArkivNetwork()) {
    this.addr = normalizeAddress(address);
    this.network = network;
    if (!network.balances.has(this.addr)) network.balances.set(this.addr, 10n ** 18n);
  }

  /** Another writer on the same in-memory chain. */
  withAddress(address: string): FakeArkivClient {
    return new FakeArkivClient(address, this.network);
  }

  address(): string {
    return this.addr;
  }

  async balance(): Promise<bigint> {
    return this.network.balances.get(this.addr) ?? 0n;
  }

  async currentBlock(): Promise<bigint> {
    return this.network.head;
  }

  async blockTimestamp(block: bigint): Promise<number> {
    return this.network.timestampOf(block);
  }

  async createEntity(i: {
    attributes: Attrs;
    payload: unknown;
    ttlSeconds: number;
  }): Promise<{ key: string; txHash: string; expiresAtBlock: bigint }> {
    validateAttrs(i.attributes);
    const payloadBytes = encodePayload(i.payload);
    const blocks = ttlToBlocks(i.ttlSeconds);
    const block = this.network.mine();
    const seq = this.network.nextSeq();
    const e: StoredEntity = {
      key: hex32(seq, 'key'),
      creator: this.addr,
      owner: this.addr,
      createdAtBlock: block,
      expiresAtBlock: block + BigInt(blocks),
      txHash: hex32(seq, 'tx'),
      logIndex: 0,
      attributes: { ...i.attributes },
      payloadBytes,
      seq,
    };
    this.network.entities.set(e.key, e);
    this.network.emit(this.network.toRecord(e, true));
    return { key: e.key, txHash: e.txHash, expiresAtBlock: e.expiresAtBlock };
  }

  async extendEntity(key: string, ttlSeconds: number): Promise<{ txHash: string; expiresAtBlock: bigint }> {
    const e = this.network.entities.get(normalizeKey(key));
    if (!e || !this.network.isLive(e)) throw new FakeArkivError(`EntityNotFound(${key})`);
    if (e.owner !== this.addr) throw new FakeArkivError(`NotOwner(${key}, ${this.addr}, ${e.owner})`);
    const block = this.network.mine();
    const target = block + BigInt(ttlToBlocks(ttlSeconds));
    if (target <= e.expiresAtBlock) {
      throw new FakeArkivError(`ExpiryNotExtended(${key}, ${target}, ${e.expiresAtBlock})`);
    }
    e.expiresAtBlock = target;
    return { txHash: hex32(this.network.nextSeq(), 'tx'), expiresAtBlock: target };
  }

  async getEntity(key: string): Promise<ArkivEntityRecord | null> {
    const e = this.network.entities.get(normalizeKey(key));
    if (!e || !this.network.isLive(e)) return null;
    return this.network.toRecord(e, true);
  }

  async query(q: QueryInput): Promise<QueryResult> {
    validateQuery(q);
    const creator = q.creator !== undefined ? normalizeAddress(q.creator) : undefined;
    const owner = q.owner !== undefined ? normalizeAddress(q.owner) : undefined;
    const matched = [...this.network.entities.values()]
      .filter((e) => this.network.isLive(e))
      .filter((e) => (creator === undefined || e.creator === creator) && (owner === undefined || e.owner === owner))
      .filter((e) => q.where.every((w) => matchesWhere(systemValue(e, w.attr), w)))
      .sort((a, b) => a.seq - b.seq);
    const offset = q.cursor !== undefined ? decodeCursor(q.cursor) : 0;
    const limit = q.limit ?? 100;
    const page = matched.slice(offset, offset + limit);
    const next = offset + limit < matched.length ? encodeCursor(offset + limit) : undefined;
    return {
      items: page.map((e) => this.network.toRecord(e, false)),
      blockNumber: this.network.head,
      ...(next !== undefined && { nextCursor: next }),
    };
  }

  async createdEvents(fromBlock: bigint, toBlock: bigint): Promise<CreatedEvent[]> {
    return [...this.network.entities.values()]
      .filter((e) => e.createdAtBlock >= fromBlock && e.createdAtBlock <= toBlock)
      .sort((a, b) => a.seq - b.seq)
      .map((e) => ({
        key: e.key,
        owner: e.creator,
        block: e.createdAtBlock,
        txHash: e.txHash,
        logIndex: e.logIndex,
        expiresAtBlock: e.expiresAtBlock,
      }));
  }

  async subscribe(onEntity: (e: ArkivEntityRecord) => void): Promise<() => void> {
    return this.network.addListener(onEntity);
  }
}

function encodeCursor(offset: number): string {
  return `fake:${offset}`;
}

function decodeCursor(cursor: string): number {
  const m = /^fake:(\d+)$/.exec(cursor);
  if (!m?.[1]) throw new ArkivValidationError(`bad cursor ${cursor}`);
  return Number(m[1]);
}
