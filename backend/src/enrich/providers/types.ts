import type { EnrichmentPayload } from '../schema.js';

export interface ProviderRequest {
  system: string;
  user: string;
  /** Concrete model id, already resolved for this tier by the caller. */
  model: string;
  /** The stronger tier. Providers may spend more effort/tokens on it. */
  escalate: boolean;
}

export interface ProviderResponse {
  /** Schema-valid payload. MEANING is still unchecked - `sanitize` does that. */
  payload: EnrichmentPayload;
  /** Echoed back so the row records which model actually produced it. */
  model: string;
}

/**
 * The whole contract an enrichment backend has to satisfy. Everything a
 * provider does NOT own lives in llm.ts: the prompt, the user message, and
 * `sanitize`. That split is what makes two providers comparable - swap the
 * provider and the only variable is the model, not the instructions.
 *
 * `complete` MUST return a payload that already passed EnrichmentSchema, and
 * MUST throw otherwise. Callers never see partial output.
 */
export interface EnrichProvider {
  readonly name: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}
