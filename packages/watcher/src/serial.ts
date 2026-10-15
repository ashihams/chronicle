import type { ArkivClient } from '@chronicle/core';

/**
 * Wraps a client so its writes (create and extend) run one at a time. One wallet sending
 * transactions concurrently can race on the nonce; reads stay concurrent.
 */
export function serializeWrites(client: ArkivClient): ArkivClient {
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
  return {
    address: () => client.address(),
    balance: () => client.balance(),
    currentBlock: () => client.currentBlock(),
    blockTimestamp: (block) => client.blockTimestamp(block),
    createEntity: (i) => serial(() => client.createEntity(i)),
    extendEntity: (key, ttl) => serial(() => client.extendEntity(key, ttl)),
    getEntity: (key) => client.getEntity(key),
    query: (q) => client.query(q),
    createdEvents: (from, to) => client.createdEvents(from, to),
  };
}
