import type { Diet, Difficulty, FacetFilter, MainIngredient, Meal } from './recipeFacets';

/**
 * A facet filter, carried in the URL.
 *
 * Home never filters in place - every chip and every "See all" hands off to
 * All Recipes with the filter in the route. One list screen owns results,
 * paging and the empty state, and a filtered view is shareable and survives a
 * reload. The names here match the API's query parameters, so the same filter
 * describes a screen and a request.
 */

/**
 * The values a facet may take, in the order the filter sheet offers them.
 * Exported because the sheet has to build its options out of exactly what this
 * module will accept back - an option nobody could parse is a dead button.
 */
export const MEALS: Meal[] = ['breakfast', 'lunch', 'dinner', 'dessert', 'snack', 'basics'];
export const INGREDIENTS: MainIngredient[] = [
  'chicken', 'beef', 'pork', 'seafood', 'pasta', 'egg', 'veg',
];
export const DIETS: Diet[] = ['vegetarian', 'vegan', 'pescatarian', 'gluten_free'];
export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

/** The ceilings a chip may ask for. An arbitrary number in the URL is dropped. */
export const MAX_MINUTES = [15, 30, 60];

function pick<T extends string>(value: unknown, allowed: T[]): T | undefined {
  return typeof value === 'string' && (allowed as string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** Route params -> filter. Anything unrecognised is dropped, never guessed. */
export function facetFilterFromParams(params: Record<string, unknown>): FacetFilter {
  const filter: FacetFilter = {
    meal: pick(params.meal, MEALS),
    mainIngredient: pick(params.ingredient, INGREDIENTS),
    diet: pick(params.diet, DIETS),
    difficulty: pick(params.difficulty, DIFFICULTIES),
  };

  const maxMinutes = Number(params.maxMinutes);
  if (MAX_MINUTES.includes(maxMinutes)) filter.maxMinutes = maxMinutes;

  if (params.handsOff === '1') filter.handsOff = true;
  if (params.favorites === '1') filter.favorites = true;
  if (params.popular === '1') filter.popular = true;
  return filter;
}

/** Filter -> route params, with the absent facets left out entirely. */
export function facetFilterToParams(filter: FacetFilter): Record<string, string> {
  const params: Record<string, string> = {};
  if (filter.meal) params.meal = filter.meal;
  if (filter.mainIngredient) params.ingredient = filter.mainIngredient;
  if (filter.diet) params.diet = filter.diet;
  if (filter.difficulty) params.difficulty = filter.difficulty;
  if (filter.maxMinutes) params.maxMinutes = String(filter.maxMinutes);
  if (filter.handsOff) params.handsOff = '1';
  if (filter.favorites) params.favorites = '1';
  if (filter.popular) params.popular = '1';
  return params;
}

/**
 * Every route param a facet can occupy, whether or not the filter uses it.
 *
 * Replacing a filter means clearing the facets it dropped as well as writing
 * the ones it kept, and expo-router only removes a param that is explicitly
 * undefined - a key merely left out stays on the URL.
 */
export const FACET_PARAM_KEYS = [
  'meal',
  'ingredient',
  'diet',
  'difficulty',
  'maxMinutes',
  'handsOff',
  'favorites',
  'popular',
] as const;

/** Filter -> the full set of params, with every unused facet set to undefined. */
export function facetFilterToParamPatch(
  filter: FacetFilter
): Record<(typeof FACET_PARAM_KEYS)[number], string | undefined> {
  const params = facetFilterToParams(filter);
  return Object.fromEntries(
    FACET_PARAM_KEYS.map((key) => [key, params[key]])
  ) as Record<(typeof FACET_PARAM_KEYS)[number], string | undefined>;
}
