import { normalizePdf } from '@chronicle/core';
import { describe, expect, it } from 'vitest';
import { DemoState } from '../src/notices.js';
import { renderNoticePdf } from '../src/pdf.js';
import { renderNotice } from '../src/render.js';

describe('edit_deadline target (stretch S1)', () => {
  it('updates page only, pdf only, or both', async () => {
    const state = new DemoState(() => 1_800_000_000);
    const both = state.mutate({ id: '001', action: 'edit_deadline', value: '2026-11-01', target: 'both' });
    expect(both.deadline).toBe('2026-11-01');
    expect(both.deadlinePdf).toBe('2026-11-01');

    state.mutate({ id: '001', action: 'edit_deadline', value: '2026-11-20', target: 'page' });
    const afterPage = state.get('001')!;
    expect(afterPage.deadline).toBe('2026-11-20');
    expect(afterPage.deadlinePdf).toBe('2026-11-01');

    state.mutate({ id: '001', action: 'edit_deadline', value: '2026-12-15', target: 'pdf' });
    const afterPdf = state.get('001')!;
    expect(afterPdf.deadline).toBe('2026-11-20');
    expect(afterPdf.deadlinePdf).toBe('2026-12-15');

    const html = renderNotice(afterPdf, { visitors: 1, now: 1_800_000_000 });
    expect(html).toMatch(/20 November 2026/);
    expect(html).not.toMatch(/15 December 2026/);

    const pdf = await normalizePdf(await renderNoticePdf(afterPdf));
    expect(pdf.text).toMatch(/15\/12\/2026/);
    expect(pdf.text).not.toMatch(/20\/11\/2026/);
  });
});
