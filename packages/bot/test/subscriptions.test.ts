import { describe, expect, it } from 'vitest';
import { matchingChatIds, matchesSubscription, parseFollowArgs } from '../src/subscriptions.js';

describe('parseFollowArgs', () => {
  it('parses type and value', () => {
    expect(parseFollowArgs('department demo-dept')).toEqual({
      filterType: 'department',
      filterValue: 'demo-dept',
    });
    expect(parseFollowArgs('keyword last date')).toEqual({
      filterType: 'keyword',
      filterValue: 'last date',
    });
  });

  it('accepts a bare doc id', () => {
    const id = 'a'.repeat(64);
    expect(parseFollowArgs(id)).toEqual({ filterType: 'doc_id', filterValue: id });
  });

  it('rejects bad input', () => {
    expect(parseFollowArgs('')).toMatchObject({ error: expect.stringMatching(/Usage/i) });
    expect(parseFollowArgs('department')).toMatchObject({ error: expect.any(String) });
    expect(parseFollowArgs('doc_id not-hex')).toMatchObject({ error: expect.stringMatching(/hex/i) });
  });
});

describe('matchesSubscription', () => {
  const doc = {
    doc_id: 'a'.repeat(64),
    notice_id: 'demo-1',
    title: 'Synthetic Scholarship Notice',
    department: 'demo-dept',
    scheme: 'demo-merit',
    summary_en: 'deadline moved',
  };

  it('matches each filter type', () => {
    expect(matchesSubscription(doc, { filterType: 'department', filterValue: 'demo-dept' })).toBe(true);
    expect(matchesSubscription(doc, { filterType: 'scheme', filterValue: 'demo-merit' })).toBe(true);
    expect(matchesSubscription(doc, { filterType: 'doc_id', filterValue: doc.doc_id })).toBe(true);
    expect(matchesSubscription(doc, { filterType: 'keyword', filterValue: 'scholarship' })).toBe(true);
    expect(matchesSubscription(doc, { filterType: 'keyword', filterValue: 'nope' })).toBe(false);
  });

  it('collects matching chat ids', () => {
    expect(
      matchingChatIds(doc, [
        { chatId: 2, filterType: 'department', filterValue: 'demo-dept', createdTs: 1 },
        { chatId: 1, filterType: 'keyword', filterValue: 'nope', createdTs: 1 },
        { chatId: 2, filterType: 'scheme', filterValue: 'other', createdTs: 1 },
      ]),
    ).toEqual([2]);
  });
});
