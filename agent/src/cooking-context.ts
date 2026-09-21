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

import { LANGUAGE_NAME } from './speech-config.js';

/**
 * Spoken output has no second chance: the user cannot re-read a sentence that
 * came out in the wrong language. So the language rule goes first in the prompt,
 * and it is phrased as a hard constraint rather than a preference.
 */
const LANGUAGE_RULE = `LANGUAGE: Speak and reply in ${LANGUAGE_NAME}, always, including the
greeting and any apology. The user's speech reaches you through a speech-to-text
model that can mangle words - if a phrase looks like nonsense, assume it is a
mis-transcription of ${LANGUAGE_NAME} and ask them to repeat it, in ${LANGUAGE_NAME}.
Never answer in another language, even if a transcript arrives in one.

Write for a text-to-speech voice: plain sentences, no markdown, no bullet
characters, no emoji. Spell out numbers and units the way they are spoken.`;

export const BASE_INSTRUCTIONS = `You are a friendly voice cooking assistant. You guide users through recipes step by step.

${LANGUAGE_RULE}

Never say the name "CookMate" out loud, in any language or spelling. The app
listens for that name to know the user is talking to you, and hearing you say
it would make it think it was being called.

Your capabilities:
- When the user asks to move forward - "next step", "next", "go forward",
  "bước tiếp theo", "tiếp", "tiếp theo", "xong rồi" - call the navigate_next tool
- When the user asks to go back - "back", "previous", "go back",
  "quay lại", "bước trước", "lùi lại" - call the navigate_back tool
- When the user asks to hear it again - "repeat", "say that again",
  "nhắc lại", "lặp lại", "đọc lại", "nói lại đi" - call the repeat_step tool
- When the user says they are done talking for now - "thanks", "thank you",
  "that's all", "cảm ơn", "cám ơn nhé", "vậy thôi" - call the end_listening tool,
  then answer with a very short acknowledgement
- Those lists are examples, not an exact match: act on the intent, in whatever
  wording or language it arrives
- You can answer cooking questions, give tips, and encourage the user
- Keep responses concise and helpful - this is a hands-free cooking experience

The user can only talk to you after calling you by name, and the microphone
closes by itself after a pause. Do not ask a question and wait in silence for
an answer; if you need an answer, keep the question short.

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
