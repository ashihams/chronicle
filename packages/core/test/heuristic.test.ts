import { describe, expect, it } from 'vitest';
import { heuristicExtract, parseDateToken } from '../src/heuristic.js';

describe('parseDateToken', () => {
  it.each([
    ['2026-10-30', '2026-10-30'],
    ['30 october 2026', '2026-10-30'],
    ['30 Oct 2026', '2026-10-30'],
    ['1st november, 2026', '2026-11-01'],
    ['5 sept 2026', '2026-09-05'],
    ['30 oct. 2026', '2026-10-30'],
    ['30/10/2026', '2026-10-30'],
    ['3-1-2026', '2026-01-03'],
    ['30.10.2026', '2026-10-30'],
  ])('%s -> %s', (input, iso) => {
    expect(parseDateToken(input)).toBe(iso);
  });

  it.each(['31/02/2026', '30 smarch 2026', '2026/10/30', '01/01/1960', 'soon'])('rejects %s', (input) => {
    expect(parseDateToken(input)).toBeNull();
  });
});

describe('heuristicExtract', () => {
  const text =
    'demonstration: synthetic notice. circular no. demo/2026/01 date: 1 october 2026 department: demo. ' +
    'the scheme is open. last date to apply: 30 october 2026 amount: rs. 1,500 per month';

  it('finds the deadline, printed date and amount', () => {
    expect(heuristicExtract(text, 'Demo notice')).toMatchObject({
      title: 'Demo notice',
      printed_date: '2026-10-01',
      deadline: '2026-10-30',
      amount_inr: 1500,
      declared_supersedes: null,
      severity: 0,
    });
  });

  it('does not take the deadline as the printed date', () => {
    const r = heuristicExtract('last date: 30 october 2026. amount ₹ 2,50,000.50');
    expect(r.printed_date).toBeNull();
    expect(r.deadline).toBe('2026-10-30');
    expect(r.amount_inr).toBe(250000.5);
  });

  it('reads PDF-style numeric dates and supersession notes', () => {
    const r = heuristicExtract(
      'no. demo/2026/01 dated 01/10/2026. this circular is issued in supersession of circular 14/2026 dated 02/09/2026. ' +
        'the last date for receipt of applications is 20/10/2026. the amount payable is inr 4000 per month.',
    );
    expect(r).toMatchObject({
      printed_date: '2026-10-01',
      deadline: '2026-10-20',
      amount_inr: 4000,
      declared_supersedes: 'circular 14/2026 dated 02/09/2026',
    });
  });

  it('does not read "rs" inside a word as rupees', () => {
    expect(heuristicExtract('office hours 10 to 5').amount_inr).toBeNull();
  });

  it('returns nulls when nothing matches', () => {
    expect(heuristicExtract('nothing useful here')).toMatchObject({
      title: null,
      printed_date: null,
      deadline: null,
      amount_inr: null,
      confidence: 0.3,
    });
  });
});
