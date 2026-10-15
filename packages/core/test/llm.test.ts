import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { EXTRACTION_JSON_SCHEMA } from '../src/extract.js';
import { AnthropicLlmClient, LLM_MAX_TOKENS } from '../src/llm.js';

function fakeMessages(content: unknown[]) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    api: {
      async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
        calls.push(params);
        return { content } as unknown as Anthropic.Message;
      },
    },
  };
}

describe('AnthropicLlmClient', () => {
  it('sends a structured-output request and joins the text blocks', async () => {
    const m = fakeMessages([
      { type: 'thinking', thinking: 'ignored' },
      { type: 'text', text: '{"a":' },
      { type: 'text', text: '1}' },
    ]);
    const llm = new AnthropicLlmClient({ apiKey: 'test', model: 'claude-test', messages: m.api });
    const schema = EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>;

    expect(await llm.completeJson({ system: 'sys', user: 'usr', jsonSchema: schema })).toBe('{"a":1}');
    expect(llm.model).toBe('claude-test');
    expect(m.calls[0]).toEqual({
      model: 'claude-test',
      max_tokens: LLM_MAX_TOKENS,
      system: 'sys',
      messages: [{ role: 'user', content: 'usr' }],
      output_config: { format: { type: 'json_schema', schema } },
    });
  });

  it('constructs a real client when none is injected', () => {
    expect(new AnthropicLlmClient({ apiKey: 'test', model: 'm' }).model).toBe('m');
  });
});
