import { describe, expect, it } from 'vitest';
import {
  buildExtractionUserMessage,
  datesToTs,
  extractFields,
  EXTRACTION_SYSTEM_PROMPT,
  ExtractionSchema,
  FAILED_EXTRACTION,
  fieldsFromExtraction,
  inrToPaise,
  MAX_LLM_INPUT_CHARS,
  parseExtraction,
  tsToIstDate,
  type LlmClient,
  type LlmRequest,
} from '../src/extract.js';

const GOOD = {
  title: 'Synthetic Scholarship Notice 2026',
  department: 'demo-department',
  scheme: 'demo-merit',
  printed_date: '2026-10-01',
  deadline: '2026-10-30',
  amount_inr: 1500,
  declared_supersedes: null,
  summary_en: 'The application deadline moved from 30 October to 20 October 2026.',
  summary_ta: 'விண்ணப்பக் கடைசி நாள் 30 அக்டோபரிலிருந்து 20 அக்டோபர் 2026 ஆக மாறியது.',
  summary_hi: 'आवेदन की अंतिम तिथि 30 अक्टूबर से 20 अक्टूबर 2026 हो गई।',
  severity: 2,
  confidence: 0.9,
};

class StubLlm implements LlmClient {
  readonly model = 'stub-model';
  readonly requests: LlmRequest[] = [];
  constructor(private readonly replies: (string | Error)[]) {}
  async completeJson(req: LlmRequest): Promise<string> {
    this.requests.push(req);
    const r = this.replies.shift();
    if (r === undefined) throw new Error('no more replies');
    if (r instanceof Error) throw r;
    return r;
  }
}

describe('datesToTs', () => {
  it('returns 00:00 IST in unix seconds', () => {
    expect(datesToTs('2026-10-30')).toBe(Date.UTC(2026, 9, 29, 18, 30) / 1000);
    expect(datesToTs('1970-01-02')).toBe(86400 - 19800);
  });

  it.each(['2026-02-30', '2026-13-01', '30-10-2026', '2026-1-5', ''])('rejects %s', (s) => {
    expect(() => datesToTs(s)).toThrow(RangeError);
  });

  it('round-trips with tsToIstDate', () => {
    expect(tsToIstDate(datesToTs('2026-10-30'))).toBe('2026-10-30');
    expect(tsToIstDate(datesToTs('2026-10-30') + 86399)).toBe('2026-10-30');
    expect(tsToIstDate(datesToTs('2026-10-30') - 1)).toBe('2026-10-29');
  });
});

describe('inrToPaise', () => {
  it.each([
    [1500, 150000],
    [0, 0],
    [1.005, 101],
    [19.99, 1999],
    [0.1 + 0.2, 30],
    [1234567.89, 123456789],
  ])('%s rupees is %s paise', (inr, paise) => {
    expect(inrToPaise(inr)).toBe(paise);
  });

  it.each([-1, NaN, Infinity])('rejects %s', (n) => {
    expect(() => inrToPaise(n)).toThrow(RangeError);
  });
});

describe('ExtractionSchema / parseExtraction', () => {
  it('accepts a valid object', () => {
    expect(parseExtraction(JSON.stringify(GOOD))).toEqual(GOOD);
  });

  it('tolerates a code fence and surrounding text', () => {
    expect(parseExtraction('Here:\n```json\n' + JSON.stringify(GOOD) + '\n```')).toEqual(GOOD);
  });

  it('returns null for malformed JSON or no object', () => {
    expect(parseExtraction('{"title": "x",')).toBeNull();
    expect(parseExtraction('no json here')).toBeNull();
    expect(parseExtraction('} {')).toBeNull();
  });

  it('returns null when required fields are wrong', () => {
    expect(parseExtraction(JSON.stringify({ ...GOOD, severity: 5 }))).toBeNull();
    expect(parseExtraction(JSON.stringify({ ...GOOD, summary_en: '   ' }))).toBeNull();
    expect(parseExtraction(JSON.stringify({ ...GOOD, confidence: 'high' }))).toBeNull();
  });

  it('turns bad optional values into null instead of failing', () => {
    const r = ExtractionSchema.parse({
      ...GOOD,
      printed_date: '01/10/2026',
      deadline: '2026-02-30',
      amount_inr: -5,
      department: '!!!',
      title: '  ',
    });
    expect(r).toMatchObject({ printed_date: null, deadline: null, amount_inr: null, department: null, title: null });
  });

  it('rejects dates before 1970', () => {
    expect(ExtractionSchema.parse({ ...GOOD, printed_date: '1969-12-31' }).printed_date).toBeNull();
  });

  it('normalizes slugs, truncates summary and clamps confidence', () => {
    const r = ExtractionSchema.parse({
      ...GOOD,
      department: 'Department of Higher Education',
      summary_en: 's'.repeat(400),
      confidence: 1.7,
    });
    expect(r.department).toBe('department-of-higher-education');
    expect(r.summary_en).toHaveLength(240);
    expect(r.confidence).toBe(1);
  });
});

describe('extractFields', () => {
  const input = { text: 'notice text', diffHunks: [{ op: '+' as const, text: 'new' }], kind: 'page' as const };

  it('returns the parsed extraction on the first try', async () => {
    const llm = new StubLlm([JSON.stringify(GOOD)]);
    expect(await extractFields(llm, input)).toEqual(GOOD);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.system).toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(llm.requests[0]?.jsonSchema).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('retries once after malformed JSON', async () => {
    const llm = new StubLlm(['{"title": ', JSON.stringify(GOOD)]);
    expect(await extractFields(llm, input)).toEqual(GOOD);
    expect(llm.requests).toHaveLength(2);
  });

  it('retries once after a failed call', async () => {
    const llm = new StubLlm([new Error('overloaded'), JSON.stringify(GOOD)]);
    expect(await extractFields(llm, input)).toEqual(GOOD);
  });

  it('returns the failure result after two bad answers and never throws', async () => {
    const llm = new StubLlm(['nope', JSON.stringify({ ...GOOD, severity: 9 }), JSON.stringify(GOOD)]);
    const r = await extractFields(llm, input);
    expect(r).toEqual(FAILED_EXTRACTION);
    expect(r.summary_en).toBe('extraction failed');
    expect(r.confidence).toBe(0);
    expect(llm.requests).toHaveLength(2);
    await expect(extractFields(new StubLlm([]), input)).resolves.toEqual(FAILED_EXTRACTION);
  });

  it('sends kind, truncated text, diff hunks and previous fields', () => {
    const msg = JSON.parse(
      buildExtractionUserMessage({ ...input, kind: 'pdf', text: 'y'.repeat(20_000), previousFields: null }),
    ) as Record<string, unknown>;
    expect(msg.kind).toBe('pdf');
    expect(msg.text).toHaveLength(MAX_LLM_INPUT_CHARS);
    expect(msg.diff_hunks).toEqual([{ op: '+', text: 'new' }]);
    expect(msg.previous_fields).toBeNull();
  });
});

describe('fieldsFromExtraction', () => {
  it('converts dates to IST timestamps and rupees to paise', () => {
    expect(fieldsFromExtraction(GOOD as never)).toEqual({
      title: GOOD.title,
      department: 'demo-department',
      scheme: 'demo-merit',
      printed_date_ts: datesToTs('2026-10-01'),
      deadline_ts: datesToTs('2026-10-30'),
      deadline_date: '2026-10-30',
      amount_paise: 150000,
      declared_supersedes: null,
      summary_en: GOOD.summary_en,
    });
  });

  it('keeps nulls', () => {
    const f = fieldsFromExtraction(FAILED_EXTRACTION);
    expect(f).toMatchObject({ printed_date_ts: null, deadline_ts: null, deadline_date: null, amount_paise: null });
  });
});
