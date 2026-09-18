import { env } from '../env.js';
import { logger } from '../log.js';
import type { EnrichmentResult, ParsedIngredient, ParsedStep } from '../types.js';
import { EnrichmentSchema, type EnrichmentPayload } from './schema.js';
import { activeProvider } from './providers/index.js';

const log = logger('enrich');

const SYSTEM = `You convert scraped recipes into data for a hands-free voice cooking app.

The app shows one step at a time on a phone propped up in a kitchen and reads it aloud.
It starts a countdown timer whenever a step has a duration.

Rules:
- ingredientIndices must be valid indices into the ingredients array you are given. Use [] when a step uses none. Never invent an index.
- durationSeconds covers UNATTENDED waiting only: simmering, baking, resting, chilling, marinating, proofing. Active work ("chop the onion", "whisk until smooth") gets null, even when the source states a time for it.
- When a step gives a range ("simmer 20-25 minutes"), use the UPPER bound. Undercooked is the worse failure.
- timerName is an imperative of at most 3 words ("Simmer sauce", "Rest dough"). It is null exactly when durationSeconds is null.
- Return one entry per input step, with its original index. Do not merge, split, reorder, or add steps.
- notes are your own short practical tips (max 3). Do not copy the source's prose.
- meal is when the dish is eaten, not what it contains: a bacon-and-egg pie eaten at dinner is "dinner". Use "basics" for anything that is a component rather than a dish - a sauce, a marinade, a stock, a frosting.
- cuisine is the tradition the dish comes from, in one or two words. Use null rather than guessing when it is generic; "Copycat" and "Western" are not cuisines.
- aiScore is your own 0-10 judgment of the recipe's quality (clarity, ingredient balance, appeal). Base it only on the recipe itself, never on any rating present in the source.
- Never invent ingredients, steps, or times that the input does not support.`;

export interface EnrichInput {
  title: string;
  ingredients: ParsedIngredient[];
  steps: ParsedStep[];
  servingsHint: number | null;
  totalTimeHint: number | null;
}

function buildUserMessage(input: EnrichInput): string {
  const ingredients = input.ingredients
    .map((i) => `  ${i.index}: ${i.raw}`)
    .join('\n');
  const steps = input.steps.map((s) => `  ${s.index}: ${s.text}`).join('\n');
  return [
    `Title: ${input.title}`,
    input.servingsHint ? `Stated servings: ${input.servingsHint}` : null,
    input.totalTimeHint ? `Stated total time: ${input.totalTimeHint}s` : null,
    '',
    'Ingredients (index: text):',
    ingredients || '  (none)',
    '',
    'Steps (index: text):',
    steps || '  (none)',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * Validate the model's output against the input it was given. The schema
 * guarantees shape; this guarantees MEANING - an index the model hallucinated
 * still parses fine as a number, and would silently mislink a step forever.
 *
 * Provider-independent on purpose: it is the only defence a provider without
 * constrained decoding has, and the reason two providers stay comparable.
 */
function sanitize(payload: EnrichmentPayload, input: EnrichInput): EnrichmentResult {
  const ingredientCount = input.ingredients.length;
  const byIndex = new Map(payload.steps.map((step) => [step.index, step]));

  const steps = input.steps.map((step) => {
    const enriched = byIndex.get(step.index);
    const indices = (enriched?.ingredientIndices ?? [])
      .filter((i) => Number.isInteger(i) && i >= 0 && i < ingredientCount);

    let duration = enriched?.durationSeconds ?? null;
    // Anything outside 30s-8h is a model slip (usually seconds/minutes confusion).
    if (duration !== null && (duration < 30 || duration > 8 * 3600)) duration = null;

    return {
      index: step.index,
      text: step.text,
      ingredientIndices: [...new Set(indices)],
      durationSeconds: duration,
      timerName: duration === null ? null : (enriched?.timerName?.trim() || 'Timer'),
      isPassive: duration !== null || (enriched?.isPassive ?? false),
    };
  });

  return {
    steps,
    notes: payload.notes.slice(0, 3).map((n) => n.trim()).filter(Boolean),
    difficulty: payload.difficulty,
    // The model reads the whole recipe, so it is a better source for these
    // than the scraped columns: `cuisine` is null on 32 of 45 published rows,
    // and `category` is source free text. publish/facets.ts decides which one
    // wins when both have an opinion.
    meal: payload.meal,
    cuisine: payload.cuisine?.trim() || null,
    servings: payload.servings ?? input.servingsHint,
    totalTimeSeconds: payload.totalTimeSeconds ?? input.totalTimeHint,
    // Schema already enforces 0-10, but a provider without constrained
    // decoding can still hand back e.g. 9.97; round to the precision the
    // DB column and UI actually display.
    aiScore: Math.round(Math.min(10, Math.max(0, payload.aiScore)) * 10) / 10,
  };
}

export interface EnrichOutcome {
  result: EnrichmentResult;
  /** Qualified as `provider:model` so a row records both. */
  model: string;
}

export async function enrichRecipe(
  input: EnrichInput,
  options: { escalate?: boolean } = {},
): Promise<EnrichOutcome> {
  const provider = activeProvider();
  const model = options.escalate ? env.enrichEscalationModel : env.enrichModel;

  const response = await provider.complete({
    system: SYSTEM,
    user: buildUserMessage(input),
    model,
    escalate: options.escalate ?? false,
    schema: EnrichmentSchema,
  });

  log.debug(`${provider.name}:${response.model} enriched "${input.title}"`);
  return {
    result: sanitize(response.payload, input),
    model: `${provider.name}:${response.model}`,
  };
}

export { SYSTEM, buildUserMessage, sanitize };
