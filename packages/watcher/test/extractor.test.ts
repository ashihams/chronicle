import { RULES_MODEL, type LlmClient } from '@chronicle/core';
import { describe, expect, it } from 'vitest';
import { createExtractor, type ExtractorInput } from '../src/extractor.js';

const INPUT: ExtractorInput = {
  text: 'circular no. syn/1 date: 1 october 2026 last date to apply: 30 october 2026 amount: rs. 1,500 per month',
  title: 'Synthetic notice',
  kind: 'page',
  diffHunks: [],
  previousFields: null,
};

const LLM_OUTPUT = {
  title: 'Synthetic notice',
  department: 'synthetic-dept',
  scheme: null,
  printed_date: '2026-10-01',
  deadline: '2026-11-15',
  amount_inr: 2000,
  declared_supersedes: null,
  summary_en: 'The deadline moved to 15 November 2026.',
  severity: 2,
  confidence: 0.9,
};

function llm(reply: () => Promise<string>): LlmClient & { calls: number } {
  const client = {
    model: 'stub-model',
    calls: 0,
    async completeJson(): Promise<string> {
      client.calls += 1;
      return reply();
    },
  };
  return client;
}

describe('createExtractor', () => {
  it('uses rules when no LLM is configured', async () => {
    const res = await createExtractor(null).extract(INPUT);
    expect(res.usedLlm).toBe(false);
    expect(res.model).toBe(RULES_MODEL);
    expect(res.extraction).toMatchObject({ deadline: '2026-10-30', printed_date: '2026-10-01', amount_inr: 1500 });
  });

  it('uses the LLM when it answers', async () => {
    const client = llm(async () => JSON.stringify(LLM_OUTPUT));
    const res = await createExtractor(client).extract(INPUT);
    expect(res).toMatchObject({ usedLlm: true, model: 'stub-model' });
    expect(res.extraction.deadline).toBe('2026-11-15');
    expect(client.calls).toBe(1);
  });

  it('falls back to rules when the LLM fails twice', async () => {
    const client = llm(async () => {
      throw new Error('http 500');
    });
    const res = await createExtractor(client).extract(INPUT);
    expect(client.calls).toBe(2);
    expect(res).toMatchObject({ usedLlm: false, model: RULES_MODEL });
    expect(res.extraction.deadline).toBe('2026-10-30');
  });

  it('skips the LLM for empty text (a scanned PDF)', async () => {
    const client = llm(async () => JSON.stringify(LLM_OUTPUT));
    const res = await createExtractor(client).extract({ ...INPUT, text: '', kind: 'pdf' });
    expect(client.calls).toBe(0);
    expect(res.usedLlm).toBe(false);
    expect(res.extraction.deadline).toBeNull();
  });
});
