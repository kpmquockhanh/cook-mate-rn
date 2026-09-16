import assert from 'node:assert/strict';
import test from 'node:test';
import { parseQuantity, expandVulgarFractions } from '../src/parse/numbers.js';
import { matchLeadingUnit, toGrams, findUnit } from '../src/parse/units.js';
import { parseIngredient, formatAmount } from '../src/parse/ingredient.js';
import { parseIsoDuration, parseHumanDuration, parseServings, formatCookingTime } from '../src/parse/duration.js';
import { segmentSteps } from '../src/parse/steps.js';
import { normalizeName } from '../src/canonical/match.js';
import { canonicalizeUrl } from '../src/util.js';
import { extractJsonLd } from '../src/crawl/jsonld.js';

test('expands unicode fractions with the right spacing', () => {
  assert.equal(expandVulgarFractions('1½ cups'), '1 1/2 cups');
  assert.equal(expandVulgarFractions('¾ tsp'), '3/4 tsp');
});

test('parses quantities in the shapes that actually appear', () => {
  assert.equal(parseQuantity('2 cups flour')?.qty, 2);
  assert.equal(parseQuantity('2.5 cups')?.qty, 2.5);
  assert.equal(parseQuantity('1/2 tsp salt')?.qty, 0.5);
  assert.equal(parseQuantity('1 1/2 cups')?.qty, 1.5);
  assert.equal(parseQuantity('1½ cups')?.qty, 1.5);
  assert.equal(parseQuantity('2-3 cloves')?.qty, 2);
  assert.equal(parseQuantity('2-3 cloves')?.qtyMax, 3);
  assert.equal(parseQuantity('2 to 3 tbsp')?.qtyMax, 3);
  assert.equal(parseQuantity('a pinch of salt')?.qty, 1);
  assert.equal(parseQuantity('Salt and pepper to taste'), null);
});

test('matches units as whole tokens only', () => {
  assert.equal(matchLeadingUnit('cups flour')?.unit.canonical, 'cup');
  assert.equal(matchLeadingUnit('tbsp. olive oil')?.unit.canonical, 'tbsp');
  assert.equal(matchLeadingUnit('fl oz milk')?.unit.canonical, 'fl oz');
  // "galangal" must not match the "gal" (gallon) alias
  assert.equal(matchLeadingUnit('galangal, sliced'), null);
});

test('converts to grams only when it genuinely can', () => {
  assert.equal(toGrams(2, findUnit('kg')), 2000);
  assert.equal(toGrams(1, findUnit('cup')), null, 'volume without a density must stay null');
  assert.equal(toGrams(1, findUnit('cup'), { density_g_per_ml: 0.53, grams_per_unit: {} }), 125.39);
  assert.equal(toGrams(2, findUnit('clove'), { grams_per_unit: { clove: 3 } }), 6);
});

test('splits an ingredient line into qty / unit / name / prep', () => {
  const parsed = parseIngredient('2 cloves garlic, finely chopped', { index: 0 });
  assert.equal(parsed.qty, 2);
  assert.equal(parsed.unit, 'clove');
  assert.equal(parsed.name, 'garlic');
  assert.equal(parsed.prep, 'finely chopped');

  const flour = parseIngredient('1½ cups all-purpose flour, sifted', { index: 1 });
  assert.equal(flour.qty, 1.5);
  assert.equal(flour.unit, 'cup');
  assert.equal(flour.name, 'all-purpose flour');
  assert.equal(flour.prep, 'sifted');

  const optional = parseIngredient('1 tsp chili flakes (optional)', { index: 2 });
  assert.equal(optional.optional, true);

  const bare = parseIngredient('Salt and pepper to taste', { index: 3 });
  assert.equal(bare.qty, null);
  assert.equal(bare.optional, true);
});

test('multiplies a package-size parenthetical into the total quantity', () => {
  const parsed = parseIngredient('2 (14 oz) cans diced tomatoes', { index: 0 });
  assert.equal(parsed.qty, 28);
  assert.equal(parsed.unit, 'oz');
  // The container noun is absorbed into the total, not left on the name.
  assert.equal(parsed.name, 'diced tomatoes');

  const single = parseIngredient('1 (400g) tin chickpeas, drained', { index: 0 });
  assert.equal(single.qty, 400);
  assert.equal(single.unit, 'g');
  assert.equal(single.name, 'chickpeas');
  assert.equal(single.prep, 'drained');
});

test('formats amounts back into the display string the app shows', () => {
  assert.equal(formatAmount(parseIngredient('1/2 cup milk', { index: 0 })), '½ cup');
  assert.equal(formatAmount(parseIngredient('2-3 cloves garlic', { index: 0 })), '2-3 clove');
  assert.equal(formatAmount(parseIngredient('Salt to taste', { index: 0 })), '');
});

test('parses durations, taking the upper bound of a range', () => {
  assert.equal(parseIsoDuration('PT1H25M'), 5100);
  assert.equal(parseIsoDuration('PT30M'), 1800);
  assert.equal(parseHumanDuration('20-25 minutes'), 1500, 'upper bound wins');
  assert.equal(parseHumanDuration('1 hr 25 mins'), 5100);
  assert.equal(parseHumanDuration('no time here'), null);
});

test('parses servings and formats cooking time', () => {
  assert.equal(parseServings('4 servings'), 4);
  assert.equal(parseServings('Serves 4-6'), 5);
  assert.equal(formatCookingTime(5100), '1h 25m');
  assert.equal(formatCookingTime(1800), '30m');
  assert.equal(formatCookingTime(null), null);
});

test('segments long paragraphs into voice-sized cards', () => {
  const long =
    'Heat the oil in a large skillet over medium heat until shimmering and hot. ' +
    'Add the onions and cook until softened and translucent, about 5 minutes total. ' +
    'Stir in the garlic and cook for one more minute until fragrant and lightly golden. ' +
    'Pour in the tomatoes and bring everything to a gentle simmer over low heat.';
  const steps = segmentSteps([long]);
  assert.ok(steps.length > 1, 'should split');
  assert.ok(steps.every((s) => s.text.length <= 300), 'no card over the hard cap');
  assert.deepEqual(steps.map((s) => s.index), steps.map((_, i) => i), 'indices are contiguous');
});

test('strips numbering prefixes from steps', () => {
  const steps = segmentSteps(['Step 1: Preheat the oven.', '2. Grease the tin.']);
  assert.equal(steps[0]!.text, 'Preheat the oven.');
  assert.equal(steps[1]!.text, 'Grease the tin.');
});

test('normalizes ingredient names down to their identity', () => {
  assert.equal(normalizeName('large free-range eggs'), 'egg');
  assert.equal(normalizeName('Fresh Tomatoes'), 'tomato');
  assert.equal(normalizeName('boneless skinless chicken thighs'), 'chicken thigh');
});

test('canonicalizes URLs so syndicated links collapse to one key', () => {
  assert.equal(
    canonicalizeUrl('https://www.example.com/recipe/pho/?utm_source=x&a=1#top'),
    'https://example.com/recipe/pho?a=1',
  );
  assert.equal(canonicalizeUrl('http://example.com/a/'), 'https://example.com/a');
});

test('extracts a Recipe from @graph JSON-LD', () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', name: 'ignore me' },
      {
        '@type': ['Recipe'],
        name: 'Test Pho',
        recipeYield: '4 servings',
        totalTime: 'PT2H',
        image: [{ '@type': 'ImageObject', url: 'https://img.test/a.jpg' }],
        recipeIngredient: ['2 lb beef bones', '1 onion, halved'],
        recipeInstructions: [
          { '@type': 'HowToSection', itemListElement: [
            { '@type': 'HowToStep', text: 'Char the onion.' },
            { '@type': 'HowToStep', text: 'Simmer the bones for 2 hours.' },
          ] },
        ],
        aggregateRating: { ratingValue: '4.8', ratingCount: '211' },
      },
    ],
  })}</script></head><body></body></html>`;

  const recipe = extractJsonLd(html);
  assert.ok(recipe);
  assert.equal(recipe.name, 'Test Pho');
  assert.equal(recipe.recipeIngredient?.length, 2);
  assert.deepEqual(recipe.recipeInstructions, ['Char the onion.', 'Simmer the bones for 2 hours.']);
  assert.equal(recipe.image?.[0], 'https://img.test/a.jpg');
  assert.equal(recipe.ratingValue, 4.8);
  assert.equal(recipe.ratingCount, 211);
});

test('jsonld collapses CDN resize variants of one photo', () => {
  const base = 'https://img.test/chowder.jpg';
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: 'Corn Chowder',
    image: [
      base,
      `${base}?resize=500%2C500`,
      `${base}?resize=480%2C270`,
      'https://img.test/chowder-step-1.jpg',
      'not-a-url',
    ],
    recipeIngredient: ['1 cup corn'],
    recipeInstructions: ['Simmer.'],
  })}</script></head><body></body></html>`;

  const recipe = extractJsonLd(html);
  assert.ok(recipe);
  // The unresized original wins, and the genuinely different photo survives.
  assert.deepEqual(recipe.image, [base, 'https://img.test/chowder-step-1.jpg']);
});
