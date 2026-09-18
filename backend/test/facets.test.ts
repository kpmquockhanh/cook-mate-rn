import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeTimeSeconds,
  deriveFacets,
  diets,
  mainIngredient,
  mealFromText,
  type CanonicalFact,
} from '../src/publish/facets.js';
import type { EnrichmentResult, ParsedIngredient } from '../src/types.js';

function fact(slug: string, ...dietaryTags: string[]): CanonicalFact {
  return { slug, dietaryTags };
}

function steps(...durations: (number | null)[]): EnrichmentResult['steps'] {
  return durations.map((durationSeconds, index) => ({
    index,
    text: `step ${index}`,
    ingredientIndices: [],
    durationSeconds,
    timerName: durationSeconds === null ? null : 'Wait',
    isPassive: durationSeconds !== null,
  }));
}

// --- Time -------------------------------------------------------------------

test('hands-on time is the total minus every unattended stretch', () => {
  // A slow cooker: 8 hours on the clock, 20 minutes of work. Only the middle
  // step is unattended; the two either side are prep, so they carry no duration.
  assert.equal(activeTimeSeconds(8 * 3600, steps(null, 8 * 3600 - 1200, null)), 1200);
});

test('a total shorter than its own steps clamps to zero rather than going negative', () => {
  assert.equal(activeTimeSeconds(600, steps(1800)), 0);
});

test('no stated total means no hands-on time, not a guess', () => {
  assert.equal(activeTimeSeconds(null, steps(600)), null);
});

// --- Main ingredient --------------------------------------------------------

test('the protein a dish is named for beats its starch', () => {
  assert.equal(
    mainIngredient([fact('pasta', 'gluten'), fact('chicken-thigh', 'meat'), fact('onion')]),
    'chicken',
  );
});

test('animal protein outranks the starch it is served with', () => {
  assert.equal(mainIngredient([fact('bacon', 'meat'), fact('egg', 'egg')]), 'pork');
  assert.equal(mainIngredient([fact('ground-beef', 'meat'), fact('pasta', 'gluten')]), 'beef');
});

test('vegetables lead a dish with no animal protein in it', () => {
  assert.equal(mainIngredient([fact('broccoli'), fact('garlic'), fact('olive-oil')]), 'veg');
});

test('an unrecognised meat dish names no ingredient rather than calling itself vegetable', () => {
  // 'lamb-shoulder' is not in the dictionary's slug map, but its tag is.
  assert.equal(mainIngredient([fact('lamb-shoulder', 'meat'), fact('onion')]), null);
});

// --- Diet -------------------------------------------------------------------

test('a recipe of vegetables and flour is vegetarian and vegan but not gluten free', () => {
  assert.deepEqual(
    diets([fact('tomato'), fact('all-purpose-flour', 'gluten')], true),
    ['vegetarian', 'vegan', 'pescatarian'],
  );
});

test('dairy rules out vegan and nothing else', () => {
  assert.deepEqual(
    diets([fact('tomato'), fact('parmesan', 'dairy')], true),
    ['vegetarian', 'pescatarian', 'gluten_free'],
  );
});

test('fish is pescatarian, never vegetarian; meat is neither', () => {
  assert.deepEqual(diets([fact('salmon', 'seafood'), fact('lemon')], true), [
    'pescatarian',
    'gluten_free',
  ]);
  assert.deepEqual(diets([fact('chicken-breast', 'meat')], true), ['gluten_free']);
});

test('an unmatched ingredient means no diet claim at all', () => {
  // The safety rule: one ingredient we could not identify could be anything,
  // so the recipe makes no promise rather than a probable one.
  assert.deepEqual(diets([fact('tomato'), fact('onion')], false), []);
});

// --- Meal -------------------------------------------------------------------

test('the keyword fallback reads title and category together', () => {
  assert.equal(mealFromText('Giant Hash Brown', null), 'breakfast');
  assert.equal(mealFromText('Vegan Bacon', 'Breakfast'), 'breakfast');
  assert.equal(mealFromText('Homemade Teriyaki Sauce', 'Marinade'), 'basics');
  assert.equal(mealFromText('Crispy Fried Falafel', 'Lemon'), null);
});

// --- Everything together ----------------------------------------------------

function enrichment(overrides: Partial<EnrichmentResult> = {}): EnrichmentResult {
  return {
    steps: steps(null, 3600),
    notes: [],
    difficulty: 'easy',
    servings: 4,
    totalTimeSeconds: 4200,
    aiScore: 7,
    ...overrides,
  };
}

function ingredients(count: number): ParsedIngredient[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    raw: `ingredient ${index}`,
    name: `ingredient ${index}`,
  })) as ParsedIngredient[];
}

test("the model's meal wins, and the scrape's cuisine wins", () => {
  const facets = deriveFacets(
    { title: 'Chicken Soup', category: 'Soup', cuisine: 'Jewish', total_time_seconds: 4200,
      ingredients: ingredients(2) },
    enrichment({ meal: 'dinner', cuisine: 'American' }),
    [fact('chicken-thigh', 'meat'), fact('carrot')],
  );

  // 'Soup' would make this lunch by keyword; the model read the recipe.
  assert.equal(facets.meal, 'dinner');
  assert.equal(facets.cuisine, 'Jewish');
  assert.equal(facets.mainIngredient, 'chicken');
  assert.equal(facets.activeTimeSeconds, 600);
  assert.deepEqual(facets.diet, ['gluten_free']);
});

test('a row enriched before the model was asked for a meal falls back to keywords', () => {
  const facets = deriveFacets(
    { title: 'Chocolate Mousse', category: 'Dessert', cuisine: null, total_time_seconds: 1200,
      ingredients: ingredients(1) },
    enrichment({ meal: undefined, cuisine: 'French', totalTimeSeconds: 1200 }),
    [fact('chocolate')],
  );

  assert.equal(facets.meal, 'dessert');
  // Nothing scraped, so the model's reading is what there is.
  assert.equal(facets.cuisine, 'French');
});

test('a recipe with an unmatched ingredient publishes no diet', () => {
  const facets = deriveFacets(
    { title: 'Mystery Stew', category: null, cuisine: null, total_time_seconds: 3600,
      ingredients: ingredients(5) },
    enrichment(),
    [fact('onion'), fact('carrot')],
  );

  assert.deepEqual(facets.diet, []);
});
