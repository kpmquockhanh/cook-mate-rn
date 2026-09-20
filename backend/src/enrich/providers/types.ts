import type * as z from 'zod/v4';

export interface ProviderRequest<T = unknown> {
  system: string;
  user: string;
  /** Concrete model id, already resolved for this tier by the caller. */
  model: string;
  /** The stronger tier. Providers may spend more effort/tokens on it. */
  escalate: boolean;
  /**
   * The output ceiling for this one call, in tokens. Optional because most
   * tasks restate a paragraph or two and the provider default covers them;
   * translation sizes it from the recipe, because the only way a caller finds
   * out the ceiling was too low is a truncated response it has to throw away.
   * Providers clamp it to what their model actually allows.
   */
  maxTokens?: number;
  /**
   * The shape the response must satisfy. Passed in rather than fixed, because
   * the pipeline now asks a model for two different things - enrichment of a
   * parsed recipe, and extraction of a recipe from a page nothing else could
   * read - and they must not grow two separate provider stacks.
   */
  schema: z.ZodType<T>;
}

export interface ProviderResponse<T = unknown> {
  /** Schema-valid payload. MEANING is still unchecked - the caller does that. */
  payload: T;
  /** Echoed back so the row records which model actually produced it. */
  model: string;
}

/**
 * The whole contract an LLM backend has to satisfy. Everything a provider does
 * NOT own lives with the task: the prompt, the user message, the schema, and
 * the meaning check. That split is what makes two providers comparable - swap
 * the provider and the only variable is the model, not the instructions.
 *
 * `complete` MUST return a payload that already passed the given schema, and
 * MUST throw otherwise. Callers never see partial output.
 */
export interface LlmProvider {
  readonly name: string;
  complete<T>(request: ProviderRequest<T>): Promise<ProviderResponse<T>>;
}

/** The name this contract had when enrichment was its only caller. */
export type EnrichProvider = LlmProvider;
