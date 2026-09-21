import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translate } from './i18n/translate';
import type { Translator } from './i18n';
import { describeVoiceStatus, isAgentConnected, voiceControlIcon } from './voiceSession';

const en: Translator = (key, values) => translate('en', key, values);

test('waiting tells the user what to say', () => {
  const copy = describeVoiceStatus('waiting-for-wake-word', null, en);
  assert.equal(copy.label, 'Say “Hey CookMate” — or tap the mic');
  assert.equal(copy.tone, 'neutral');
  assert.equal(copy.canRetry, false);
});

test('an unavailable wake word falls back to the mic, as a warning', () => {
  const copy = describeVoiceStatus('wake-word-unavailable', null, en);
  assert.equal(copy.label, 'Wake word unavailable — tap the mic to talk');
  assert.equal(copy.tone, 'warn');
});

test('agent-connected statuses', () => {
  assert.equal(isAgentConnected('waiting-for-wake-word'), true);
  assert.equal(isAgentConnected('wake-word-unavailable'), true);
  assert.equal(isAgentConnected('listening'), true);
  assert.equal(isAgentConnected('connecting'), false);
  assert.equal(isAgentConnected('no-agent'), false);
});

test('icons for the new statuses', () => {
  assert.deepEqual(voiceControlIcon('waiting-for-wake-word', false), {
    name: 'mic-outline',
    color: '#FFFFFF',
  });
  assert.deepEqual(voiceControlIcon('wake-word-unavailable', false), {
    name: 'mic-outline',
    color: '#FDE68A',
  });
  // The agent can speak while the mic is muted (the greeting), and that still shows.
  assert.equal(voiceControlIcon('waiting-for-wake-word', true).name, 'volume-high');
});
