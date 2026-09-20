import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { env } from '../../env.js';
import { logger } from '../../log.js';
import type { LlmProvider, ProviderRequest, ProviderResponse } from './types.js';

const log = logger('enrich:anthropic');

let clientRef: Anthropic | null = null;
function client(): Anthropic {
  if (!clientRef) clientRef = new Anthropic({ apiKey: env.anthropicApiKey });
  return clientRef;
}

/** What a caller gets when it does not size the ceiling itself. */
const DEFAULT_MAX_TOKENS = 8_000;

/**
 * Above this, the next thing to break is the SDK's HTTP timeout rather than
 * the model, so a long generation is streamed and reassembled. `finalMessage()`
 * returns the same parsed message `parse()` does, so nothing below cares which
 * path produced it.
 */
const STREAM_ABOVE = 16_000;

/**
 * What one response may contain, per tier. `max_tokens` is a ceiling and not a
 * spend - only the tokens actually generated are billed - but it is not free
 * to overstate either: it is what the output rate limit reserves per in-flight
 * call, so a stage running N at a time reserves N times this. Hence a caller
 * sizes it to its task and this only stops it exceeding the model.
 */
function outputCap(model: string): number {
  return model.startsWith('claude-haiku-') ? 64_000 : 128_000;
}

/**
 * Constrained decoding: the schema is enforced during sampling, so a
 * structurally wrong payload is not merely rejected - it cannot be generated.
 * No retry loop is needed here, which is why this file is the short one.
 */
export const anthropicProvider: LlmProvider = {
  name: 'anthropic',

  async complete<T>(request: ProviderRequest<T>): Promise<ProviderResponse<T>> {
    const maxTokens = Math.min(
      request.maxTokens ?? DEFAULT_MAX_TOKENS,
      outputCap(request.model),
    );

    const params = {
      model: request.model,
      max_tokens: maxTokens,
      system: request.system,
      output_config: {
        format: zodOutputFormat(request.schema),
        // `effort` is rejected by Haiku 4.5, so only send it on the escalation tier.
        ...(request.escalate ? { effort: 'medium' as const } : {}),
      },
      messages: [{ role: 'user' as const, content: request.user }],
    };

    const response =
      maxTokens > STREAM_ABOVE
        ? await client().messages.stream(params).finalMessage()
        : await client().messages.parse(params);

    if (response.stop_reason === 'max_tokens') {
      throw new Error(
        `response truncated at max_tokens (${maxTokens}) - the ceiling this call asked for ` +
          `is too low for what it sent`,
      );
    }
    if (!response.parsed_output) {
      throw new Error(`model returned unparseable output (stop_reason=${response.stop_reason})`);
    }

    log.debug(
      `${request.model}: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out ` +
        `(ceiling ${maxTokens})`,
    );
    // `zodOutputFormat` widens to the schema's own inferred type; the generic
    // is what the caller asked for and the SDK already validated against it.
    return { payload: response.parsed_output as T, model: request.model };
  },
};
