import type { Diet, Difficulty, MainIngredient, Meal } from '../hooks/useRecipes';

export type { Diet, Difficulty, MainIngredient, Meal };

/**
 * A recipe's facets, as the API now hands them over.
 *
 * This file used to guess all of this from the title and the scraped
 * `category`, because no column carried it. Migration 0012 added the columns
 * and publish/facets.ts fills them from what the pipeline actually knows - the
 * enrichment model's reading of the dish, and the canonical ingredient links -
 * so the guessing is gone and what is left is a thin read.
 */

export interface RecipeFacets {
  /** Total time in minutes, or null when the pipeline could not determine one. */
  minutes: number | null;
  /**
   * Hands-on minutes: the total minus every stretch the enricher marked as
   * unattended. This is the number no recipe site publishes.
   */
  activeMinutes: number | null;
  meal: Meal | null;
  mainIngredient: MainIngredient | null;
  difficulty: Difficulty | null;
  /** Empty means unknown, never "none": see the diet note in migration 0012. */
  diet: Diet[];
  handsOff: boolean;
}

/**
 * Mirrors HANDS_OFF_* in backend/src/api/schema.ts. The server owns the
 * filter; these are here only so a card can show the badge on a row it already
 * has, without asking again.
 */
export const HANDS_OFF_MAX_ACTIVE_MINUTES = 20;
export const HANDS_OFF_MIN_TOTAL_MINUTES = 60;

export function facetsOf(recipe: Record<string, any>): RecipeFacets {
  const minutes = typeof recipe?.totalMinutes === 'number' ? recipe.totalMinutes : null;
  const activeMinutes = typeof recipe?.activeMinutes === 'number' ? recipe.activeMinutes : null;
  const difficulty = recipe?.difficulty;

  return {
    minutes,
    activeMinutes,
    meal: recipe?.meal ?? null,
    mainIngredient: recipe?.mainIngredient ?? recipe?.main_ingredient ?? null,
    difficulty:
      difficulty === 'easy' || difficulty === 'medium' || difficulty === 'hard' ? difficulty : null,
    diet: Array.isArray(recipe?.diet) ? recipe.diet : [],
    handsOff:
      activeMinutes !== null &&
      minutes !== null &&
      activeMinutes <= HANDS_OFF_MAX_ACTIVE_MINUTES &&
      minutes >= HANDS_OFF_MIN_TOTAL_MINUTES,
  };
}

/**
 * Everything a user can narrow by. Each field maps to one API parameter, so a
 * filter travels unchanged from a chip, through the route, into the query.
 */
export interface FacetFilter {
  meal?: Meal;
  mainIngredient?: MainIngredient;
  diet?: Diet;
  difficulty?: Difficulty;
  /** Total-time ceiling in minutes. */
  maxMinutes?: number;
  handsOff?: boolean;
  favorites?: boolean;
  popular?: boolean;
}

/** True when a filter would not actually narrow anything. */
export function isEmptyFilter(filter: FacetFilter): boolean {
  return (
    !filter.meal &&
    !filter.mainIngredient &&
    !filter.diet &&
    !filter.difficulty &&
    !filter.maxMinutes &&
    !filter.handsOff &&
    !filter.favorites &&
    !filter.popular
  );
}
