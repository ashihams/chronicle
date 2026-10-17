import { describe, expect, it } from 'vitest';
import {
  backdating,
  chainOrder,
  clockSkew,
  deriveDoc,
  docStatus,
  latestPerCreator,
  reverted,
  vantageDisagreement,
  versionChain,
  type DeriveParams,
} from '../src/derive.js';
import { ADDR_A, ADDR_B, ADDR_C, DAY, H, T0, obsInput } from './helpers.js';

const P: DeriveParams = {
  nowTs: T0 + 2 * DAY,
  disagreeWindowSeconds: 1800,
  backdateSeconds: 7 * DAY,
  clockSkewSeconds: 3600,
};

describe('chainOrder and latestPerCreator', () => {
  it('orders by block, then key', () => {
    const a = obsInput(ADDR_A, T0, {}, { key: '0x02' });
    const b = obsInput(ADDR_B, T0, {}, { key: '0x01' });
    const c = obsInput(ADDR_A, T0 - 10);
    expect([a, b, c].sort(chainOrder)).toEqual([c, b, a]);
  });

  it('keeps the latest observation of each creator', () => {
    const a1 = obsInput(ADDR_A, T0);
    const a2 = obsInput(ADDR_A, T0 + 100);
    const b1 = obsInput(ADDR_B, T0 + 50);
    expect(latestPerCreator([a2, b1, a1])).toEqual([b1, a2]);
  });
});

describe('versionChain', () => {
  it('orders hashes by their earliest observation and counts observers', () => {
    const obs = [
      obsInput(ADDR_A, T0, { hash: H(1), state: 'first_seen', deadlineTs: 111 }, { summaryEn: 'v1' }),
      obsInput(ADDR_B, T0 + 10, { hash: H(1), state: 'first_seen', deadlineTs: 999 }),
      obsInput(ADDR_A, T0 + DAY, { hash: H(2), state: 'changed', amountPaise: 5 }, { summaryEn: 'v2' }),
    ];
    const v = versionChain(obs, T0 + DAY + 60);
    expect(v.map((x) => [x.seq, x.normSha256, x.observerCount, x.status])).toEqual([
      [1, H(1), 2, 'superseded'],
      [2, H(2), 1, 'current'],
    ]);
    expect(v[0]).toMatchObject({ deadlineTs: 111, summaryEn: 'v1', firstEntityKey: obs[0]?.key, firstSeenTs: T0 });
    expect(v[1]).toMatchObject({ amountPaise: 5, deadlineTs: null, summaryEn: 'v2', normalizerVersion: 'n1' });
  });

  it('breaks a same-block tie by entity key', () => {
    const late = obsInput(ADDR_A, T0, { hash: H(2) }, { key: '0x0b' });
    const early = obsInput(ADDR_B, T0, { hash: H(1) }, { key: '0x0a' });
    expect(versionChain([late, early], T0).map((v) => v.normSha256)).toEqual([H(1), H(2)]);
  });

  it('picks the hash most creators saw recently as current', () => {
    const obs = [
      obsInput(ADDR_A, T0, { hash: H(1) }),
      obsInput(ADDR_A, T0 + 100, { hash: H(2), state: 'changed' }),
      obsInput(ADDR_B, T0 + 200, { hash: H(1) }),
      obsInput(ADDR_C, T0 + 300, { hash: H(1) }),
    ];
    const v = versionChain(obs, T0 + 400);
    expect(v.find((x) => x.status === 'current')?.normSha256).toBe(H(1));
  });

  it('gives a tie to the later version', () => {
    const obs = [obsInput(ADDR_A, T0, { hash: H(1) }), obsInput(ADDR_B, T0 + 100, { hash: H(2) })];
    expect(versionChain(obs, T0 + 200).find((x) => x.status === 'current')?.seq).toBe(2);
  });

  it('ignores observations older than 24 hours for the vote and falls back to the latest hash', () => {
    const obs = [
      obsInput(ADDR_A, T0, { hash: H(1) }),
      obsInput(ADDR_B, T0 + 10, { hash: H(1) }),
      obsInput(ADDR_A, T0 + 20, { hash: H(2), state: 'changed' }),
      obsInput(ADDR_B, T0 + 30, { hash: H(1) }),
    ];
    expect(versionChain(obs, T0 + 3 * DAY).find((x) => x.status === 'current')?.normSha256).toBe(H(1));
    const old = [obsInput(ADDR_A, T0, { hash: H(1) }), obsInput(ADDR_A, T0 + 10, { hash: H(2) })];
    expect(versionChain(old, T0 + 3 * DAY).find((x) => x.status === 'current')?.normSha256).toBe(H(2));
  });

  it('a creator whose latest observation is a removal does not vote', () => {
    const obs = [
      obsInput(ADDR_A, T0, { hash: H(1) }),
      obsInput(ADDR_B, T0 + 10, { hash: H(2) }),
      obsInput(ADDR_B, T0 + 20, { state: 'removed_404' }),
    ];
    expect(versionChain(obs, T0 + 30).find((x) => x.status === 'current')?.normSha256).toBe(H(1));
  });

  it('only accepts live or expired content observations', () => {
    const obs = [
      obsInput(ADDR_A, T0, { hash: H(1) }),
      obsInput(ADDR_A, T0 + 10, { hash: H(2) }, { status: 'deleted' }),
      obsInput(ADDR_A, T0 + 20, { hash: H(3) }, { status: 'modified' }),
      obsInput(ADDR_A, T0 + 30, { hash: H(4) }, { status: 'expired' }),
      obsInput(ADDR_A, T0 + 40, { state: 'unreachable' }),
    ];
    expect(versionChain(obs, T0 + 50).map((v) => v.normSha256)).toEqual([H(1), H(4)]);
    expect(versionChain([], T0)).toEqual([]);
  });
});

describe('vantageDisagreement', () => {
  it('flags two creators with different hashes inside the window', () => {
    const a = obsInput(ADDR_A, T0, { hash: H(1), vantage: 'in-a' });
    const b = obsInput(ADDR_B, T0 + 600, { hash: H(2), vantage: 'eu-b' });
    const f = vantageDisagreement([a, b], 1800);
    expect(f).toMatchObject({ kind: 'vantage_disagreement', severity: 2, entityKeys: [a.key, b.key].sort() });
    expect(JSON.stringify(f?.details)).toContain('eu-b');
  });

  it('does not flag outside the window, on agreement, or for a single creator', () => {
    expect(
      vantageDisagreement([obsInput(ADDR_A, T0, { hash: H(1) }), obsInput(ADDR_B, T0 + 3600, { hash: H(2) })], 1800),
    ).toBeNull();
    expect(
      vantageDisagreement([obsInput(ADDR_A, T0, { hash: H(1) }), obsInput(ADDR_B, T0 + 60, { hash: H(1) })], 1800),
    ).toBeNull();
    expect(
      vantageDisagreement([obsInput(ADDR_A, T0, { hash: H(1) }), obsInput(ADDR_A, T0 + 60, { hash: H(2) })], 1800),
    ).toBeNull();
  });

  it('flags a removal against content, but not different normalizer versions', () => {
    const removed = vantageDisagreement(
      [obsInput(ADDR_A, T0, { hash: H(1) }), obsInput(ADDR_B, T0 + 60, { state: 'removed_404' })],
      1800,
    );
    expect(removed?.kind).toBe('vantage_disagreement');
    expect(
      vantageDisagreement(
        [obsInput(ADDR_A, T0, { hash: H(1) }), obsInput(ADDR_B, T0 + 60, { hash: H(2), normalizerVersion: 'n2' })],
        1800,
      ),
    ).toBeNull();
    expect(
      vantageDisagreement(
        [obsInput(ADDR_A, T0, { state: 'unreachable' }), obsInput(ADDR_B, T0 + 60, { hash: H(2) })],
        1800,
      ),
    ).toBeNull();
  });
});

describe('backdating', () => {
  const chain = (printed2: number | undefined, printed1?: number, lastModified2?: number) => {
    const obs = [
      obsInput(ADDR_A, T0, { hash: H(1), ...(printed1 !== undefined && { printedDateTs: printed1 }) }),
      obsInput(ADDR_A, T0 + 30 * DAY, {
        hash: H(2),
        state: 'changed',
        ...(printed2 !== undefined && { printedDateTs: printed2 }),
        ...(lastModified2 !== undefined && { lastModifiedTs: lastModified2 }),
      }),
    ];
    return { obs, versions: versionChain(obs, T0 + 30 * DAY) };
  };

  it('flags a new version whose new printed date is far before it was first seen', () => {
    const { obs, versions } = chain(T0 - 10 * DAY, T0 - DAY);
    const f = backdating(versions, obs, 7 * DAY);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'backdated', severity: 2, entityKeys: [obs[1]?.key] });
  });

  it('does not flag an amendment that keeps the original printed date', () => {
    const { obs, versions } = chain(T0 - DAY, T0 - DAY);
    expect(backdating(versions, obs, 7 * DAY)).toEqual([]);
  });

  it('flags an old Last-Modified and never flags seq 1', () => {
    const { obs, versions } = chain(undefined, undefined, T0);
    expect(backdating(versions, obs, 7 * DAY)[0]?.details).toMatchObject({ reasons: [{ field: 'last_modified_ts' }] });
    const first = [obsInput(ADDR_A, T0, { hash: H(1), printedDateTs: T0 - 100 * DAY })];
    expect(backdating(versionChain(first, T0), first, 7 * DAY)).toEqual([]);
  });

  it('does not flag dates within the allowed gap', () => {
    const { obs, versions } = chain(T0 + 25 * DAY);
    expect(backdating(versions, obs, 7 * DAY)).toEqual([]);
  });
});

describe('clockSkew, reverted and docStatus', () => {
  it('flags each observation whose observed_at is far from chain time', () => {
    const ok = obsInput(ADDR_A, T0, { observedAt: T0 + 100 });
    const skewed = obsInput(ADDR_B, T0, { observedAt: T0 - 2 * 3600 });
    const f = clockSkew([ok, skewed], 3600);
    expect(f).toEqual([expect.objectContaining({ kind: 'clock_skew', severity: 1, entityKeys: [skewed.key] })]);
    expect(f[0]?.details).toMatchObject({ delta_seconds: -7200 });
  });

  it('flags a revert to an older version', () => {
    const obs = [
      obsInput(ADDR_A, T0, { hash: H(1) }),
      obsInput(ADDR_A, T0 + 100, { hash: H(2), state: 'changed' }),
      obsInput(ADDR_A, T0 + 200, { hash: H(1), state: 'changed' }),
    ];
    const versions = versionChain(obs, T0 + 300);
    expect(reverted(versions)).toMatchObject({ kind: 'reverted', details: { current_seq: 1, max_seq: 2 } });
    expect(reverted(versions.slice(0, 1).map((v) => ({ ...v, status: 'current' as const })))).toBeNull();
  });

  it('summarizes state, current version and change times', () => {
    const obs = [
      obsInput(ADDR_A, T0, { hash: H(1), state: 'first_seen' }),
      obsInput(ADDR_A, T0 + 100, { hash: H(2), state: 'changed' }),
      obsInput(ADDR_A, T0 + 200, { state: 'removed_404' }),
      obsInput(ADDR_A, T0 + 300, { state: 'unreachable' }),
    ];
    expect(docStatus(obs, versionChain(obs, T0 + 400))).toEqual({
      currentState: 'unreachable',
      currentSeq: 2,
      lastSeenTs: T0 + 300,
      lastChangeTs: T0 + 200,
    });
    expect(docStatus([], [])).toEqual({ currentState: null, currentSeq: null, lastSeenTs: null, lastChangeTs: null });
  });
});

describe('deriveDoc', () => {
  it('keeps one chain per normalizer version and uses the latest one for flags', () => {
    const obs = [
      obsInput(ADDR_A, T0, { hash: H(1), normalizerVersion: 'n1' }),
      obsInput(ADDR_A, T0 + 100, { hash: H(2), normalizerVersion: 'n1', state: 'changed' }),
      obsInput(ADDR_A, T0 + 200, { hash: H(9), normalizerVersion: 'n2' }),
    ];
    const d = deriveDoc(obs, { ...P, nowTs: T0 + 300 });
    expect(d.versions.map((v) => `${v.normalizerVersion}:${v.seq}:${v.status}`)).toEqual([
      'n1:1:superseded',
      'n1:2:current',
      'n2:1:current',
    ]);
    expect(d.status.currentSeq).toBe(1);
    expect(d.flags).toEqual([]);
  });

  it('collects every derived flag kind', () => {
    const obs = [
      obsInput(ADDR_A, T0, { hash: H(1), printedDateTs: T0 - DAY }),
      obsInput(ADDR_A, T0 + 30 * DAY, { hash: H(2), state: 'changed', printedDateTs: T0 }),
      obsInput(ADDR_B, T0 + 30 * DAY + 60, { hash: H(1), observedAt: T0 }),
      obsInput(ADDR_C, T0 + 30 * DAY + 120, { hash: H(1) }),
    ];
    const kinds = deriveDoc(obs, { ...P, nowTs: T0 + 30 * DAY + 200 })
      .flags.map((f) => f.kind)
      .sort();
    expect(kinds).toEqual(['backdated', 'clock_skew', 'reverted', 'vantage_disagreement']);
  });
});
