import { describe, expect, it } from 'vitest';
import { fromSdkAttributes, toSdkAttributes, toSdkExpression } from '../src/arkiv/codec.js';
import { createArkivClient } from '../src/arkiv/factory.js';
import { FakeArkivClient } from '../src/arkiv/fake.js';
import { LiveArkivClient } from '../src/arkiv/live.js';
import { bool, i32, str, u64 } from '../src/arkiv/sdk.js';
import { ArkivReadOnlyError } from '../src/arkiv/types.js';
import { loadConfig } from '../src/config.js';

const KEY = '0x' + '11'.repeat(32);

describe('SDK codec', () => {
  it('writes strings as str and numbers as u64', () => {
    const out = toSdkAttributes({ type: 'observation', observed_at: 1_760_000_000, amount_paise: 2 ** 40 });
    expect(out.type).toEqual(str('observation'));
    expect(out.observed_at).toEqual(u64(1_760_000_000));
    expect(out.amount_paise).toEqual(u64(2 ** 40));
  });

  it('rejects values the wrapper does not allow', () => {
    expect(() => toSdkAttributes({ x: -1 })).toThrow();
    expect(() => toSdkAttributes({ key: 'x' })).toThrow();
  });

  it('reads typed values back into plain strings and numbers', () => {
    expect(
      fromSdkAttributes({
        a: str('x'),
        b: u64(5n),
        c: i32(7),
        d: bool(true),
        e: u64(2n ** 60n),
      }),
    ).toEqual({ a: 'x', b: 5, c: 7, d: 1, e: (2n ** 60n).toString() });
  });

  it('renders where clauses to the Arkiv query language', () => {
    const expr = toSdkExpression({
      where: [
        { attr: 'type', op: 'eq', value: 'observation' },
        { attr: 'observed_at', op: 'gte', value: 100 },
        { attr: 'doc_id', op: 'prefix', value: 'ab' },
      ],
      creator: '0x' + 'a'.repeat(40),
    });
    expect(String(expr)).toBe(
      "type = str('observation') AND observed_at >= u64(100) AND doc_id STARTSWITH str('ab') AND " +
        '$creator = addr(0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa)',
    );
    expect(String(toSdkExpression({ where: [{ attr: '$key', op: 'eq', value: KEY }] }))).toBe(`$key = key(${KEY})`);
  });
});

describe('LiveArkivClient (offline)', () => {
  it('is read-only without a private key', async () => {
    const c = new LiveArkivClient({ chainId: 7738577, rpcHttp: 'http://127.0.0.1:9' });
    expect(c.address()).toBeNull();
    await expect(c.createEntity({ attributes: { type: 'x' }, payload: null, ttlSeconds: 60 })).rejects.toThrow(
      ArkivReadOnlyError,
    );
    await expect(c.balance()).rejects.toThrow(ArkivReadOnlyError);
  });

  it('derives the wallet address from the private key', () => {
    // Well-known test key (Hardhat account #0). Not a real wallet.
    const c = new LiveArkivClient({
      chainId: 7738577,
      rpcHttp: 'http://127.0.0.1:9',
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    });
    expect(c.address()).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  });
});

describe('createArkivClient', () => {
  it('returns a fake client in fake mode and reuses a provided one', () => {
    const cfg = loadConfig({ ARKIV_MODE: 'fake' });
    expect(createArkivClient(cfg)).toBeInstanceOf(FakeArkivClient);
    const shared = new FakeArkivClient();
    expect(createArkivClient(cfg, { fake: shared })).toBe(shared);
  });

  it('returns a live client in live mode, read-only when asked', () => {
    const cfg = loadConfig({ ARKIV_MODE: 'live', WATCHER_PRIVATE_KEY: '0x' + '22'.repeat(32) });
    const writer = createArkivClient(cfg);
    expect(writer).toBeInstanceOf(LiveArkivClient);
    expect(writer.address()).toMatch(/^0x[0-9a-f]{40}$/);
    expect(createArkivClient(cfg, { privateKey: null }).address()).toBeNull();
  });
});
