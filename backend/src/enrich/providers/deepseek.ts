import OpenAI from 'openai';
import * as z from 'zod/v4';
import { env } from '../../env.js';
import { logger } from '../../log.js';
import type { LlmProvider, ProviderRequest, ProviderResponse } from './types.js';

const log = logger('enrich:deepseek');

let clientRef: OpenAI | null = null;
function client(): OpenAI {
  if (!clientRef) {
    clientRef = new OpenAI({ apiKey: env.deepseekApiKey, baseURL: env.deepseekBaseUrl });
  }
  return clientRef;
}

/**
 * DeepSeek's OpenAI-compatible endpoint offers `json_object` only: it
 * guarantees parseable JSON, NOT our schema. So the guarantee Anthropic gives
 * us during sampling has to be rebuilt here, after the fact:
 *
 *   1. state the schema in the prompt (the model cannot be constrained to it)
 *   2. parse + validate every response ourselves
 *   3. retry, because 1 and 2 are best-effort rather than enforced
 *
 * DeepSeek also documents that json_object "may occasionally return empty
 * content", which is a transient fault rather than a bad recipe - hence the
 * retry rather than a hard failure on the first empty body.
 */
const MAX_ATTEMPTS = 3;

// Rendering a schema to JSON Schema is pure and the set of schemas is tiny and
// long-lived, so it is computed once per schema rather than once per call.
const schemaJson = new WeakMap<object, string>();

function schemaInstruction(schema: z.ZodType<unknown>): string {
  let json = schemaJson.get(schema);
  if (!json) {
    json = JSON.stringify(z.toJSONSchema(schema));
    schemaJson.set(schema, json);
  }
  return [
    '',
    'Respond with a single JSON object and nothing else - no prose, no markdown fence.',
    'It must conform to this JSON Schema:',
    json,
  ].join('\n');
}

export const deepseekProvider: LlmProvider = {
  name: 'deepseek',

  async complete<T>(request: ProviderRequest<T>): Promise<ProviderResponse<T>> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await client().chat.completions.create({
          model: request.model,
          max_tokens: 8000,
          // Deterministic-ish: this is an extraction task, not a creative one.
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: request.system + schemaInstruction(request.schema) },
            { role: 'user', content: request.user },
          ],
        });

        const choice = response.choices[0];
        if (choice?.finish_reason === 'length') {
          // Not retryable: a longer recipe will truncate again on every attempt.
          throw new Error('response truncated at max_tokens - input too long for one call');
        }

        const raw = choice?.message?.content?.trim();
        if (!raw) throw new RetryableError('model returned empty content');

        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          throw new RetryableError('model returned non-JSON content');
        }

        const parsed = request.schema.safeParse(json);
        if (!parsed.success) {
          throw new RetryableError(`payload failed schema: ${parsed.error.issues[0]?.message}`);
        }

        if (response.usage) {
          log.debug(
            `${request.model}: ${response.usage.prompt_tokens} in / ${response.usage.completion_tokens} out (attempt ${attempt})`,
          );
        }
        return { payload: parsed.data, model: request.model };
      } catch (error) {
        if (!(error instanceof RetryableError)) throw error;
        lastError = error;
        log.debug(`attempt ${attempt}/${MAX_ATTEMPTS} failed: ${error.message}`);
        if (attempt < MAX_ATTEMPTS) await sleep(500 * attempt);
      }
    }

    throw new Error(`deepseek call failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message}`);
  },
};

/** Marks the faults that a second sampling pass can plausibly fix. */
class RetryableError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
