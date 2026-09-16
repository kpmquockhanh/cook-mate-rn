/**
 * Agent-side mirror of the contract the app publishes.
 *
 * The app side lives in `lib/cookingContext.ts`. The two packages build
 * separately, so this interface is duplicated rather than imported - keep them
 * in sync when either changes.
 */
export const COOKING_STATE_ATTRIBUTE = 'cookmate_state';

export interface CookingState {
  title: string;
  servings: number;
  cookingTime: string;
  /** 1-based, to match what the user sees on screen. */
  currentStep: number;
  totalSteps: number;
  currentStepText: string;
  currentStepIngredients: string[];
  steps: string[];
  ingredients: string[];
}

export function parseCookingState(raw: string | undefined): CookingState | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CookingState;
  } catch (err) {
    console.error('[cookmate] Could not parse cooking state attribute:', err);
    return null;
  }
}

export const BASE_INSTRUCTIONS = `You are CookMate, a friendly voice cooking assistant. You guide users through recipes step by step.

Your capabilities:
- When the user says "next step", "next", or "go forward", call the navigate_next tool
- When the user says "back", "previous", or "go back", call the navigate_back tool  
- When the user says "repeat", "repeat step", or "say that again", call the repeat_step tool
- You can answer cooking questions, give tips, and encourage the user
- Keep responses concise and helpful - this is a hands-free cooking experience

The navigation tools return the text of the step the app is now showing. Read that
step back to the user in your own words - do not invent step content, and do not
claim a step changed if the tool says it did not.

Always be encouraging and supportive. The user is cooking and may have messy hands.`;

/**
 * Render the live recipe state into the system prompt. The app republishes this
 * on every step change, so what the user sees on screen and what the agent
 * believes stay in step even when they navigate by tapping.
 */
export function buildInstructions(state: CookingState | null): string {
  if (!state) {
    return `${BASE_INSTRUCTIONS}

No recipe is open yet. Ask the user which recipe they would like to cook, and do
not guess at step content until the app tells you what is on screen.`;
  }

  const stepList = state.steps.length
    ? state.steps.map((text, i) => `  ${i + 1}. ${text}`).join('\n')
    : '  (not available)';

  const ingredientList = state.ingredients.length
    ? state.ingredients.map((text) => `  - ${text}`).join('\n')
    : '  (not available)';

  const stepIngredients = state.currentStepIngredients.length
    ? state.currentStepIngredients.join(', ')
    : 'none called out';

  return `${BASE_INSTRUCTIONS}

CURRENT SESSION (this is live - it updates as the user moves through the recipe,
including when they tap the on-screen buttons instead of speaking to you):

Recipe: ${state.title} (serves ${state.servings}, ${state.cookingTime})
The user is on step ${state.currentStep} of ${state.totalSteps}.
Current step: ${state.currentStepText}
Ingredients for this step: ${stepIngredients}

All steps:
${stepList}

All ingredients:
${ingredientList}

Answer questions about this recipe from the information above. If the user asks
something it does not cover, say so rather than inventing an answer.`;
}
