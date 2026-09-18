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

const MEALS: Meal[] = ['breakfast', 'lunch', 'dinner', 'dessert', 'snack', 'basics'];
const INGREDIENTS: MainIngredient[] = ['chicken', 'beef', 'pork', 'seafood', 'pasta', 'egg', 'veg'];
const DIETS: Diet[] = ['vegetarian', 'vegan', 'pescatarian', 'gluten_free'];
const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

/** The ceilings a chip may ask for. An arbitrary number in the URL is dropped. */
const MAX_MINUTES = [15, 30, 60];

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
