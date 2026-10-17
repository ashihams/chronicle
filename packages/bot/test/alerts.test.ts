import { describe, expect, it } from 'vitest';
import { decideAlertStage, formatAlertMessage, timelineUrl } from '../src/alerts.js';

describe('decideAlertStage', () => {
  it('returns confirmed when 2+ observers agree', () => {
    expect(decideAlertStage({ severity: 1, observerCount: 2 })).toBe('confirmed');
    expect(decideAlertStage({ severity: 3, observerCount: 2 })).toBe('confirmed');
  });

  it('returns unconfirmed for severity >= 2 with one watcher', () => {
    expect(decideAlertStage({ severity: 2, observerCount: 1 })).toBe('unconfirmed');
    expect(decideAlertStage({ severity: 1, observerCount: 1 })).toBeNull();
  });
});

describe('formatAlertMessage', () => {
  it('formats UNCONFIRMED and CONFIRMED without logging secrets', () => {
    const base = {
      department: 'demo-dept',
      title: 'Synthetic Notice',
      changeLine: 'deadline 15 Nov -> 30 Oct',
      severity: 2,
      observerCount: 1,
      firstSeenTs: 1_760_000_000,
      timelineUrl: 'http://localhost:8080/docs/abc',
    };
    const u = formatAlertMessage({ ...base, stage: 'unconfirmed' });
    expect(u).toMatch(/^UNCONFIRMED: 1 watcher reports a change/);
    expect(u).toContain('Chronicle alert: demo-dept - Synthetic Notice');
    expect(u).toContain('Change: deadline 15 Nov -> 30 Oct (severity 2)');
    expect(u).toContain('Timeline: http://localhost:8080/docs/abc');

    const c = formatAlertMessage({ ...base, stage: 'confirmed', observerCount: 2 });
    expect(c).toMatch(/^CONFIRMED: 2\+ distinct creators agree/);
    expect(c).toContain('Seen by: 2 watchers');
  });

  it('builds timeline urls', () => {
    expect(timelineUrl('http://localhost:8080/', 'aa')).toBe('http://localhost:8080/docs/aa');
  });
});
