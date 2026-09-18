import { apiFetch } from './api';
import { logger } from './log';

const log = logger('events');

/**
 * What the user did with a recipe, reported to public.user_recipe_events
 * (migration 0013).
 *
 * This is what makes "popular" mean something. The rail used to order by the
 * source site's own rating - 5.00 on nearly every row, because sites keep the
 * recipes their readers liked - which said nothing about this app at all.
 *
 * Fire-and-forget by design: nothing on screen waits for it, and a failed
 * report is a lost data point, never an error the cook has to deal with
 * mid-recipe.
 */
export type RecipeEvent = 'viewed' | 'started' | 'completed';

export function reportRecipeEvent(recipeId: string | number, kind: RecipeEvent): void {
  void apiFetch(`/recipes/${recipeId}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind }),
  }).catch((error) => {
    log.debug(`could not report ${kind}`, String(error));
  });
}
