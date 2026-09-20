import type { RecipeDetail } from '../hooks/useRecipe';
import { formatDuration } from './duration';

/**
 * The app publishes the live cooking state to the voice agent as a participant
 * attribute under this key. The agent reads it on join and on every change, so
 * it always knows which recipe is open and which step the user is on - including
 * when the user taps the on-screen Next/Previous buttons instead of speaking.
 *
 * The agent side of this contract lives in `agent/src/cooking-context.ts`.
 * Keep the two in sync.
 */
export const COOKING_STATE_ATTRIBUTE = 'cookmate_state';

/** Attribute values are capped by the server; stay well under the limit. */
const MAX_ATTRIBUTE_BYTES = 8000;

export interface CookingState {
  title: string;
  servings: number;
  cookingTime: string;
  /** 1-based, to match what the user sees on screen. */
  currentStep: number;
  totalSteps: number;
  currentStepText: string;
  /** Ingredients the current step calls for, if the recipe tags them. */
  currentStepIngredients: string[];
  /** Every step, so the agent can look ahead or summarise. */
  steps: string[];
  ingredients: string[];
}

export function buildCookingState(
  recipe: RecipeDetail | null,
  currentStep: number
): CookingState | null {
  if (!recipe) return null;

  const instructions = recipe.instructions || [];
  const stepIngredientNames = instructions[currentStep]?.ingredients || [];

  return {
    title: recipe.title,
    servings: recipe.servings,
    // Spoken aloud by the agent, so it follows the screen's language rather
    // than the scraper's.
    cookingTime: formatDuration(recipe.totalMinutes) ?? recipe.cookingTime,
    currentStep: currentStep + 1,
    totalSteps: instructions.length,
    currentStepText: instructions[currentStep]?.instruction_text || '',
    currentStepIngredients: stepIngredientNames,
    steps: instructions.map((step) => step.instruction_text || ''),
    ingredients: (recipe.ingredients || []).map((ing) =>
      [ing.amount, ing.ingredient_text].filter(Boolean).join(' ').trim()
    ),
  };
}

/**
 * Serialise for transport, dropping the bulky look-ahead fields rather than
 * letting an unusually long recipe blow the attribute size limit.
 */
export function serializeCookingState(state: CookingState): string {
  const full = JSON.stringify(state);
  if (full.length <= MAX_ATTRIBUTE_BYTES) return full;

  return JSON.stringify({
    ...state,
    steps: [],
    ingredients: [],
  });
}
