import {
  FAILED_EXTRACTION,
  RULES_MODEL,
  extractFields,
  heuristicExtract,
  type DiffHunk,
  type Extraction,
  type LlmClient,
  type NoticeFields,
  type SourceKind,
} from '@chronicle/core';

export interface ExtractorInput {
  text: string;
  title: string | null;
  kind: SourceKind;
  diffHunks: DiffHunk[];
  previousFields: NoticeFields | null;
}

export interface ExtractorResult {
  extraction: Extraction;
  model: string;
  /** True when the fields (and severity, summary) came from the LLM. */
  usedLlm: boolean;
}

export interface Extractor {
  extract(input: ExtractorInput): Promise<ExtractorResult>;
}

function isFailed(ex: Extraction): boolean {
  return ex.confidence === 0 && ex.summary_en === FAILED_EXTRACTION.summary_en;
}

/**
 * Uses the LLM when one is configured, and the rule-based extractor when it is not, when the text
 * is empty (scanned PDF), or when the LLM fails twice.
 */
export function createExtractor(llm: LlmClient | null): Extractor {
  return {
    async extract(input) {
      if (llm !== null && input.text !== '') {
        const ex = await extractFields(llm, {
          text: input.text,
          diffHunks: input.diffHunks,
          kind: input.kind,
          previousFields: input.previousFields,
        });
        if (!isFailed(ex)) return { extraction: ex, model: llm.model, usedLlm: true };
      }
      return { extraction: heuristicExtract(input.text, input.title), model: RULES_MODEL, usedLlm: false };
    },
  };
}
