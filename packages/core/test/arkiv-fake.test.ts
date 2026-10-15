import { describe, expect, it } from 'vitest';
import { FakeArkivClient, FakeArkivError, FakeArkivNetwork } from '../src/arkiv/fake.js';
import { ArkivValidationError } from '../src/arkiv/types.js';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const DAY = 86400;

function setup() {
  const network = new FakeArkivNetwork({ startBlock: 100n, genesisTs: 1_700_000_000 });
  return { network, a: new FakeArkivClient(A, network), b: new FakeArkivClient(B, network) };
}

describe('FakeArkivClient', () => {
  it('creates and reads back an entity with creator, owner, block, expiry, tx hash and payload hash', async () => {
    const { a } = setup();
    const created = await a.createEntity({
      attributes: { type: 'doc', schema_v: 1 },
      payload: { title: 'x' },
      ttlSeconds: DAY,
    });
    expect(created.key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(created.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(created.expiresAtBlock).toBe(101n + BigInt(DAY / 2));
    const e = await a.getEntity(created.key);
    expect(e).toMatchObject({
      key: created.key,
      creator: A,
      owner: A,
      createdAtBlock: 101n,
      expiresAtBlock: 101n + BigInt(DAY / 2),
      txHash: created.txHash,
      attributes: { type: 'doc', schema_v: 1 },
      payload: { title: 'x' },
    });
    expect(e?.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new TextDecoder().decode(e?.payloadBytes ?? new Uint8Array())).toBe('{"title":"x"}');
  });

  it('is deterministic across fresh networks and gives identical creates distinct keys', async () => {
    const one = setup();
    const two = setup();
    const k1 = await one.a.createEntity({ attributes: { type: 'doc' }, payload: null, ttlSeconds: 60 });
    const k2 = await two.a.createEntity({ attributes: { type: 'doc' }, payload: null, ttlSeconds: 60 });
    expect(k1).toEqual(k2);
    const k3 = await one.a.createEntity({ attributes: { type: 'doc' }, payload: null, ttlSeconds: 60 });
    expect(k3.key).not.toBe(k1.key);
  });

  it('validates attributes and payload before writing', async () => {
    const { a, network } = setup();
    await expect(a.createEntity({ attributes: { n: -1 }, payload: null, ttlSeconds: 60 })).rejects.toThrow(
      ArkivValidationError,
    );
    await expect(a.createEntity({ attributes: { s: 'x'.repeat(129) }, payload: null, ttlSeconds: 60 })).rejects.toThrow(
      /128/,
    );
    await expect(
      a.createEntity({ attributes: { type: 'x' }, payload: 'y'.repeat(128 * 1024), ttlSeconds: 60 }),
    ).rejects.toThrow(/payload/);
    expect(network.entities.size).toBe(0);
  });

  it('shares one chain between writers and filters by creator and owner', async () => {
    const { a, b, network } = setup();
    await a.createEntity({ attributes: { type: 'observation', doc_id: 'd1' }, payload: null, ttlSeconds: DAY });
    const fromB = await b.createEntity({
      attributes: { type: 'observation', doc_id: 'd1' },
      payload: null,
      ttlSeconds: DAY,
    });
    const all = await a.query({ where: [{ attr: 'doc_id', op: 'eq', value: 'd1' }] });
    expect(all.items.map((e) => e.creator)).toEqual([A, B]);
    const onlyB = await a.query({ where: [{ attr: 'doc_id', op: 'eq', value: 'd1' }], creator: '0x' + 'B'.repeat(40) });
    expect(onlyB.items).toHaveLength(1);
    expect(onlyB.items[0]?.creator).toBe(B);
    expect(onlyB.items[0]?.txHash).toBeNull();

    network.__transfer(fromB.key, A);
    const ownedByA = await a.query({ where: [], owner: A });
    expect(ownedByA.items).toHaveLength(2);
    expect((await a.query({ where: [], creator: B })).items[0]?.owner).toBe(A);
  });

  it('evaluates numeric ranges, typed equality, prefix and AND', async () => {
    const { a } = setup();
    for (let n = 1; n <= 5; n++) {
      await a.createEntity({
        attributes: { type: 'o', n, tag: n % 2 ? `odd-${n}` : `even-${n}` },
        payload: null,
        ttlSeconds: DAY,
      });
    }
    const q = async (where: Parameters<typeof a.query>[0]['where']) =>
      (await a.query({ where })).items.map((e) => e.attributes.n);
    expect(await q([{ attr: 'n', op: 'gt', value: 3 }])).toEqual([4, 5]);
    expect(await q([{ attr: 'n', op: 'gte', value: 3 }])).toEqual([3, 4, 5]);
    expect(await q([{ attr: 'n', op: 'lt', value: 2 }])).toEqual([1]);
    expect(await q([{ attr: 'n', op: 'lte', value: 2 }])).toEqual([1, 2]);
    expect(await q([{ attr: 'tag', op: 'prefix', value: 'odd-' }])).toEqual([1, 3, 5]);
    expect(
      await q([
        { attr: 'tag', op: 'prefix', value: 'odd-' },
        { attr: 'n', op: 'gte', value: 3 },
      ]),
    ).toEqual([3, 5]);
    expect(await q([{ attr: 'tag', op: 'eq', value: 'even-2' }])).toEqual([2]);
    expect(await q([{ attr: 'n', op: 'eq', value: 2 }])).toEqual([2]);
    // typed: the string "2" does not match the number 2
    expect(await q([{ attr: 'n', op: 'eq', value: '2' }])).toEqual([]);
  });

  it('rejects queries Arkiv would reject', async () => {
    const { a } = setup();
    await expect(a.query({ where: [] })).rejects.toThrow(/at least one filter/);
    await expect(a.query({ where: [{ attr: 'tag', op: 'gt', value: 'a' }] })).rejects.toThrow(/numeric/);
    await expect(a.query({ where: [{ attr: 'n', op: 'prefix', value: 1 }] })).rejects.toThrow(/string/);
    await expect(a.query({ where: [{ attr: 'type', op: 'eq', value: 'x' }], limit: 201 })).rejects.toThrow(/limit/);
  });

  it('supports system attributes in where', async () => {
    const { a } = setup();
    const { key } = await a.createEntity({ attributes: { type: 'x' }, payload: null, ttlSeconds: DAY });
    expect((await a.query({ where: [{ attr: '$key', op: 'eq', value: key }] })).items).toHaveLength(1);
    expect((await a.query({ where: [{ attr: '$creator', op: 'eq', value: A }] })).items).toHaveLength(1);
    expect((await a.query({ where: [{ attr: '$expiresAt', op: 'gt', value: 200 }] })).items).toHaveLength(1);
  });

  it('paginates in creation order with a cursor', async () => {
    const { a } = setup();
    for (let n = 1; n <= 5; n++) await a.createEntity({ attributes: { type: 'p', n }, payload: null, ttlSeconds: DAY });
    const where = [{ attr: 'type', op: 'eq' as const, value: 'p' }];
    const p1 = await a.query({ where, limit: 2 });
    const p2 = await a.query({ where, limit: 2, cursor: p1.nextCursor ?? '' });
    const p3 = await a.query({ where, limit: 2, cursor: p2.nextCursor ?? '' });
    expect(p1.items.map((e) => e.attributes.n)).toEqual([1, 2]);
    expect(p2.items.map((e) => e.attributes.n)).toEqual([3, 4]);
    expect(p3.items.map((e) => e.attributes.n)).toEqual([5]);
    expect(p3.nextCursor).toBeUndefined();
    await expect(a.query({ where, cursor: 'garbage' })).rejects.toThrow();
  });

  it('expires entities and hides them from get and query', async () => {
    const { a, network } = setup();
    const { key } = await a.createEntity({ attributes: { type: 'short' }, payload: null, ttlSeconds: 10 });
    network.advanceSeconds(8);
    expect(await a.getEntity(key)).not.toBeNull();
    network.advanceSeconds(2);
    expect(await a.getEntity(key)).toBeNull();
    expect((await a.query({ where: [{ attr: 'type', op: 'eq', value: 'short' }] })).items).toHaveLength(0);
  });

  it('extends expiry for the owner only, and only forwards', async () => {
    const { a, b } = setup();
    const { key, expiresAtBlock } = await a.createEntity({ attributes: { type: 'x' }, payload: null, ttlSeconds: DAY });
    const ext = await a.extendEntity(key, 2 * DAY);
    expect(ext.expiresAtBlock).toBeGreaterThan(expiresAtBlock);
    expect((await a.getEntity(key))?.expiresAtBlock).toBe(ext.expiresAtBlock);
    await expect(a.extendEntity(key, 60)).rejects.toThrow(/ExpiryNotExtended/);
    await expect(b.extendEntity(key, 3 * DAY)).rejects.toThrow(/NotOwner/);
    await expect(a.extendEntity('0x' + '0'.repeat(64), DAY)).rejects.toThrow(FakeArkivError);
  });

  it('test helpers simulate deletion, owner patches, transfers and expiry', async () => {
    const { a, network } = setup();
    const { key } = await a.createEntity({ attributes: { type: 'x', n: 1 }, payload: { v: 1 }, ttlSeconds: DAY });
    const original = await a.getEntity(key);
    network.__setAttributes(key, { n: 2 });
    network.__setPayload(key, { v: 2 });
    const patched = await a.getEntity(key);
    expect(patched?.attributes.n).toBe(2);
    expect(patched?.payloadSha256).not.toBe(original?.payloadSha256);
    network.__transfer(key, B);
    expect((await a.getEntity(key))?.owner).toBe(B);
    expect((await a.getEntity(key))?.creator).toBe(A);
    network.__expireNow(key);
    expect(await a.getEntity(key)).toBeNull();
    const second = await a.createEntity({ attributes: { type: 'x' }, payload: null, ttlSeconds: DAY });
    network.__delete(second.key);
    expect(await a.getEntity(second.key)).toBeNull();
  });

  it('lists created events in a block range', async () => {
    const { a, b } = setup();
    const x = await a.createEntity({ attributes: { type: 'x' }, payload: null, ttlSeconds: DAY });
    const y = await b.createEntity({ attributes: { type: 'x' }, payload: null, ttlSeconds: DAY });
    expect((await a.createdEvents(101n, 102n)).map((e) => [e.key, e.owner, e.txHash])).toEqual([
      [x.key, A, x.txHash],
      [y.key, B, y.txHash],
    ]);
    expect(await a.createdEvents(102n, 200n)).toHaveLength(1);
  });

  it('reports block, timestamps, balance and address', async () => {
    const { a, network } = setup();
    expect(a.address()).toBe(A);
    expect(await a.balance()).toBe(10n ** 18n);
    expect(await a.currentBlock()).toBe(100n);
    expect(await a.blockTimestamp(100n)).toBe(1_700_000_200);
    network.advanceBlocks(5);
    expect(await a.currentBlock()).toBe(105n);
    expect(a.withAddress(B).address()).toBe(B);
  });

  it('subscribe notifies about new entities until unsubscribed', async () => {
    const { a, b } = setup();
    const seen: string[] = [];
    const stop = await a.subscribe((e) => seen.push(e.creator));
    await b.createEntity({ attributes: { type: 'x' }, payload: null, ttlSeconds: 60 });
    stop();
    await b.createEntity({ attributes: { type: 'x' }, payload: null, ttlSeconds: 60 });
    expect(seen).toEqual([B]);
  });
});
