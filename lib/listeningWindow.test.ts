import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONVERSATION_SILENCE_MS,
  INITIAL_WINDOW,
  QUICK_SILENCE_MS,
  WAKE_COOLDOWN_MS,
  stepWindow,
  type WindowEffect,
  type WindowEventType,
  type WindowMode,
  type WindowState,
} from './listeningWindow';

/** Runs events in order and collects every effect, so a test reads like a timeline. */
function run(
  events: [WindowEventType, number][],
  mode: WindowMode = 'quick',
  start: WindowState = INITIAL_WINDOW
): { state: WindowState; effects: WindowEffect[] } {
  let state = start;
  const effects: WindowEffect[] = [];
  for (const [type, now] of events) {
    const step = stepWindow(state, { type, now }, mode);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

test('wake opens the window, unmutes and chimes', () => {
  const { state, effects } = run([['wake', 0]]);
  assert.equal(state.phase, 'open');
  assert.deepEqual(effects, ['unmute', 'playOpenChime']);
  assert.equal(state.deadline, QUICK_SILENCE_MS);
});

test('tap from idle behaves like the wake word', () => {
  const { state, effects } = run([['tap', 0]]);
  assert.equal(state.phase, 'open');
  assert.deepEqual(effects, ['unmute', 'playOpenChime']);
});

test('quick window closes after 8s of silence with a tone', () => {
  const { state, effects } = run([
    ['wake', 0],
    ['tick', QUICK_SILENCE_MS - 1],
  ]);
  assert.equal(state.phase, 'open');
  const closed = stepWindow(state, { type: 'tick', now: QUICK_SILENCE_MS }, 'quick');
  assert.equal(closed.state.phase, 'idle');
  assert.deepEqual(closed.effects, ['mute', 'playCloseTone']);
  assert.deepEqual(effects, ['unmute', 'playOpenChime']);
});

test('speech holds the window open; the clock restarts when everyone is quiet', () => {
  const { state } = run([
    ['wake', 0],
    ['userSpeechStart', 1000],
    ['tick', 20_000],
    ['userSpeechEnd', 21_000],
    ['agentSpeechStart', 22_000],
    ['tick', 40_000],
    ['agentSpeechEnd', 41_000],
  ]);
  assert.equal(state.phase, 'open');
  assert.equal(state.deadline, 41_000 + QUICK_SILENCE_MS);
});

test('conversation mode waits 30s of silence', () => {
  const { state } = run(
    [
      ['wake', 0],
      ['tick', QUICK_SILENCE_MS + 1],
    ],
    'conversation'
  );
  assert.equal(state.phase, 'open');
  assert.equal(state.deadline, CONVERSATION_SILENCE_MS);
  const closed = stepWindow(state, { type: 'tick', now: CONVERSATION_SILENCE_MS }, 'conversation');
  assert.equal(closed.state.phase, 'idle');
});

test('endRequested closes an open window with a tone, and is a no-op when idle', () => {
  const open = run([['wake', 0]]).state;
  const closed = stepWindow(open, { type: 'endRequested', now: 10 }, 'conversation');
  assert.equal(closed.state.phase, 'idle');
  assert.deepEqual(closed.effects, ['mute', 'playCloseTone']);
  assert.deepEqual(
    stepWindow(INITIAL_WINDOW, { type: 'endRequested', now: 0 }, 'quick').effects,
    []
  );
});

test('wake while the agent is speaking interrupts it', () => {
  const { state, effects } = run([
    ['agentSpeechStart', 0],
    ['wake', 100],
  ]);
  assert.equal(state.phase, 'open');
  assert.deepEqual(effects, ['interruptAgent', 'unmute', 'playOpenChime']);
  assert.equal(state.agentSpeaking, false);
  assert.equal(state.deadline, 100 + QUICK_SILENCE_MS);
});

test('wake while already open re-chimes and restarts the clock without unmuting again', () => {
  const { state, effects } = run([
    ['wake', 0],
    ['wake', 5000],
  ]);
  assert.deepEqual(effects, ['unmute', 'playOpenChime', 'playOpenChime']);
  assert.equal(state.deadline, 5000 + QUICK_SILENCE_MS);
});

test('wakes inside the cooldown are ignored', () => {
  const { effects } = run([
    ['wake', 0],
    ['wake', WAKE_COOLDOWN_MS - 1],
  ]);
  assert.deepEqual(effects, ['unmute', 'playOpenChime']);
});

test('tap while open and quiet closes the window', () => {
  const { state, effects } = run([
    ['tap', 0],
    ['tap', 500],
  ]);
  assert.equal(state.phase, 'idle');
  assert.deepEqual(effects, ['unmute', 'playOpenChime', 'mute', 'playCloseTone']);
});

test('tap while the agent is speaking interrupts rather than closing', () => {
  const { state, effects } = run([
    ['tap', 0],
    ['agentSpeechStart', 1000],
    ['tap', 1500],
  ]);
  assert.equal(state.phase, 'open');
  assert.deepEqual(effects, ['unmute', 'playOpenChime', 'interruptAgent', 'playOpenChime']);
});

test('reset closes silently, clears the window, but keeps the speaking flags', () => {
  const open = run([
    ['wake', 0],
    ['userSpeechStart', 10],
  ]).state;
  const step = stepWindow(open, { type: 'reset', now: 20 }, 'quick');
  assert.deepEqual(step.state, { ...INITIAL_WINDOW, userSpeaking: true });
  assert.deepEqual(step.effects, ['mute']);
  assert.deepEqual(stepWindow(INITIAL_WINDOW, { type: 'reset', now: 0 }, 'quick').effects, []);
});

test('a wake after reset while the agent is speaking still interrupts it', () => {
  const midSentence = run([['agentSpeechStart', 0]]).state;
  const afterReset = stepWindow(midSentence, { type: 'reset', now: 10 }, 'quick').state;
  assert.equal(afterReset.agentSpeaking, true);
  const { state, effects } = stepWindow(afterReset, { type: 'wake', now: 20 }, 'quick');
  assert.equal(state.phase, 'open');
  assert.deepEqual(effects, ['interruptAgent', 'unmute', 'playOpenChime']);
});

test('speech while idle is tracked but schedules nothing', () => {
  const { state, effects } = run([['agentSpeechStart', 0]]);
  assert.equal(state.phase, 'idle');
  assert.equal(state.agentSpeaking, true);
  assert.equal(state.deadline, null);
  assert.deepEqual(effects, []);
});
