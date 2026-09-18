import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitize, buildUserMessage, type EnrichInput } from '../src/enrich/llm.js';
import { EnrichmentSchema, type EnrichmentPayload } from '../src/enrich/schema.js';
import { isProviderName, PROVIDERS } from '../src/enrich/providers/index.js';
import type { ParsedIngredient, ParsedStep } from '../src/types.js';

function ingredient(index: number, raw: string): ParsedIngredient {
  return {
    index,
    raw,
    name: raw,
    prep: null,
    qty: null,
    qtyMax: null,
    unit: null,
    qtyGrams: null,
    canonicalId: null,
    optional: false,
  } as ParsedIngredient;
}

function input(): EnrichInput {
  return {
    title: 'Test soup',
    ingredients: [ingredient(0, '2 onions'), ingredient(1, '1 tbsp oil')],
    steps: [
      { index: 0, text: 'Chop the onions.' },
      { index: 1, text: 'Simmer for 25 minutes.' },
    ] as ParsedStep[],
    servingsHint: 4,
    totalTimeHint: 1800,
  };
}

function payload(overrides: Partial<EnrichmentPayload> = {}): EnrichmentPayload {
  return {
    steps: [
      { index: 0, ingredientIndices: [0], durationSeconds: null, timerName: null, isPassive: false },
      { index: 1, ingredientIndices: [], durationSeconds: 1500, timerName: 'Simmer soup', isPassive: true },
    ],
    notes: ['Salt at the end.'],
    difficulty: 'easy',
    meal: 'dinner',
    cuisine: null,
    servings: 4,
    totalTimeSeconds: 1800,
    aiScore: 7.5,
    ...overrides,
  };
}

// The seam itself: every registered provider must satisfy the same contract,
// because llm.ts owns the prompt and sanitize regardless of which one runs.
test('every registered provider exposes the same contract', () => {
  for (const [name, provider] of Object.entries(PROVIDERS)) {
    assert.equal(provider.name, name, `${name} must report its own registry key`);
    assert.equal(typeof provider.complete, 'function');
  }
  assert.ok(isProviderName('anthropic'));
  assert.ok(isProviderName('deepseek'));
  assert.equal(isProviderName('gpt-5'), false);
});

test('the schema a provider must satisfy accepts a well-formed payload', () => {
  assert.ok(EnrichmentSchema.safeParse(payload()).success);
});

// These are the failures an unconstrained provider (DeepSeek's json_object)
// can actually emit, where Anthropic's constrained decoding cannot.
test('sanitize drops ingredient indices the model invented', () => {
  const result = sanitize(payload({
    steps: [
      { index: 0, ingredientIndices: [0, 7, -1], durationSeconds: null, timerName: null, isPassive: false },
      { index: 1, ingredientIndices: [], durationSeconds: 1500, timerName: 'Simmer soup', isPassive: true },
    ],
  }), input());
  assert.deepEqual(result.steps[0]!.ingredientIndices, [0], 'index 7 and -1 do not exist');
});

test('sanitize rejects durations outside the plausible band', () => {
  const tooShort = sanitize(payload({
    steps: [
      { index: 0, ingredientIndices: [], durationSeconds: 5, timerName: 'Nope', isPassive: false },
      { index: 1, ingredientIndices: [], durationSeconds: 1500, timerName: 'Simmer soup', isPassive: true },
    ],
  }), input());
  assert.equal(tooShort.steps[0]!.durationSeconds, null, '5s is a seconds/minutes slip');
  assert.equal(tooShort.steps[0]!.timerName, null, 'no duration means no timer name');
  assert.equal(tooShort.steps[1]!.durationSeconds, 1500);
});

test('sanitize rebuilds every input step even when the model skips one', () => {
  const result = sanitize(payload({
    steps: [
      { index: 0, ingredientIndices: [0], durationSeconds: null, timerName: null, isPassive: false },
    ],
  }), input());
  assert.equal(result.steps.length, 2, 'step 1 must survive as an un-enriched step');
  assert.equal(result.steps[1]!.text, 'Simmer for 25 minutes.');
  assert.equal(result.steps[1]!.durationSeconds, null);
});

test('sanitize caps notes at three and falls back to the parsed hints', () => {
  const result = sanitize(payload({
    notes: ['a', 'b', 'c', 'd'],
    servings: null,
    totalTimeSeconds: null,
  }), input());
  assert.equal(result.notes.length, 3);
  assert.equal(result.servings, 4, 'falls back to the parsed servings hint');
  assert.equal(result.totalTimeSeconds, 1800);
});

test('sanitize clamps and rounds aiScore to one decimal', () => {
  const result = sanitize(payload({ aiScore: 12.34 }), input());
  assert.equal(result.aiScore, 10, 'clamped to the 0-10 band');
  assert.equal(sanitize(payload({ aiScore: 6.28 }), input()).aiScore, 6.3);
});

test('the user message numbers ingredients and steps for index-based linking', () => {
  const message = buildUserMessage(input());
  assert.match(message, /0: 2 onions/);
  assert.match(message, /1: Simmer for 25 minutes\./);
});
