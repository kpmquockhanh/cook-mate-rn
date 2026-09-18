import type { TranslationKey } from './i18n/en';
import type { Diet, Difficulty, FacetFilter, MainIngredient, Meal } from './recipeFacets';

/**
 * Facet value -> translation key.
 *
 * Written out rather than built as `facet.${value}` so that adding a facet
 * without its string is a type error here instead of a raw key on screen.
 */
export const MEAL_LABEL: Record<Meal, TranslationKey> = {
  breakfast: 'facet.breakfast',
  lunch: 'facet.lunch',
  dinner: 'facet.dinner',
  dessert: 'facet.dessert',
  snack: 'facet.snack',
  basics: 'facet.basics',
};

export const DIFFICULTY_LABEL: Record<Difficulty, TranslationKey> = {
  easy: 'facet.easy',
  medium: 'facet.medium',
  hard: 'facet.hard',
};

export const INGREDIENT_LABEL: Record<MainIngredient, TranslationKey> = {
  chicken: 'facet.chicken',
  beef: 'facet.beef',
  pork: 'facet.pork',
  seafood: 'facet.seafood',
  pasta: 'facet.pasta',
  egg: 'facet.egg',
  veg: 'facet.veg',
};

export const DIET_LABEL: Record<Diet, TranslationKey> = {
  vegetarian: 'facet.vegetarian',
  vegan: 'facet.vegan',
  pescatarian: 'facet.pescatarian',
  gluten_free: 'facet.glutenFree',
};

const MAX_MINUTES_LABEL: Record<number, TranslationKey> = {
  15: 'facet.under15',
  30: 'facet.under30',
  60: 'facet.under60',
};

/**
 * The keys naming an active filter, in the order they read as a phrase:
 * "Under 30 min · Chicken". One filter is the common case; the list keeps a
 * two-facet deep link honest rather than showing only half of what it applied.
 */
export function describeFilter(filter: FacetFilter): TranslationKey[] {
  const parts: TranslationKey[] = [];
  if (filter.favorites) parts.push('facet.saved');
  if (filter.popular) parts.push('facet.popular');
  if (filter.handsOff) parts.push('facet.handsOff');
  if (filter.maxMinutes && MAX_MINUTES_LABEL[filter.maxMinutes]) {
    parts.push(MAX_MINUTES_LABEL[filter.maxMinutes]!);
  }
  if (filter.difficulty) parts.push(DIFFICULTY_LABEL[filter.difficulty]);
  if (filter.diet) parts.push(DIET_LABEL[filter.diet]);
  if (filter.meal) parts.push(MEAL_LABEL[filter.meal]);
  if (filter.mainIngredient) parts.push(INGREDIENT_LABEL[filter.mainIngredient]);
  return parts;
}
