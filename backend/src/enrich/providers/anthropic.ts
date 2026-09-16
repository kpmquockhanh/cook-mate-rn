import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { env } from '../../env.js';
import { logger } from '../../log.js';
import { EnrichmentSchema } from '../schema.js';
import type { EnrichProvider, ProviderRequest, ProviderResponse } from './types.js';

const log = logger('enrich:anthropic');

let clientRef: Anthropic | null = null;
function client(): Anthropic {
  if (!clientRef) clientRef = new Anthropic({ apiKey: env.anthropicApiKey });
  return clientRef;
}

/**
 * Constrained decoding: the schema is enforced during sampling, so a
 * structurally wrong payload is not merely rejected - it cannot be generated.
 * No retry loop is needed here, which is why this file is the short one.
 */
export const anthropicProvider: EnrichProvider = {
  name: 'anthropic',

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await client().messages.parse({
      model: request.model,
      max_tokens: 8000,
      system: request.system,
      output_config: {
        format: zodOutputFormat(EnrichmentSchema),
        // `effort` is rejected by Haiku 4.5, so only send it on the escalation tier.
        ...(request.escalate ? { effort: 'medium' as const } : {}),
      },
      messages: [{ role: 'user', content: request.user }],
    });

    if (response.stop_reason === 'max_tokens') {
      throw new Error('enrichment truncated at max_tokens - recipe too long for one call');
    }
    if (!response.parsed_output) {
      throw new Error(`model returned unparseable output (stop_reason=${response.stop_reason})`);
    }

    log.debug(
      `${request.model}: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`,
    );
    return { payload: response.parsed_output, model: request.model };
  },
};
