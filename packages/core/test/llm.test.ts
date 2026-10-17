import { describe, expect, it } from 'vitest';
import { EXTRACTION_JSON_SCHEMA } from '../src/extract.js';
import { GROQ_CHAT_URL, GroqLlmClient, LLM_MAX_COMPLETION_TOKENS, LlmHttpError } from '../src/llm.js';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, impl };
}

const schema = EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>;
const req = { system: 'sys', user: 'usr', jsonSchema: schema };

describe('GroqLlmClient', () => {
  it('sends a strict structured-output request and returns the message content', async () => {
    const f = fakeFetch(200, { choices: [{ message: { role: 'assistant', content: '{"a":1}' } }] });
    const llm = new GroqLlmClient({ apiKey: 'test-key', model: 'openai/gpt-oss-120b', fetch: f.impl });

    expect(await llm.completeJson(req)).toBe('{"a":1}');
    expect(llm.model).toBe('openai/gpt-oss-120b');
    expect(f.calls[0]?.url).toBe(GROQ_CHAT_URL);
    expect(f.calls[0]?.init.method).toBe('POST');
    expect((f.calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'notice_extraction', strict: true, schema },
      },
      max_completion_tokens: LLM_MAX_COMPLETION_TOKENS,
      temperature: 0,
    });
  });

  it('returns an empty string when the content is null', async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: null } }] });
    expect(await new GroqLlmClient({ apiKey: 'k', model: 'm', fetch: f.impl }).completeJson(req)).toBe('');
  });

  it('throws LlmHttpError with the API error message', async () => {
    const f = fakeFetch(400, { error: { message: 'json_schema not supported for this model' } });
    const llm = new GroqLlmClient({ apiKey: 'k', model: 'm', fetch: f.impl });
    await expect(llm.completeJson(req)).rejects.toThrow(/HTTP 400: json_schema not supported/);
  });

  it('throws on a non-JSON error body', async () => {
    const f = fakeFetch(502, 'Bad Gateway');
    await expect(
      new GroqLlmClient({ apiKey: 'k', model: 'm', fetch: f.impl }).completeJson(req),
    ).rejects.toBeInstanceOf(LlmHttpError);
  });

  it('throws on an unexpected success body', async () => {
    const f = fakeFetch(200, { choices: [] });
    await expect(new GroqLlmClient({ apiKey: 'k', model: 'm', fetch: f.impl }).completeJson(req)).rejects.toThrow(
      /unexpected response shape/,
    );
  });

  it('uses global fetch by default', () => {
    expect(new GroqLlmClient({ apiKey: 'k', model: 'm' }).model).toBe('m');
  });
});
