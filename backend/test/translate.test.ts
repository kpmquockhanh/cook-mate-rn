import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildUserMessage,
  isTargetLanguage,
  outputBudget,
  sanitize,
  TARGET_LANGUAGES,
  type TranslateInput,
} from '../src/translate/llm.js';
import { TranslationSchema, type TranslationPayload } from '../src/translate/schema.js';

/**
 * What utils/ingredientScaling.ts does to an amount, reduced to the one
 * property it needs: a leading number it can multiply. The client is a
 * separate TypeScript project, so importing the real function here is not
 * available; this asserts the contract between them rather than restating its
 * fraction grammar, which would be a second thing to keep in step.
 */
function scalable(amount: string): boolean {
  return /^\s*[\d¼½¾⅓⅔⅕⅛⅜⅝⅞]/.test(amount);
}

// Every assertion here is about what a SCHEMA-VALID payload can still get
// wrong. The provider guarantees the shape; these guarantee the app keeps
// working - and each of these failures is silent on a phone, which is why they
// are checked here rather than noticed in review.

function input(overrides: Partial<TranslateInput> = {}): TranslateInput {
  return {
    recipeId: 1,
    title: 'Corn Chowder',
    description: 'A thick summer soup.',
    cuisine: 'American',
    ingredients: [
      { sortOrder: 0, text: 'ears of corn', amount: '4' },
      { sortOrder: 1, text: 'heavy cream', amount: '2 cups' },
      { sortOrder: 2, text: 'salt', amount: null },
    ],
    steps: [
      { sortOrder: 0, text: 'Cut the corn off the cob.', timerName: null, ingredients: ['ears of corn'] },
      { sortOrder: 1, text: 'Simmer for 25 minutes.', timerName: 'Simmer soup', ingredients: ['heavy cream'] },
    ],
    notes: [{ sortOrder: 0, text: 'Use the cobs for stock.' }],
    ...overrides,
  };
}

function payload(overrides: Partial<TranslationPayload> = {}): TranslationPayload {
  return {
    title: 'Súp ngô',
    description: 'Món súp mùa hè đặc sánh.',
    cuisine: 'Mỹ',
    ingredients: [
      { index: 0, text: 'bắp ngô', amount: '4' },
      { index: 1, text: 'kem tươi', amount: '480 ml' },
      { index: 2, text: 'muối', amount: '' },
    ],
    steps: [
      { index: 0, text: 'Tách hạt ngô khỏi lõi.', timerName: null },
      { index: 1, text: 'Đun nhỏ lửa 25 phút.', timerName: 'Ninh súp' },
    ],
    notes: [{ index: 0, text: 'Dùng lõi ngô để nấu nước dùng.' }],
    ...overrides,
  };
}

test('the happy path translates every field it is given', () => {
  const result = sanitize(payload(), input());

  assert.equal(result.title, 'Súp ngô');
  assert.equal(result.cuisine, 'Mỹ');
  assert.equal(result.ingredients[1]!.text, 'kem tươi');
  assert.equal(result.steps[1]!.text, 'Đun nhỏ lửa 25 phút.');
  assert.equal(result.notes[0]!.text, 'Dùng lõi ngô để nấu nước dùng.');
});

test('the payload the schema accepts is the payload sanitize expects', () => {
  // Guards against the two drifting: a field renamed in schema.ts and not in
  // llm.ts would otherwise only show up as silent fallbacks at runtime.
  assert.doesNotThrow(() => TranslationSchema.parse(payload()));
});

// --- Positions, not strings -------------------------------------------------

test('a step the model skipped keeps its source text rather than vanishing', () => {
  const result = sanitize(
    payload({ steps: [{ index: 0, text: 'Tách hạt ngô khỏi lõi.', timerName: null }] }),
    input(),
  );

  assert.equal(result.steps.length, 2, 'a recipe must never lose a step');
  assert.equal(result.steps[1]!.text, 'Simmer for 25 minutes.');
  assert.equal(result.steps[1]!.sortOrder, 1);
});

test('extra indices the model invented are ignored', () => {
  const result = sanitize(
    payload({ notes: [{ index: 0, text: 'ok' }, { index: 7, text: 'invented' }] }),
    input(),
  );
  assert.equal(result.notes.length, 1);
});

test('sort_order comes from the published row, never from the model', () => {
  // The publisher may leave gaps; the overlay is joined on these exact values.
  const source = input({
    notes: [{ sortOrder: 5, text: 'Use the cobs for stock.' }],
  });
  const result = sanitize(payload(), source);
  assert.equal(result.notes[0]!.sortOrder, 5);
});

// --- Scaling ----------------------------------------------------------------

test('an amount that lost its leading number falls back to the source', () => {
  const result = sanitize(
    payload({
      ingredients: [
        { index: 0, text: 'bắp ngô', amount: '4' },
        // "a splash" - reads fine, and silently disables the servings stepper.
        { index: 1, text: 'kem tươi', amount: 'một chút' },
        { index: 2, text: 'muối', amount: '' },
      ],
    }),
    input(),
  );
  assert.equal(result.ingredients[1]!.amount, '2 cups');
});

test('every amount that survives is still one the app can scale', () => {
  const result = sanitize(payload(), input());
  // A metric conversion is allowed - "2 cups" -> "480 ml" scales correctly,
  // because the scaler multiplies the number and leaves the unit alone.
  assert.equal(result.ingredients[1]!.amount, '480 ml');
  for (const ingredient of result.ingredients) {
    if (ingredient.amount === null) continue;
    assert.ok(scalable(ingredient.amount), `"${ingredient.amount}" would freeze the servings stepper`);
  }
});

test('an ingredient with no amount is not given one', () => {
  const result = sanitize(
    payload({
      ingredients: [
        { index: 0, text: 'bắp ngô', amount: '4' },
        { index: 1, text: 'kem tươi', amount: '480 ml' },
        { index: 2, text: 'muối', amount: '2 muỗng cà phê' },
      ],
    }),
    input(),
  );
  assert.equal(result.ingredients[2]!.amount, null, 'inventing a quantity is a claim about the food');
});

// --- Step highlighting ------------------------------------------------------

test("a step's ingredient list is rewritten to the translated lines", () => {
  // app/cooking/[id].tsx substring-matches these against the ingredient lines.
  // If they stay English on a translated recipe, highlighting silently stops.
  const result = sanitize(payload(), input());
  assert.deepEqual(result.steps[0]!.ingredients, ['bắp ngô']);
  assert.deepEqual(result.steps[1]!.ingredients, ['kem tươi']);

  const lines = result.ingredients.map((i) => i.text);
  for (const step of result.steps) {
    for (const line of step.ingredients) {
      assert.ok(lines.includes(line), `step names "${line}", which no ingredient line carries`);
    }
  }
});

test('a step ingredient matches even when its ingredient fell back to English', () => {
  const result = sanitize(
    payload({
      ingredients: [
        { index: 0, text: '   ', amount: '4' }, // model returned nothing usable
        { index: 1, text: 'kem tươi', amount: '480 ml' },
        { index: 2, text: 'muối', amount: '' },
      ],
    }),
    input(),
  );
  assert.equal(result.ingredients[0]!.text, 'ears of corn');
  assert.deepEqual(result.steps[0]!.ingredients, ['ears of corn'], 'the two sides must agree');
});

test('a step naming an ingredient the recipe does not list passes it through', () => {
  const source = input({
    steps: [
      { sortOrder: 0, text: 'Cut the corn off the cob.', timerName: null, ingredients: ['butter'] },
      { sortOrder: 1, text: 'Simmer for 25 minutes.', timerName: 'Simmer soup', ingredients: [] },
    ],
  });
  const result = sanitize(payload(), source);
  assert.deepEqual(result.steps[0]!.ingredients, ['butter']);
});

// --- Timers -----------------------------------------------------------------

test('a timer name is never invented for a step that has no timer', () => {
  const result = sanitize(
    payload({
      steps: [
        { index: 0, text: 'Tách hạt ngô khỏi lõi.', timerName: 'Thái ngô' },
        { index: 1, text: 'Đun nhỏ lửa 25 phút.', timerName: 'Ninh súp' },
      ],
    }),
    input(),
  );
  assert.equal(result.steps[0]!.timerName, null, 'the duration lives on the base row, not here');
  assert.equal(result.steps[1]!.timerName, 'Ninh súp');
});

test('a timer that lost its name keeps the source label', () => {
  const result = sanitize(
    payload({
      steps: [
        { index: 0, text: 'Tách hạt ngô khỏi lõi.', timerName: null },
        { index: 1, text: 'Đun nhỏ lửa 25 phút.', timerName: null },
      ],
    }),
    input(),
  );
  assert.equal(result.steps[1]!.timerName, 'Simmer soup', 'a timer must never render unlabelled');
});

// --- Nullability ------------------------------------------------------------

test('a null description stays null rather than becoming an empty string', () => {
  // The API coalesces to the base row, so '' would blank out the source text.
  const result = sanitize(
    payload({ description: 'Món súp mùa hè đặc sánh.', cuisine: 'Mỹ' }),
    input({ description: null, cuisine: null }),
  );
  assert.equal(result.description, null);
  assert.equal(result.cuisine, null);
});

test('an empty translation falls back instead of blanking the recipe', () => {
  const result = sanitize(payload({ title: '   ', description: '' }), input());
  assert.equal(result.title, 'Corn Chowder');
  assert.equal(result.description, 'A thick summer soup.');
});

// --- Prompt -----------------------------------------------------------------

test('the user message carries positions, and no duration', () => {
  const message = buildUserMessage(input(), 'vi');
  assert.match(message, /Vietnamese/);
  assert.match(message, /0 \| 4 \| ears of corn/);
  assert.match(message, /1 \| Simmer soup \| Simmer for 25 minutes\./);
  assert.match(message, /0 \| null \| Cut the corn off the cob\./, 'a null timer must read as null');
  assert.doesNotMatch(message, /\b1500\b/, 'durations are not the model\'s to restate');
});

test('every target language is one the API and the app can ask for', () => {
  // api/schema.ts LOCALES and lib/i18n/languages.ts are the other two lists;
  // a language translatable but not requestable would never be seen.
  for (const code of Object.keys(TARGET_LANGUAGES)) {
    assert.ok(isTargetLanguage(code));
    assert.match(code, /^[a-z]{2}$/);
  }
});

// --- Output ceiling ---------------------------------------------------------

// A ceiling too low does not degrade the translation, it destroys the call:
// the model stops mid-JSON, the provider throws, and the recipe is left in
// English. These are about the ceiling GROWING with the recipe.

test('the recipe that truncated at a fixed ceiling now asks for room it fits in', () => {
  // The shape of recipe #262: 49 steps, 15 ingredients, ~7,500 source
  // characters. Translated into Vietnamese it produced 9,442 output tokens,
  // which is what the old fixed 8,000 cut in half.
  const long = input({
    ingredients: Array.from({ length: 15 }, (_, index) => ({
      sortOrder: index,
      text: 'unsalted butter, softened',
      amount: '225 g',
    })),
    steps: Array.from({ length: 49 }, (_, index) => ({
      sortOrder: index,
      text: 'Roll the dough to 5 mm, cut the panels, and chill them until firm before baking.',
      timerName: 'Chill dough',
      ingredients: [],
    })),
  });

  assert.ok(outputBudget(long) > outputBudget(input()), 'a long recipe must ask for more');
  assert.ok(
    outputBudget(long) > 9_442,
    'the ceiling must clear what this recipe actually produced, with room to spare',
  );
});

test('an ordinary recipe still asks for the ceiling it always had', () => {
  assert.equal(outputBudget(input()), 8_000);
});

test('the ceiling is bounded, however long the row claims to be', () => {
  const absurd = input({
    steps: [{ sortOrder: 0, text: 'x'.repeat(500_000), timerName: null, ingredients: [] }],
  });

  assert.ok(outputBudget(absurd) <= 48_000, 'a malformed row must not ask for an unbounded call');
});
