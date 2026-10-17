import { datesToTs, type Extraction } from './extract.js';

/** Model label recorded in observation payloads for rule-based extraction. */
export const RULES_MODEL = 'rules-v1';

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const MONTH_NAMES =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

/** One date in any of: 2026-10-30, 30 october 2026, 30 oct, 2026, 30/10/2026, 30-10-2026, 30.10.2026. */
const DATE_SRC = `(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_NAMES})\\.?,?\\s+\\d{4}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4})`;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Parses one date token (day-first for numeric dates) to YYYY-MM-DD, or null. */
export function parseDateToken(token: string): string | null {
  const t = token.toLowerCase().trim();
  let y: number;
  let m: number;
  let d: number;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?,?\s+(\d{4})$/.exec(t))) {
    const month = MONTHS[(match[2] ?? '').slice(0, match[2]?.startsWith('sept') ? 4 : 3)];
    if (month === undefined) return null;
    [y, m, d] = [Number(match[3]), month, Number(match[1])];
  } else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t))) {
    [y, m, d] = [Number(match[3]), Number(match[2]), Number(match[1])];
  } else {
    return null;
  }
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  try {
    return datesToTs(iso) >= 0 ? iso : null;
  } catch {
    return null;
  }
}

const DEADLINE_RE = new RegExp(
  `(?:last date|deadline|due date|closing date|apply by|on or before)[^.]{0,60}?${DATE_SRC}`,
  'i',
);
const PRINTED_RE = new RegExp(`(?<!last |due |closing )\\b(?:dated|date)\\b\\s*:?\\s*${DATE_SRC}`, 'i');
const AMOUNT_RE = /(?:\brs\.?|\binr\b|₹)\s*(\d[\d,]*(?:\.\d{1,2})?)/i;
const SUPERSEDES_RE = /(?:in supersession of|supersedes|replaces)\s+([^.]{3,160})/i;

/**
 * Deterministic extraction from normalized text, used when no LLM is configured or the LLM call
 * fails. It only fills fields it can find with simple patterns; everything else is null.
 */
export function heuristicExtract(text: string, title: string | null = null): Extraction {
  const deadline = DEADLINE_RE.exec(text)?.[1];
  const printed = PRINTED_RE.exec(text)?.[1];
  const amount = AMOUNT_RE.exec(text)?.[1];
  const amountInr = amount === undefined ? null : Number(amount.replace(/,/g, ''));
  const supersedes = SUPERSEDES_RE.exec(text)?.[1]?.trim() ?? null;
  return {
    title: title === null ? null : title.slice(0, 160),
    department: null,
    scheme: null,
    printed_date: printed === undefined ? null : parseDateToken(printed),
    deadline: deadline === undefined ? null : parseDateToken(deadline),
    amount_inr: amountInr !== null && Number.isFinite(amountInr) ? amountInr : null,
    declared_supersedes: supersedes,
    summary_en: 'fields extracted by rules',
    severity: 0,
    confidence: 0.3,
  };
}
