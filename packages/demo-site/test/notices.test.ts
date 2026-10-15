import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { DemoState, isIsoDate, seedNotices, shiftDate } from '../src/notices.js';
import { formatDateDmy, winAnsiSafe, wrapText } from '../src/pdf.js';
import { escapeHtml, formatDate, formatInr, formatIstTime } from '../src/render.js';

describe('dates', () => {
  it('validates ISO dates', () => {
    expect(isIsoDate('2026-10-30')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-1-01')).toBe(false);
  });

  it('shifts dates across month and year boundaries', () => {
    expect(shiftDate('2026-01-10', -45)).toBe('2025-11-26');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('formats dates for HTML and PDF', () => {
    expect(formatDate('2026-10-30')).toBe('30 October 2026');
    expect(formatDateDmy('2026-10-30')).toBe('30/10/2026');
  });

  it('formats IST time without periods', () => {
    const s = formatIstTime(Date.UTC(2026, 9, 15, 19, 11, 12) / 1000);
    expect(s).toBe('16 Oct 2026, 00:41:12');
    expect(s).not.toContain('.');
  });
});

describe('formatting helpers', () => {
  it('uses Indian digit grouping', () => {
    expect(formatInr(1500)).toBe('1,500');
    expect(formatInr(2500000)).toBe('25,00,000');
  });

  it('escapes HTML', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&#60;a href=&#34;x&#34;&#62;&#39;&#38;&#39;&#60;/a&#62;');
  });

  it('keeps PDF text within WinAnsi', () => {
    expect(winAnsiSafe('Amount ₹ 500 – café\nnext')).toBe('Amount ? 500 ? café next');
  });

  it('wraps long text to the width', async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const lines = wrapText('word '.repeat(60).trim(), font, 11, 200);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(font.widthOfTextAtSize(l, 11)).toBeLessThanOrEqual(200);
  });
});

describe('DemoState', () => {
  it('seeds three synthetic notices', () => {
    const notices = seedNotices(1);
    expect(notices.map((n) => n.id)).toEqual(['001', '002', '003']);
    expect(new Set(notices.map((n) => n.department)).size).toBe(3);
    for (const n of notices) expect(n.department).toMatch(/Synthetic/);
  });

  it('counts visitors and resets', () => {
    const s = new DemoState(() => 1);
    const a = s.nextVisitor();
    expect(s.nextVisitor()).toBe(a + 1);
    s.reset();
    expect(s.nextVisitor()).toBe(a);
  });

  it('gives each notice its own vantage list', () => {
    const s = new DemoState(() => 1);
    s.mutate({ id: '001', action: 'hide_from_vantage', value: 'eu-vps' });
    expect(s.get('002')?.hiddenFromVantages).toEqual([]);
  });

  it('returns copies so callers cannot change state', () => {
    const s = new DemoState(() => 1);
    const n = s.mutate({ id: '001', action: 'delist' });
    n.delisted = false;
    expect(s.get('001')?.delisted).toBe(true);
    const snap = s.snapshot();
    snap.notices[0]!.title = 'changed';
    expect(s.get('001')?.title).not.toBe('changed');
  });

  it('only content edits update updatedAt', () => {
    let t = 100;
    const s = new DemoState(() => t);
    t = 200;
    s.mutate({ id: '001', action: 'remove_404' });
    expect(s.get('001')?.updatedAt).toBe(100);
    s.mutate({ id: '001', action: 'edit_amount', value: '2000' });
    expect(s.get('001')?.updatedAt).toBe(200);
  });
});
