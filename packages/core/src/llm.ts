import { z } from 'zod';
import type { LlmClient, LlmRequest } from './extract.js';

export const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const LLM_MAX_COMPLETION_TOKENS = 4096;
export const LLM_TIMEOUT_MS = 60_000;

export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`LLM request failed with HTTP ${status}: ${detail}`);
    this.name = 'LlmHttpError';
  }
}

const ChatResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional() }) })).min(1),
});

const ErrorResponse = z.object({ error: z.object({ message: z.string() }) });

export interface GroqLlmOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof fetch;
  url?: string;
}

/**
 * LlmClient for Groq's OpenAI-compatible chat completions API. Uses strict structured outputs
 * (`response_format.type = json_schema`), supported by openai/gpt-oss-20b and openai/gpt-oss-120b.
 */
export class GroqLlmClient implements LlmClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;

  constructor(opts: GroqLlmOptions) {
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS;
    this.fetchImpl = opts.fetch ?? fetch;
    this.url = opts.url ?? GROQ_CHAT_URL;
  }

  async completeJson(req: LlmRequest): Promise<string> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'notice_extraction', strict: true, schema: req.jsonSchema },
        },
        max_completion_tokens: LLM_MAX_COMPLETION_TOKENS,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = ErrorResponse.safeParse(body);
      throw new LlmHttpError(res.status, err.success ? err.data.error.message : res.statusText);
    }
    const parsed = ChatResponse.safeParse(body);
    if (!parsed.success) throw new LlmHttpError(res.status, 'unexpected response shape');
    return parsed.data.choices[0]?.message.content ?? '';
  }
}
