import { z } from 'zod';
import type { DiffHunk } from './diff.js';
import type { SourceKind } from './states.js';

export const MAX_SUMMARY_CHARS = 240;
export const MAX_LLM_INPUT_CHARS = 12_000;
export const IST_OFFSET_SECONDS = 5 * 3600 + 30 * 60;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Unix seconds of 00:00 IST on a YYYY-MM-DD date. Throws on a malformed or impossible date. */
export function datesToTs(dateStr: string): number {
  const m = ISO_DATE_RE.exec(dateStr);
  if (!m) throw new RangeError(`"${dateStr}" is not a YYYY-MM-DD date`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utcMs = Date.UTC(y, mo - 1, d);
  const check = new Date(utcMs);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new RangeError(`"${dateStr}" is not a real date`);
  }
  return utcMs / 1000 - IST_OFFSET_SECONDS;
}

/** The IST calendar date (YYYY-MM-DD) that contains the given unix time. */
export function tsToIstDate(ts: number): string {
  return new Date((ts + IST_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
}

/** Rupees to integer paise. `toPrecision` removes float noise such as 1.005 * 100 = 100.4999… */
export function inrToPaise(n: number): number {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`amount must be a non-negative number, got ${n}`);
  return Math.round(Number((n * 100).toPrecision(15)));
}

/** Valid and not before 1970, because timestamps are stored as u64. */
function isValidIsoDate(s: string): boolean {
  try {
    return datesToTs(s) >= 0;
  } catch {
    return false;
  }
}

const isoDateOrNull = z.string().refine(isValidIsoDate).nullable().catch(null);
const slugOrNull = z
  .string()
  .transform((s) =>
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64),
  )
  .nullable()
  .transform((s) => (s === '' ? null : s))
  .catch(null);
const shortTextOrNull = (max: number) =>
  z
    .string()
    .transform((s) => s.replace(/\s+/g, ' ').trim().slice(0, max))
    .nullable()
    .transform((s) => (s === '' ? null : s))
    .catch(null);

/**
 * What the LLM must return (Appendix B). Strict on types and severity; lenient where a bad value
 * can safely become null (dates, slugs, amounts) so one bad field does not discard the rest.
 */
export const ExtractionSchema = z.object({
  title: shortTextOrNull(160),
  department: slugOrNull,
  scheme: slugOrNull,
  printed_date: isoDateOrNull,
  deadline: isoDateOrNull,
  amount_inr: z.number().finite().nonnegative().nullable().catch(null),
  declared_supersedes: shortTextOrNull(160),
  summary_en: z
    .string()
    .transform((s) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_CHARS))
    .pipe(z.string().min(1)),
  /** Stretch S6: machine-generated Tamil / Hindi; null when the model cannot produce them. */
  summary_ta: shortTextOrNull(MAX_SUMMARY_CHARS * 2),
  summary_hi: shortTextOrNull(MAX_SUMMARY_CHARS * 2),
  severity: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  confidence: z
    .number()
    .finite()
    .transform((n) => Math.min(1, Math.max(0, n))),
});
export type Extraction = z.output<typeof ExtractionSchema>;

/** JSON Schema sent to the model for structured output. Range limits are enforced by zod. */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title',
    'department',
    'scheme',
    'printed_date',
    'deadline',
    'amount_inr',
    'declared_supersedes',
    'summary_en',
    'summary_ta',
    'summary_hi',
    'severity',
    'confidence',
  ],
  properties: {
    title: { type: ['string', 'null'] },
    department: { type: ['string', 'null'] },
    scheme: { type: ['string', 'null'] },
    printed_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    deadline: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    amount_inr: { type: ['number', 'null'] },
    declared_supersedes: { type: ['string', 'null'] },
    summary_en: { type: 'string', description: 'one sentence, at most 240 characters' },
    summary_ta: {
      type: ['string', 'null'],
      description: 'Tamil translation of summary_en, at most 480 characters; null if unavailable',
    },
    summary_hi: {
      type: ['string', 'null'],
      description: 'Hindi translation of summary_en, at most 480 characters; null if unavailable',
    },
    severity: { type: 'integer', enum: [0, 1, 2, 3] },
    confidence: { type: 'number', description: '0.0 to 1.0' },
  },
} as const;

export const EXTRACTION_SYSTEM_PROMPT = `You extract structured facts from an official public notice for a change-monitoring registry.
Return ONLY a JSON object matching the schema. No markdown, no commentary.
Rules:
- Use only information present in the provided text. If a field is absent, use null.
- Dates must be ISO YYYY-MM-DD. If the text gives a date in another format, convert it. If ambiguous, use null.
- amount_inr is a number in rupees (no symbols, no commas). If several amounts appear, use the main sanctioned/benefit/fee amount; else null.
- declared_supersedes: copy a short reference if the notice says it replaces or supersedes another notice (for example "Circular No. 14/2026 dated 2026-09-02"); else null.
- summary_en: one neutral sentence (max 240 characters) describing what changed, based on the diff hunks when provided, otherwise what the notice is about. Do not speculate about reasons or intent.
- summary_ta: the same meaning as summary_en in Tamil (max 480 characters). If you cannot produce Tamil, use null.
- summary_hi: the same meaning as summary_en in Hindi (max 480 characters). If you cannot produce Hindi, use null.
- severity: 0 cosmetic, 1 wording change, 2 change to a deadline, amount, eligibility or obligation, 3 removal of a clause or the whole notice.
- confidence: 0.0-1.0, your confidence in the extracted fields.
- department and scheme: short lowercase slugs from the text, else null.
- Never output personal names or contact details.`;

export interface LlmRequest {
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
}

/** Minimal LLM surface so tests can use a stub. Returns the model's raw text. */
export interface LlmClient {
  readonly model: string;
  completeJson(req: LlmRequest): Promise<string>;
}

/** Fields derived from an extraction, in the units stored on Arkiv and in watcher state. */
export interface NoticeFields {
  title: string | null;
  department: string | null;
  scheme: string | null;
  printed_date_ts: number | null;
  deadline_ts: number | null;
  deadline_date: string | null;
  amount_paise: number | null;
  declared_supersedes: string | null;
  summary_en: string;
}

export interface ExtractInput {
  text: string;
  diffHunks: DiffHunk[];
  kind: SourceKind;
  previousFields?: NoticeFields | null;
}

export const FAILED_EXTRACTION: Extraction = Object.freeze({
  title: null,
  department: null,
  scheme: null,
  printed_date: null,
  deadline: null,
  amount_inr: null,
  declared_supersedes: null,
  summary_en: 'extraction failed',
  summary_ta: null,
  summary_hi: null,
  severity: 0,
  confidence: 0,
});

export function buildExtractionUserMessage(input: ExtractInput): string {
  return JSON.stringify({
    kind: input.kind,
    text: input.text.slice(0, MAX_LLM_INPUT_CHARS),
    diff_hunks: input.diffHunks,
    previous_fields: input.previousFields ?? null,
  });
}

/** Parses model output, tolerating a ```json fence or text around the object. */
export function parseExtraction(raw: string): Extraction | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = ExtractionSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * Asks the LLM for structured fields. Retries once on invalid output or a failed call, then
 * returns FAILED_EXTRACTION. Never throws.
 */
export async function extractFields(llm: LlmClient, input: ExtractInput): Promise<Extraction> {
  const req: LlmRequest = {
    system: EXTRACTION_SYSTEM_PROMPT,
    user: buildExtractionUserMessage(input),
    jsonSchema: EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parsed = parseExtraction(await llm.completeJson(req));
      if (parsed) return parsed;
    } catch {
      // counted as a failed attempt
    }
  }
  return { ...FAILED_EXTRACTION };
}

export function fieldsFromExtraction(ex: Extraction): NoticeFields {
  const deadlineTs = ex.deadline === null ? null : datesToTs(ex.deadline);
  return {
    title: ex.title,
    department: ex.department,
    scheme: ex.scheme,
    printed_date_ts: ex.printed_date === null ? null : datesToTs(ex.printed_date),
    deadline_ts: deadlineTs,
    deadline_date: ex.deadline,
    amount_paise: ex.amount_inr === null ? null : inrToPaise(ex.amount_inr),
    declared_supersedes: ex.declared_supersedes,
    summary_en: ex.summary_en,
  };
}
