import { env } from '../env.js';
import { logger } from '../log.js';
import { activeProvider } from '../enrich/providers/index.js';
import { TranslationSchema, type TranslationPayload } from './schema.js';

const log = logger('translate');

/**
 * The languages this stage can produce, and how the prompt refers to them.
 * Keyed by the same codes as lib/i18n/languages.ts and api/schema.ts.
 */
export const TARGET_LANGUAGES = {
  vi: {
    name: 'Vietnamese',
    endonym: 'Tiếng Việt',
    /**
     * Per-language notes, because the general instructions below cannot carry
     * what is specific to cooking in one place. These are the failures a
     * native reader flags first on machine-translated recipes.
     */
    notes: [
      'Use the measurements a Vietnamese kitchen owns: grams and millilitres, not cups and ounces.',
      '1 cup = 240 ml, 1 tablespoon = "1 muỗng canh" = 15 ml, 1 teaspoon = "1 muỗng cà phê" = 5 ml.',
      'Convert oven temperatures to Celsius.',
      'Use the everyday word, not the dictionary word: "xào" for stir-frying, "áp chảo" for searing, "hầm" for braising, "ủ bột" for proving dough.',
      'Stock is "nước dùng", not "chứng khoán". Season to taste is "nêm nếm vừa ăn".',
      'Keep a borrowed name borrowed when that is what people say: "pizza", "sốt mayonnaise", "phô mai parmesan".',
    ],
  },
} as const;

export type TargetLanguage = keyof typeof TARGET_LANGUAGES;

export function isTargetLanguage(value: string): value is TargetLanguage {
  return value in TARGET_LANGUAGES;
}

const SYSTEM = `You translate recipes for a hands-free voice cooking app.

The app shows one step at a time on a phone propped up in a kitchen and reads it aloud, in the language you are translating into. Someone is cooking from your words in real time.

Rules:
- Return one entry per input ingredient, step and note, each with its original index. Never merge, split, reorder, add or drop one. A recipe that loses a step is worse than one left untranslated.
- Translate MEANING, not words. Write what a cook in that language would say, not a word-for-word mapping of the English.
- Never change what the recipe does: the same ingredients, the same quantities, the same order, the same techniques, the same doneness cues.
- amount may change UNITS but never the quantity it represents, and it must still begin with a number - the app scales a recipe by multiplying that leading number, and loses the ability to the moment it is gone. "2 cups flour" -> "250 g" is right. "một chút" is wrong.
- Use the ingredient name someone would look for in a shop where that language is spoken. An ingredient with no local equivalent keeps its name, with two or three words of explanation the first time it appears.
- timerName is null exactly when the input step's timer name is null. Never invent one.
- Translate nothing that is not text a cook reads: no numbers of minutes, no temperatures other than converting the scale, no brand names.
- When the source is ambiguous, translate the ambiguity. Do not resolve it by guessing, and do not add advice of your own.`;

export interface TranslatableIngredient {
  sortOrder: number;
  text: string;
  amount: string | null;
}

export interface TranslatableStep {
  sortOrder: number;
  text: string;
  timerName: string | null;
  /** Base ingredient lines this step uses; carried through, never translated by the model. */
  ingredients: string[];
}

export interface TranslateInput {
  recipeId: number;
  title: string;
  description: string | null;
  cuisine: string | null;
  ingredients: TranslatableIngredient[];
  steps: TranslatableStep[];
  notes: { sortOrder: number; text: string }[];
}

/** What gets written to the overlay tables, already positional. */
export interface TranslationResult {
  title: string;
  description: string | null;
  cuisine: string | null;
  ingredients: { sortOrder: number; text: string; amount: string | null }[];
  steps: { sortOrder: number; text: string; timerName: string | null; ingredients: string[] }[];
  notes: { sortOrder: number; text: string }[];
}

export function buildUserMessage(input: TranslateInput, target: TargetLanguage): string {
  const language = TARGET_LANGUAGES[target];
  const list = <T>(items: T[], render: (item: T, index: number) => string): string =>
    items.length === 0 ? '  (none)' : items.map(render).join('\n');

  return [
    `Translate this recipe into ${language.name} (${language.endonym}).`,
    '',
    `Notes for ${language.name}:`,
    ...language.notes.map((note) => `- ${note}`),
    '',
    `Title: ${input.title}`,
    input.description ? `Description: ${input.description}` : null,
    input.cuisine ? `Cuisine: ${input.cuisine}` : null,
    '',
    'Ingredients (index | amount | text):',
    list(input.ingredients, (ingredient, index) =>
      `  ${index} | ${ingredient.amount ?? ''} | ${ingredient.text}`),
    '',
    // The timer name is shown so the model translates the label the cook sees,
    // and so `null` stays `null`. The duration behind it is never sent: it is
    // not the model's to restate.
    'Steps (index | timerName | text):',
    list(input.steps, (step, index) =>
      `  ${index} | ${step.timerName ?? 'null'} | ${step.text}`),
    '',
    'Notes (index | text):',
    list(input.notes, (note, index) => `  ${index} | ${note.text}`),
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * How many output tokens this recipe needs room for.
 *
 * A translation is the one task whose output length is set by its INPUT, and
 * a fixed ceiling is therefore a fixed limit on how long a recipe may be. The
 * 49-step recipe that made this a function truncated at 8000 - silently, from
 * the model's side, and the whole call was then thrown away.
 *
 * The multiplier is deliberately generous, because the two things it has to
 * cover both run against us:
 *   - Vietnamese costs several times more tokens than the English it restates
 *     - it is tokenized far less efficiently than the language the estimate is
 *     measured in.
 *   - Every item carries JSON scaffolding the source does not: braces, key
 *     names, an index, an amount or a timerName. On a recipe of many short
 *     steps that overhead is the larger half.
 *
 * Overstating it is close to free (only generated tokens are billed), but not
 * entirely - see outputCap() in the provider - so it is sized per recipe
 * rather than pinned at the model's maximum.
 */
export function outputBudget(input: TranslateInput): number {
  const chars =
    input.title.length +
    (input.description?.length ?? 0) +
    (input.cuisine?.length ?? 0) +
    input.ingredients.reduce((sum, i) => sum + i.text.length + (i.amount?.length ?? 0), 0) +
    input.steps.reduce((sum, s) => sum + s.text.length + (s.timerName?.length ?? 0), 0) +
    input.notes.reduce((sum, n) => sum + n.text.length, 0);

  // ~4 source characters per English token, then 6 output tokens per one of
  // those, plus a flat allowance for the envelope around a short recipe.
  const estimate = Math.ceil(chars / 4) * 6 + 2_000;

  // The floor is what every recipe before this one was translated under, so a
  // normal recipe reserves exactly what it used to. The roof is a recipe far
  // longer than anything the crawler has produced - past it, something is
  // wrong with the row rather than long about it.
  return Math.min(Math.max(estimate, 8_000), 48_000);
}

/**
 * The leading quantity the app's scaler needs to find.
 *
 * Deliberately a loose mirror of LEADING_QUANTITY_RE in
 * utils/ingredientScaling.ts rather than a copy: this only has to answer "is
 * there still a number at the front", and matching the client's exact fraction
 * grammar here would be a second thing to keep in step for no extra safety.
 */
const LEADING_QUANTITY = /^\s*[\d¼½¾⅓⅔⅕⅛⅜⅝⅞]/;

/** Falls back to the source when the model returned nothing usable. */
function preferTranslated(translated: string | null | undefined, source: string): string {
  const trimmed = translated?.trim();
  return trimmed ? trimmed : source;
}

/**
 * Check the model's output against the input it was given.
 *
 * The schema guarantees shape. This guarantees the things the app depends on
 * and a well-formed payload can still get wrong - and every one of them fails
 * SILENTLY in the app rather than loudly:
 *
 *  - A missing index would drop a step from the recipe. Here it falls back to
 *    the source text, so a partial translation reads as a mix of languages -
 *    visibly imperfect, never incomplete.
 *  - An `amount` that lost its leading number stops the servings scaler dead
 *    (utils/ingredientScaling.ts returns the string unchanged), so the number
 *    on screen would quietly stop responding to the stepper. The source amount
 *    is kept instead.
 *  - A `timerName` invented for a step with no duration would render a timer
 *    the cook cannot start; one dropped from a step that has a duration would
 *    render a timer with no name. The source decides, not the model.
 *  - A step's ingredient list is DERIVED here, by mapping each base line
 *    through the translated ingredients by position. That is what keeps the
 *    cooking screen's substring match working on a translated recipe, and it
 *    cannot drift, because both sides come out of the same array.
 */
export function sanitize(payload: TranslationPayload, input: TranslateInput): TranslationResult {
  const ingredientsByIndex = new Map(payload.ingredients.map((i) => [i.index, i]));
  const stepsByIndex = new Map(payload.steps.map((s) => [s.index, s]));
  const notesByIndex = new Map(payload.notes.map((n) => [n.index, n]));

  const ingredients = input.ingredients.map((source, index) => {
    const translated = ingredientsByIndex.get(index);

    // An amount is kept only when it is still scalable. An absent source
    // amount stays absent - inventing one would be a claim about quantity.
    let amount = source.amount;
    if (source.amount !== null) {
      const candidate = translated?.amount?.trim();
      if (candidate && LEADING_QUANTITY.test(candidate) === LEADING_QUANTITY.test(source.amount)) {
        amount = candidate;
      }
    }

    return {
      sortOrder: source.sortOrder,
      text: preferTranslated(translated?.text, source.text),
      amount,
    };
  });

  // Base line -> translated line, for the per-step ingredient lists below.
  // Keyed by the exact base string because that is what the base jsonb holds.
  const byBaseText = new Map(
    input.ingredients.map((source, index) => [source.text, ingredients[index]!.text]),
  );

  const steps = input.steps.map((source, index) => {
    const translated = stepsByIndex.get(index);
    return {
      sortOrder: source.sortOrder,
      text: preferTranslated(translated?.text, source.text),
      // null in, null out. A label without a duration behind it is dead weight.
      timerName:
        source.timerName === null
          ? null
          : preferTranslated(translated?.timerName, source.timerName),
      // An unknown line is passed through untranslated rather than dropped:
      // the step still names it, and the base string at least matches the
      // ingredient list when that one fell back to the source too.
      ingredients: source.ingredients.map((line) => byBaseText.get(line) ?? line),
    };
  });

  const notes = input.notes.map((source, index) => ({
    sortOrder: source.sortOrder,
    text: preferTranslated(notesByIndex.get(index)?.text, source.text),
  }));

  return {
    title: preferTranslated(payload.title, input.title),
    // A null description stays null; the overlay column is nullable and the
    // API coalesces to the base row, so writing '' would hide the source text.
    description:
      input.description === null ? null : preferTranslated(payload.description, input.description),
    cuisine: input.cuisine === null ? null : preferTranslated(payload.cuisine, input.cuisine),
    ingredients,
    steps,
    notes,
  };
}

export interface TranslateOutcome {
  result: TranslationResult;
  /** Qualified as `provider:model`, so a row records both. */
  model: string;
}

export async function translateRecipe(
  input: TranslateInput,
  target: TargetLanguage,
  options: { escalate?: boolean } = {},
): Promise<TranslateOutcome> {
  const provider = activeProvider();
  // Translation is the cheap tier's job by default: it restates text already
  // on the row rather than judging it. `--escalate` is for the recipes a
  // native reviewer sent back, where register is the whole problem.
  const escalate = options.escalate ?? false;
  const model = escalate ? env.enrichEscalationModel : env.translateModel;

  const response = await provider.complete({
    system: SYSTEM,
    user: buildUserMessage(input, target),
    model,
    escalate,
    maxTokens: outputBudget(input),
    schema: TranslationSchema,
  });

  log.debug(`${provider.name}:${response.model} translated "${input.title}" -> ${target}`);
  return {
    result: sanitize(response.payload, input),
    model: `${provider.name}:${response.model}`,
  };
}

export { SYSTEM };
