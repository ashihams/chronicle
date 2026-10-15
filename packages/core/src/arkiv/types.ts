export type AttrValue = string | number;
export type Attrs = Record<string, AttrValue>;

export interface ArkivEntityRecord {
  key: string; // 0x-prefixed lowercase hex
  creator: string; // immutable original writer ($creator), lowercase
  owner: string; // current owner ($owner), lowercase
  createdAtBlock: bigint;
  expiresAtBlock: bigint | null;
  txHash: string | null; // creating transaction; null when not looked up (query results)
  attributes: Attrs;
  payloadBytes: Uint8Array | null;
  payload: unknown | null; // JSON-decoded if possible
  payloadSha256: string; // sha256 hex of the exact payload bytes
}

/**
 * `prefix` is the only pattern operator Arkiv supports (STARTSWITH on str attributes).
 * Range operators work only on numeric attributes.
 */
export type WhereOp = 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'prefix';
export interface Where {
  attr: string;
  op: WhereOp;
  value: AttrValue;
}

export interface QueryInput {
  where: Where[]; // AND
  creator?: string;
  owner?: string;
  limit?: number; // 1..200
  cursor?: string;
}
export interface QueryResult {
  items: ArkivEntityRecord[];
  nextCursor?: string;
  blockNumber: bigint;
}

/** An `EntityCreated` event: the cheapest way to learn what was created in a block range. */
export interface CreatedEvent {
  key: string;
  owner: string;
  block: bigint;
  txHash: string;
  logIndex: number;
  expiresAtBlock: bigint;
}

export interface ArkivClient {
  /** The wallet address used for writes, lowercase; null for a read-only client. */
  address(): string | null;
  balance(): Promise<bigint>;
  currentBlock(): Promise<bigint>;
  blockTimestamp(block: bigint): Promise<number>; // unix seconds
  createEntity(i: {
    attributes: Attrs;
    payload: unknown;
    ttlSeconds: number;
  }): Promise<{ key: string; txHash: string; expiresAtBlock: bigint }>;
  /** Sets a new expiry counted from now; it must be later than the current one. */
  extendEntity(key: string, ttlSeconds: number): Promise<{ txHash: string; expiresAtBlock: bigint }>;
  getEntity(key: string): Promise<ArkivEntityRecord | null>;
  query(q: QueryInput): Promise<QueryResult>;
  createdEvents(fromBlock: bigint, toBlock: bigint): Promise<CreatedEvent[]>;
  subscribe?(onEntity: (e: ArkivEntityRecord) => void): Promise<() => void>;
}

export class ArkivReadOnlyError extends Error {
  constructor() {
    super('This Arkiv client has no private key, so it cannot write');
    this.name = 'ArkivReadOnlyError';
  }
}

export class ArkivValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArkivValidationError';
  }
}
