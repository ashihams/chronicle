import { describe, expect, it } from 'vitest';
import { pagePdfContradiction, type SourceSnapshot } from '../src/contradiction.js';

function snap(over: Partial<SourceSnapshot> & Pick<SourceSnapshot, 'sourceKind' | 'key'>): SourceSnapshot {
  return {
    docId: over.docId ?? `doc-${over.sourceKind}`,
    sourceKind: over.sourceKind,
    key: over.key,
    deadlineTs: over.deadlineTs ?? null,
    deadlineDate: over.deadlineDate ?? null,
    amountPaise: over.amountPaise ?? null,
  };
}

describe('pagePdfContradiction', () => {
  it('returns null when deadlines and amounts match or are missing', () => {
    expect(
      pagePdfContradiction(
        snap({ sourceKind: 'page', key: '0xa', deadlineTs: 100, deadlineDate: '2026-10-30', amountPaise: 150000 }),
        snap({ sourceKind: 'pdf', key: '0xb', deadlineTs: 100, deadlineDate: '2026-10-30', amountPaise: 150000 }),
      ),
    ).toBeNull();
    expect(
      pagePdfContradiction(
        snap({ sourceKind: 'page', key: '0xa', deadlineTs: 100 }),
        snap({ sourceKind: 'pdf', key: '0xb' }),
      ),
    ).toBeNull();
  });

  it('flags when deadlines differ with both entity keys and a badge', () => {
    const flag = pagePdfContradiction(
      snap({ sourceKind: 'page', key: '0xbb', deadlineTs: 200, deadlineDate: '2026-11-20', amountPaise: 1 }),
      snap({ sourceKind: 'pdf', key: '0xaa', deadlineTs: 100, deadlineDate: '2026-10-30', amountPaise: 1 }),
    );
    expect(flag).toMatchObject({
      kind: 'contradiction',
      severity: 2,
      entityKeys: ['0xaa', '0xbb'],
    });
    expect(flag?.details).toMatchObject({
      notice_badge: 'sources disagree: page says 2026-11-20, PDF says 2026-10-30',
    });
  });

  it('flags when amounts differ', () => {
    const flag = pagePdfContradiction(
      snap({ sourceKind: 'page', key: '0x1', amountPaise: 100 }),
      snap({ sourceKind: 'pdf', key: '0x2', amountPaise: 200 }),
    );
    expect(flag?.kind).toBe('contradiction');
    expect((flag?.details as { diffs: { field: string }[] }).diffs).toEqual([{ field: 'amount', page: 100, pdf: 200 }]);
  });
});
