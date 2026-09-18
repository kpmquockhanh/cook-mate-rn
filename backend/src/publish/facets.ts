import type { EnrichmentResult, Meal, ParsedIngredient, StagingRow } from '../types.js';

/**
 * The facets the app navigates by, derived once at publish time.
 *
 * Everything here answers a question a cook actually arrives with - when do I
 * eat this, how long does it take, how much of that time am I working, what is
 * in it, can I eat it - rather than exposing what the scrape happened to say.
 * The client used to guess all of this from the title; this is where that guess
 * is replaced by the pipeline's own knowledge.
 */

export type MainIngredient =
  | 'chicken' | 'beef' | 'pork' | 'seafood' | 'pasta' | 'egg' | 'veg';

export type Diet = 'vegetarian' | 'vegan' | 'pescatarian' | 'gluten_free';

export interface RecipeFacets {
  totalTimeSeconds: number | null;
  activeTimeSeconds: number | null;
  meal: Meal | null;
  mainIngredient: MainIngredient | null;
  diet: Diet[];
  cuisine: string | null;
}

/** What the canonical dictionary knows about one ingredient. */
export interface CanonicalFact {
  slug: string;
  /** meat | seafood | dairy | egg | animal | gluten - see migration 0012. */
  dietaryTags: string[];
}

// --- Time -------------------------------------------------------------------

/**
 * Hands-on time: the total, minus every stretch the enricher marked as
 * unattended waiting.
 *
 * `durationSeconds` is only ever set for waiting the cook walks away from
 * (enrich/llm.ts is explicit about that), so summing it is exactly the passive
 * time. Clamped at zero because a source's stated total is sometimes shorter
 * than its own steps add up to, and a negative number on a card is worse than
 * a zero.
 */
export function activeTimeSeconds(
  totalSeconds: number | null,
  steps: EnrichmentResult['steps'],
): number | null {
  if (totalSeconds === null) return null;
  const passive = steps.reduce((sum, step) => sum + (step.durationSeconds ?? 0), 0);
  return Math.max(0, totalSeconds - passive);
}

// --- Main ingredient --------------------------------------------------------

/**
 * Canonical slug -> the ingredient a cook would say the dish is "a chicken
 * one" or "a pasta one" because of. Only the slugs that carry a dish; salt and
 * olive oil are in every recipe and name none of them.
 */
const SLUG_TO_INGREDIENT: Record<string, MainIngredient> = {
  'chicken-breast': 'chicken',
  'chicken-thigh': 'chicken',
  'whole-chicken': 'chicken',
  'ground-beef': 'beef',
  'beef-steak': 'beef',
  'pork-belly': 'pork',
  'ground-pork': 'pork',
  bacon: 'pork',
  shrimp: 'seafood',
  salmon: 'seafood',
  'white-fish': 'seafood',
  pasta: 'pasta',
  'rice-noodles': 'pasta',
  egg: 'egg',
  'egg-yolk': 'egg',
  'egg-white': 'egg',
  tofu: 'veg',
};

/**
 * Which one wins when a recipe has several: the animal protein a dish is named
 * for beats its starch, so a chicken noodle soup is a chicken recipe. The one
 * arguable case is cured pork used as seasoning - a carbonara comes out "pork"
 * rather than "pasta" - which is worth a rule of its own only once the
 * dictionary can tell a lardon from a pork chop.
 */
const INGREDIENT_PRIORITY: MainIngredient[] = [
  'seafood', 'chicken', 'beef', 'pork', 'pasta', 'egg', 'veg',
];

export function mainIngredient(facts: CanonicalFact[]): MainIngredient | null {
  const present = new Set<MainIngredient>();
  let sawMeatOrFish = false;

  for (const fact of facts) {
    const mapped = SLUG_TO_INGREDIENT[fact.slug];
    if (mapped) present.add(mapped);
    if (fact.dietaryTags.includes('meat') || fact.dietaryTags.includes('seafood')) {
      sawMeatOrFish = true;
    }
  }

  // The priority list settles anything it can name, so only the empty case
  // needs a rule: nothing named and no animal protein at all is vegetable-led,
  // while an unrecognised meat (lamb, duck) names nothing rather than lying.
  const found = INGREDIENT_PRIORITY.find((candidate) => present.has(candidate));
  if (found) return found;
  return sawMeatOrFish || facts.length === 0 ? null : 'veg';
}

// --- Diet -------------------------------------------------------------------

/**
 * What someone can eat, claimed only when every ingredient is accounted for.
 *
 * `complete` is false when any ingredient of the recipe failed to match the
 * canonical dictionary. An unmatched string could be anything, and telling a
 * vegetarian that a dish is safe on the strength of the ingredients we happened
 * to recognise is the one mistake here that actually harms someone. Unknown is
 * an empty list, and the API's diet filter simply does not return the recipe.
 */
export function diets(facts: CanonicalFact[], complete: boolean): Diet[] {
  if (!complete || facts.length === 0) return [];

  const tags = new Set(facts.flatMap((fact) => fact.dietaryTags));
  const out: Diet[] = [];

  const hasMeat = tags.has('meat');
  const hasSeafood = tags.has('seafood');

  if (!hasMeat && !hasSeafood) {
    out.push('vegetarian');
    if (!tags.has('dairy') && !tags.has('egg') && !tags.has('animal')) out.push('vegan');
  }
  // Pescatarian is the weaker claim, so every vegetarian recipe is one too.
  if (!hasMeat) out.push('pescatarian');
  if (!tags.has('gluten')) out.push('gluten_free');

  return out;
}

// --- Meal -------------------------------------------------------------------

/**
 * The fallback for rows enriched before the model was asked for a meal
 * (enrichment version 1). Matched against `title + ' ' + category`, first hit
 * wins, narrower meanings first. Re-enriching replaces this with the model's
 * own reading; nothing here is meant to be better than that.
 */
// prettier-ignore
const MEAL_KEYWORDS: [Meal, string[]][] = [
  ['breakfast', ['breakfast', 'pancake', 'waffle', 'french toast', 'omelet', 'omelette',
                 'hash brown', 'shakshuka', 'huevos', 'granola', 'porridge', 'oatmeal',
                 'croque', 'brunch']],
  ['basics', ['sauce', 'marinade', 'dressing', 'stock', 'broth', 'seasoning', 'spice mix',
              'dip', 'condiment']],
  ['snack', ['snack', 'appetizer', 'starter']],
  ['dessert', ['dessert', 'cake', 'mousse', 'frosting', 'cookie', 'brownie', 'pudding',
               'ice cream', 'pie', 'sweet']],
  ['lunch', ['lunch', 'salad', 'sandwich', 'wrap', 'toastie', 'soup', 'chowder', 'bowl']],
  ['dinner', ['dinner', 'main', 'roast', 'steak', 'stew', 'chili', 'curry', 'pasta',
              'noodle', 'stir-fry', 'stir fry', 'casserole', 'bake', 'one dish meal',
              'grilling', 'fajita', 'ragu']],
];

export function mealFromText(title: string | null, category: string | null): Meal | null {
  const haystack = `${title ?? ''} ${category ?? ''}`.toLowerCase();
  for (const [meal, keywords] of MEAL_KEYWORDS) {
    if (keywords.some((keyword) => haystack.includes(keyword))) return meal;
  }
  return null;
}

// --- The whole set ----------------------------------------------------------

/**
 * `facts` carries one entry per ingredient that resolved to the dictionary, and
 * `ingredients` is every ingredient the recipe has - the two lengths are what
 * decides whether a diet may be claimed.
 */
export function deriveFacets(
  row: Pick<StagingRow, 'title' | 'category' | 'cuisine' | 'total_time_seconds'> & {
    ingredients: ParsedIngredient[];
  },
  enriched: EnrichmentResult,
  facts: CanonicalFact[],
): RecipeFacets {
  const total = enriched.totalTimeSeconds ?? row.total_time_seconds ?? null;
  const allMatched = facts.length === row.ingredients.length;

  return {
    totalTimeSeconds: total,
    activeTimeSeconds: activeTimeSeconds(total, enriched.steps),
    meal: enriched.meal ?? mealFromText(row.title, row.category),
    mainIngredient: mainIngredient(facts),
    diet: diets(facts, allMatched),
    // The site's own label first: it is the publisher's claim about their own
    // dish. The model only fills the 71% of rows where the scrape said nothing.
    cuisine: row.cuisine ?? enriched.cuisine ?? null,
  };
}
