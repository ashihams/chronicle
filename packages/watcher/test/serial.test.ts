import { FakeArkivClient, type ArkivClient } from '@chronicle/core';
import { describe, expect, it } from 'vitest';
import { serializeWrites } from '../src/serial.js';

describe('serializeWrites', () => {
  it('runs writes one at a time, in call order, and keeps going after a failure', async () => {
    const fake = new FakeArkivClient();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const slow: ArkivClient = Object.assign(Object.create(fake) as FakeArkivClient, {
      createEntity: async (i: Parameters<ArkivClient['createEntity']>[0]) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        order.push(String(i.attributes.n));
        if (i.attributes.n === 2) throw new Error('nonce too low');
        return fake.createEntity(i);
      },
    });
    const client = serializeWrites(slow);
    const results = await Promise.allSettled(
      [1, 2, 3].map((n) => client.createEntity({ attributes: { type: 'x', n }, payload: {}, ttlSeconds: 60 })),
    );
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(order).toEqual(['1', '2', '3']);
    expect(maxActive).toBe(1);
  });

  it('passes reads and extensions through to the wrapped client', async () => {
    const fake = new FakeArkivClient();
    const client = serializeWrites(fake);
    const { key } = await client.createEntity({ attributes: { type: 'doc' }, payload: { a: 1 }, ttlSeconds: 60 });
    expect(client.address()).toBe(fake.address());
    expect(await client.balance()).toBe(await fake.balance());
    const head = await client.currentBlock();
    expect(await client.blockTimestamp(head)).toBe(await fake.blockTimestamp(head));
    expect((await client.getEntity(key))?.payload).toEqual({ a: 1 });
    expect((await client.query({ where: [{ attr: 'type', op: 'eq', value: 'doc' }] })).items).toHaveLength(1);
    expect(await client.createdEvents(0n, head)).toHaveLength(1);
    expect((await client.extendEntity(key, 3600)).expiresAtBlock).toBeGreaterThan(head);
  });
});
