import * as z from 'zod/v4';

/**
 * The contract with the model. Two decisions are load-bearing:
 *
 *  - `ingredientIndices` are POSITIONS, never strings. A string match is what
 *    `app/cooking/[id].tsx` does today, and it fails silently when the model
 *    paraphrases an ingredient. Indices are verifiable against the array.
 *  - `durationSeconds` is only for UNATTENDED waiting. "Chop the onion" must
 *    not spawn a timer, or Cooking Mode fills up with timers nobody wants.
 */
export const EnrichedStepSchema = z.object({
  index: z.number().int().min(0).describe('Position of this step in the input steps array'),
  ingredientIndices: z
    .array(z.number().int().min(0))
    .describe('Indices into the ingredients array used in this step; [] if none'),
  durationSeconds: z
    .number()
    .int()
    .nullable()
    .describe('Seconds of unattended waiting (simmer/bake/rest/chill). null for active prep.'),
  timerName: z
    .string()
    .nullable()
    .describe('Imperative label of at most 3 words, e.g. "Simmer sauce". null when durationSeconds is null.'),
  isPassive: z.boolean().describe('True when the cook waits rather than works'),
});

export const EnrichmentSchema = z.object({
  steps: z.array(EnrichedStepSchema),
  notes: z
    .array(z.string())
    .describe('At most 3 short practical tips derived from the recipe. Do not copy marketing prose.'),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  servings: z.number().int().nullable().describe('Servings if stated or clearly inferable, else null'),
  totalTimeSeconds: z.number().int().nullable(),
  aiScore: z
    .number()
    .min(0)
    .max(10)
    .describe(
      'Your own judgment of this recipe on a 0-10 scale, weighing clarity of instructions, ' +
        'ingredient balance, and how appealing the result sounds. Not a copy of any rating in the source.',
    ),
});

export type EnrichmentPayload = z.infer<typeof EnrichmentSchema>;
