import { describe, expect, it } from 'vitest';
import {
  classifyVanishedDoc,
  stealthFlagsFromSnapshots,
  vanishedDocIds,
  type IndexSnapshotView,
} from '../src/stealth.js';

const DOC_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DOC_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function snap(
  over: Partial<IndexSnapshotView> & Pick<IndexSnapshotView, 'key' | 'creator' | 'createdBlock' | 'links'>,
): IndexSnapshotView {
  return {
    indexId: 'demo-index',
    ...over,
  };
}

describe('stealth helpers', () => {
  it('classifies vanished docs', () => {
    expect(classifyVanishedDoc({ state: 'present', httpStatus: 200, title: null }, [])).toBe('delisted');
    expect(classifyVanishedDoc({ state: 'removed_404', httpStatus: 404, title: null }, [])).toBe('stealth_removed');
    expect(classifyVanishedDoc({ state: 'removed_404', httpStatus: 404, title: null }, ['Circular withdrawn'])).toBe(
      'declared_withdrawn',
    );
  });

  it('lists vanished doc ids', () => {
    expect(
      vanishedDocIds(
        [
          { docId: DOC_A, title: 'A' },
          { docId: DOC_B, title: 'B' },
        ],
        [{ docId: DOC_B, title: 'B' }],
      ),
    ).toEqual([DOC_A]);
  });

  it('opens stealth_removed with high severity when two creators agree', () => {
    const flags = stealthFlagsFromSnapshots(
      [
        snap({
          key: '0x1',
          creator: '0xaa',
          createdBlock: 1,
          links: [
            { docId: DOC_A, title: 'A' },
            { docId: DOC_B, title: 'B' },
          ],
        }),
        snap({
          key: '0x2',
          creator: '0xaa',
          createdBlock: 2,
          links: [{ docId: DOC_B, title: 'B' }],
        }),
        snap({
          key: '0x3',
          creator: '0xbb',
          createdBlock: 1,
          links: [
            { docId: DOC_A, title: 'A' },
            { docId: DOC_B, title: 'B' },
          ],
        }),
        snap({
          key: '0x4',
          creator: '0xbb',
          createdBlock: 3,
          links: [{ docId: DOC_B, title: 'B' }],
        }),
      ],
      () => ({ state: 'removed_404', httpStatus: 404, title: null }),
    );
    expect(flags.get(DOC_A)).toMatchObject({
      kind: 'stealth_removed',
      severity: 3,
      details: { notice_badge: 'removed from listing without a withdrawal notice', corroborated: true },
    });
  });

  it('keeps low severity without corroboration', () => {
    const flags = stealthFlagsFromSnapshots(
      [
        snap({
          key: '0x1',
          creator: '0xaa',
          createdBlock: 1,
          links: [{ docId: DOC_A, title: 'A' }],
        }),
        snap({
          key: '0x2',
          creator: '0xaa',
          createdBlock: 2,
          links: [],
        }),
      ],
      () => ({ state: 'present', httpStatus: 200, title: null }),
    );
    expect(flags.get(DOC_A)).toMatchObject({ kind: 'delisted', severity: 1, details: { corroborated: false } });
  });
});
