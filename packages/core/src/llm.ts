import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, LlmRequest } from './extract.js';

export const LLM_MAX_TOKENS = 1024;
export const LLM_TIMEOUT_MS = 60_000;

interface MessagesApi {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export interface AnthropicLlmOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Injected in tests; defaults to the real Anthropic client. */
  messages?: MessagesApi;
}

/** LlmClient backed by Anthropic structured outputs (`output_config.format`). */
export class AnthropicLlmClient implements LlmClient {
  readonly model: string;
  private readonly messages: MessagesApi;

  constructor(opts: AnthropicLlmOptions) {
    this.model = opts.model;
    this.messages =
      opts.messages ??
      new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? LLM_TIMEOUT_MS, maxRetries: 2 }).messages;
  }

  async completeJson(req: LlmRequest): Promise<string> {
    const res = await this.messages.create({
      model: this.model,
      max_tokens: LLM_MAX_TOKENS,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      output_config: { format: { type: 'json_schema', schema: req.jsonSchema } },
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }
}
