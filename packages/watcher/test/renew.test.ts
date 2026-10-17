import { FakeArkivClient, FakeArkivNetwork, type ArkivClient } from '@chronicle/core';
import { describe, expect, it } from 'vitest';
import { renewEntities } from '../src/renew.js';
import { silentLog } from './helpers.js';

const DAY = 86400;

async function setup(ttlDays: number): Promise<{ net: FakeArkivNetwork; me: FakeArkivClient; key: string }> {
  const net = new FakeArkivNetwork();
  const me = new FakeArkivClient('0x00000000000000000000000000000000000000a1', net);
  const { key } = await me.createEntity({ attributes: { type: 'doc' }, payload: {}, ttlSeconds: ttlDays * DAY });
  return { net, me, key };
}

function renew(arkiv: ArkivClient, keys: string[]) {
  return renewEntities({ arkiv, keys, ttlSeconds: 180 * DAY, renewWhenSecondsLeft: 30 * DAY, log: silentLog });
}

describe('renewEntities', () => {
  it('extends an owned entity with less than the threshold left', async () => {
    const { me, key } = await setup(10);
    const before = (await me.getEntity(key))?.expiresAtBlock ?? 0n;
    expect(await renew(me, [key, key])).toEqual({ extended: 1, skipped: 0, failed: 0 });
    expect((await me.getEntity(key))?.expiresAtBlock ?? 0n).toBeGreaterThan(before);
  });

  it('skips entities with enough time left', async () => {
    const { me, key } = await setup(100);
    expect(await renew(me, [key])).toEqual({ extended: 0, skipped: 1, failed: 0 });
  });

  it('extends once the chain has moved close to expiry', async () => {
    const { net, me, key } = await setup(100);
    net.advanceSeconds(75 * DAY);
    expect(await renew(me, [key])).toEqual({ extended: 1, skipped: 0, failed: 0 });
  });

  it('skips entities owned by someone else and ones that no longer exist', async () => {
    const { net, me, key } = await setup(10);
    const other = me.withAddress('0x00000000000000000000000000000000000000b2');
    expect(await renew(other, [key, `0x${'9'.repeat(64)}`])).toEqual({ extended: 0, skipped: 2, failed: 0 });
    net.__expireNow(key);
    expect(await renew(me, [key])).toEqual({ extended: 0, skipped: 1, failed: 0 });
  });

  it('counts failures without throwing', async () => {
    const { me, key } = await setup(10);
    const broken: ArkivClient = Object.assign(Object.create(me) as FakeArkivClient, {
      extendEntity: async () => {
        throw new Error('rpc down');
      },
    });
    expect(await renew(broken, [key])).toEqual({ extended: 0, skipped: 0, failed: 1 });
  });
});
