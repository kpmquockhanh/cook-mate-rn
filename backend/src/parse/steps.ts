import type { ParsedStep } from '../types.js';
import { collapseWhitespace, decodeEntities } from '../util.js';

/** Cooking mode shows one card and reads it aloud - long steps break both. */
const MAX_STEP_CHARS = 200;
const HARD_MAX_STEP_CHARS = 300;

const STEP_PREFIX = /^(?:step\s*\d+[:.)-]?\s*|\d+[.)]\s+|[-–—•*]\s+)/i;

function sentences(text: string): string[] {
  // Split on sentence enders, but protect decimals ("350.5"), abbreviations
  // ("tbsp."), and temperatures ("F.").
  const protectedText = text
    .replace(/(\d)\.(\d)/g, '$1<DOT>$2')
    .replace(/\b(tbsp|tsp|oz|lb|approx|min|sec|deg|no|vs|etc|e\.g|i\.e)\./gi, '$1<DOT>');

  return protectedText
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((s) => s.replace(/<DOT>/g, '.').trim())
    .filter(Boolean);
}

/**
 * Sources routinely dump three actions into one paragraph. Split into cards,
 * then re-join fragments that are too short to stand alone as an instruction.
 */
export function segmentSteps(rawSteps: string[]): ParsedStep[] {
  const cards: string[] = [];

  for (const raw of rawSteps) {
    const clean = collapseWhitespace(decodeEntities(raw)).replace(STEP_PREFIX, '');
    if (!clean) continue;

    if (clean.length <= MAX_STEP_CHARS) {
      cards.push(clean);
      continue;
    }

    // Split this one source step into several cards, then re-merge orphan
    // fragments WITHIN this group only. Merging across source steps would
    // silently glue two authored instructions together.
    const group: string[] = [];
    let buffer = '';
    for (const sentence of sentences(clean)) {
      const candidate = buffer ? `${buffer} ${sentence}` : sentence;
      if (candidate.length > MAX_STEP_CHARS && buffer) {
        group.push(buffer);
        buffer = sentence;
      } else {
        buffer = candidate;
      }
    }
    if (buffer) group.push(buffer);

    for (const card of group) {
      const previous = cards.at(-1);
      const canMerge =
        previous !== undefined &&
        group.length > 1 &&
        cards.length > 0 &&
        group.indexOf(card) > 0 &&
        card.length < 30 &&
        previous.length + card.length + 1 <= HARD_MAX_STEP_CHARS;
      if (canMerge) cards[cards.length - 1] = `${previous} ${card}`;
      else cards.push(card);
    }
  }

  return cards.map((text, index) => ({ index, text }));
}
