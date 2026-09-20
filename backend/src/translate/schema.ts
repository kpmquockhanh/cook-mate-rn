import * as z from 'zod/v4';

/**
 * The contract with the model for stage 5: a published recipe, restated in
 * another language.
 *
 * Every array here is POSITIONAL - `index` refers to a position in the input
 * the model was given, exactly as stage 2's enrichment schema does. Nothing is
 * matched by string, because a paraphrase would silently mislink a step to the
 * wrong translation and no assertion downstream could tell.
 *
 * What is deliberately ABSENT is as load-bearing as what is here:
 *
 *  - No durations, no servings, no quantities-as-numbers. Those live on the
 *    base row and are shared by every language (migration 0015). A model that
 *    cannot restate them cannot get them wrong.
 *  - No per-step ingredient list. The cooking screen substring-matches that
 *    against the ingredient lines, so it is DERIVED from the translated
 *    ingredients in llm.ts rather than asked for - a model reproducing the
 *    same string twice is exactly the kind of thing that works until it does
 *    not, and the failure is silent (highlighting just stops).
 */

export const TranslatedIngredientSchema = z.object({
  index: z.number().int().min(0).describe('Position in the ingredients array you were given'),
  text: z
    .string()
    .describe('The ingredient line in the target language, naming the ingredient a cook there would buy'),
  amount: z
    .string()
    .describe(
      'The quantity, which MUST still start with a number ("250 g", "2 muỗng canh"). ' +
        'Empty string when the source had no amount.',
    ),
});

export const TranslatedStepSchema = z.object({
  index: z.number().int().min(0).describe('Position in the steps array you were given'),
  text: z.string().describe('The instruction in the target language'),
  timerName: z
    .string()
    .nullable()
    .describe(
      'The timer label translated, at most 3 words. null exactly when the source step had none - ' +
        'never invent one, the timer is driven by a duration you cannot see.',
    ),
});

export const TranslationSchema = z.object({
  title: z.string().describe('The dish name in the target language'),
  description: z.string().nullable().describe('null when the source had no description'),
  cuisine: z
    .string()
    .nullable()
    .describe('The cuisine name in the target language, or null when the source had none'),
  ingredients: z.array(TranslatedIngredientSchema),
  steps: z.array(TranslatedStepSchema),
  notes: z
    .array(z.object({
      index: z.number().int().min(0),
      text: z.string(),
    }))
    .describe('One entry per input note, same positions'),
});

export type TranslationPayload = z.infer<typeof TranslationSchema>;
