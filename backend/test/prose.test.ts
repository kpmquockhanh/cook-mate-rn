import assert from 'node:assert/strict';
import test from 'node:test';
import { groundedIn, htmlToText, toExtracted, type ProsePayload } from '../src/crawl/prose.js';

const PAGE = `
<html><head>
  <title>My Grandmother's Phở</title>
  <meta property="og:image" content="/img/pho.jpg">
  <style>.x{color:red}</style>
</head>
<body>
  <nav><a href="/">Home</a><a href="/about">About</a></nav>
  <header>Subscribe to my newsletter!</header>
  <article>
    <h1>My Grandmother's Phở</h1>
    <p>Every Sunday she started the broth before dawn.</p>
    <p>You will need 2 kg of beef bones, 1 onion, charred, 3 star anise,
       a thumb of ginger, and 400 g of rice noodles.</p>
    <p>Simmer the bones for six hours, skimming often. Char the onion and
       ginger over a flame. Add the spices for the last hour. Cook the
       noodles separately and assemble in warm bowls.</p>
    <img src="/img/bowl.jpg">
  </article>
  <footer>Copyright 2019</footer>
  <script>analytics()</script>
</body></html>
`;

const base: ProsePayload = {
  isRecipe: true,
  name: "My Grandmother's Phở",
  description: 'A slow Sunday broth.',
  recipeYield: '4 bowls',
  recipeIngredient: [
    '2 kg beef bones',
    '1 onion, charred',
    '3 star anise',
    'a thumb of ginger',
    '400 g rice noodles',
  ],
  recipeInstructions: [
    'Simmer the bones for six hours, skimming often.',
    'Char the onion and ginger over a flame.',
    'Cook the noodles separately and assemble in warm bowls.',
  ],
  totalTimeMinutes: 420,
  prepTimeMinutes: 30,
  cookTimeMinutes: 390,
  recipeCuisine: 'Vietnamese',
  recipeCategory: 'main course',
};

test('page text keeps the reading order and drops the furniture', () => {
  const text = htmlToText(PAGE);

  assert.ok(text.includes('2 kg of beef bones'));
  assert.ok(text.includes('Simmer the bones'));

  // Navigation, subscription prompts, scripts and styles are not the recipe,
  // and every one of them is something a model could mistake for content.
  assert.ok(!text.includes('analytics()'));
  assert.ok(!text.includes('color:red'));
  assert.ok(!text.includes('Subscribe to my newsletter'));
  assert.ok(!text.includes('About'));

  // Block structure survives as line breaks: an ingredient list is only
  // recognisable as a list if the breaks are still there.
  assert.ok(text.includes('\n'));
});

test('page text is capped, and says so', () => {
  const text = htmlToText(`<html><body><p>${'word '.repeat(5000)}</p></body></html>`, 500);
  assert.ok(text.length < 600);
  assert.ok(text.endsWith('[truncated]'));
});

test('grounding accepts reformatting but rejects invention', () => {
  const text = htmlToText(PAGE);

  // The prompt allows copying a line as written; light reformatting still has
  // the page's own words in it.
  assert.equal(groundedIn(text, ['2 kg beef bones', '400 g rice noodles']), true);

  // A plausible recipe for an entirely different dish: nothing in it is on the
  // page. This is the failure the schema cannot catch.
  assert.equal(
    groundedIn(text, [
      '200 g plain flour',
      '2 large eggs',
      '100 ml whole milk',
      '50 g caster sugar',
    ]),
    false,
  );

  assert.equal(groundedIn(text, []), false);
});

test('a page the model declines produces no recipe', () => {
  const { recipe, reason } = toExtracted(
    { ...base, isRecipe: false, recipeIngredient: [], recipeInstructions: [] },
    htmlToText(PAGE),
    PAGE,
    'https://example.com/recipes',
  );
  assert.equal(recipe, null);
  assert.equal(reason, 'not-a-recipe');
});

test('a result too thin to be a recipe is refused', () => {
  const { recipe, reason } = toExtracted(
    { ...base, recipeIngredient: ['1 onion'], recipeInstructions: [] },
    htmlToText(PAGE),
    PAGE,
    'https://example.com/p/1',
  );
  assert.equal(recipe, null);
  assert.equal(reason, 'too-thin');
});

test('a fabricated result is refused even though it is well formed', () => {
  const { recipe, reason } = toExtracted(
    {
      ...base,
      recipeIngredient: ['200 g plain flour', '2 large eggs', '100 ml whole milk'],
      recipeInstructions: ['Whisk everything together.', 'Fry in a hot pan.'],
    },
    htmlToText(PAGE),
    PAGE,
    'https://example.com/p/1',
  );
  assert.equal(recipe, null);
  assert.equal(reason, 'ungrounded');
});

test('a good result comes back in the same shape tiers A-C produce', () => {
  const { recipe, reason } = toExtracted(
    base,
    htmlToText(PAGE),
    PAGE,
    'https://example.com/blog/grandmothers-pho',
  );

  assert.equal(reason, undefined);
  assert.ok(recipe);
  assert.equal(recipe!.name, "My Grandmother's Phở");
  assert.equal(recipe!.recipeIngredient?.length, 5);
  assert.equal(recipe!.recipeInstructions?.length, 3);

  // Durations arrive as minutes and leave as ISO 8601, because that is what
  // `parse` reads - the stage must not learn that tier D exists.
  assert.equal(recipe!.totalTime, 'PT420M');
  assert.equal(recipe!.prepTime, 'PT30M');

  // Images come from the page's own metadata, resolved against the page URL.
  // Nothing here was produced by the model, so no URL can be invented.
  assert.ok(recipe!.image?.includes('https://example.com/img/pho.jpg'));
  assert.ok(recipe!.image?.includes('https://example.com/img/bowl.jpg'));

  // A prose blog publishes no aggregate rating, and a model asked for one would
  // supply a number nobody measured.
  assert.equal(recipe!.ratingValue, undefined);
  assert.equal(recipe!.ratingCount, undefined);
});

test('a zero or absent duration is omitted rather than sent as PT0M', () => {
  const { recipe } = toExtracted(
    { ...base, totalTimeMinutes: 0, prepTimeMinutes: null, cookTimeMinutes: 45 },
    htmlToText(PAGE),
    PAGE,
    'https://example.com/p/1',
  );
  assert.equal(recipe!.totalTime, undefined);
  assert.equal(recipe!.prepTime, undefined);
  assert.equal(recipe!.cookTime, 'PT45M');
});
