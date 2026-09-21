import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_INSTRUCTIONS } from './cooking-context.js';

test('the agent is told never to say its own name', () => {
  assert.match(BASE_INSTRUCTIONS, /Never say the name "CookMate"/);
});

test('the agent is told how to end a listening window', () => {
  assert.match(BASE_INSTRUCTIONS, /end_listening/);
});
