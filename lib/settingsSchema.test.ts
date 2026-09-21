import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, migrate, sanitize } from './settingsSchema';

test('a v1 blob without voiceWakeWindow reads as quick', () => {
  const settings = sanitize(migrate({ schemaVersion: 1, voiceEnabled: false }));
  assert.equal(settings.voiceWakeWindow, 'quick');
  assert.equal(settings.voiceEnabled, false);
});

test('conversation is kept', () => {
  assert.equal(sanitize({ voiceWakeWindow: 'conversation' }).voiceWakeWindow, 'conversation');
});

test('an unknown window mode falls back to the default', () => {
  const stored = { voiceWakeWindow: 'forever' } as unknown as Parameters<typeof sanitize>[0];
  assert.equal(sanitize(stored).voiceWakeWindow, DEFAULT_SETTINGS.voiceWakeWindow);
});

test('existing fields are still sanitized', () => {
  const settings = sanitize({ speechRate: 9, defaultServings: -3 });
  assert.equal(settings.speechRate, 1.5);
  assert.equal(settings.defaultServings, 1);
});
