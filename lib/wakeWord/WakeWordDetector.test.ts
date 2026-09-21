import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickDetector,
  unavailableDetector,
  type WakeWordNative,
  type WakeWordNativeEvents,
} from './WakeWordDetector';

/** A stand-in for the Expo module: records calls, lets a test fire events. */
function fakeNative() {
  const calls: string[] = [];
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const native: WakeWordNative = {
    start: async (threshold) => void calls.push(`start:${threshold}`),
    stop: async () => void calls.push('stop'),
    setThreshold: (threshold) => void calls.push(`threshold:${threshold}`),
    addListener: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as (...args: any[]) => void);
      listeners.set(event, set);
      return { remove: () => set.delete(listener as (...args: any[]) => void) };
    },
  };
  const emit = <E extends keyof WakeWordNativeEvents>(
    event: E,
    ...args: Parameters<WakeWordNativeEvents[E]>
  ) => listeners.get(event)?.forEach((listener) => listener(...args));
  return { native, calls, emit, listeners };
}

test('no native module means the unavailable detector', () => {
  const detector = pickDetector(null);
  assert.equal(detector, unavailableDetector);
  assert.equal(detector.isAvailable, false);
});

test('start, stop and threshold pass through', async () => {
  const { native, calls } = fakeNative();
  const detector = pickDetector(native);
  assert.equal(detector.isAvailable, true);
  await detector.start(0.5);
  detector.setThreshold(0.8);
  await detector.stop();
  assert.deepEqual(calls, ['start:0.5', 'threshold:0.8', 'stop']);
});

test('detections arrive as a score, and unsubscribe works', () => {
  const { native, emit } = fakeNative();
  const detector = pickDetector(native);
  const scores: number[] = [];
  const unsubscribe = detector.onDetected((score) => scores.push(score));
  emit('onWakeWord', { score: 0.91 });
  unsubscribe();
  emit('onWakeWord', { score: 0.95 });
  assert.deepEqual(scores, [0.91]);
});

test('errors arrive as the message; interruptions pass through', () => {
  const { native, emit } = fakeNative();
  const detector = pickDetector(native);
  const seen: string[] = [];
  detector.onError((message) => seen.push(`error:${message}`));
  detector.onInterrupted(() => seen.push('interrupted'));
  detector.onResumed(() => seen.push('resumed'));
  emit('onError', { message: 'model missing' });
  emit('onInterrupted');
  emit('onResumed');
  assert.deepEqual(seen, ['error:model missing', 'interrupted', 'resumed']);
});

test('the unavailable detector is inert', async () => {
  await unavailableDetector.start(0.5);
  await unavailableDetector.stop();
  unavailableDetector.setThreshold(0.8);
  unavailableDetector.onDetected(() => assert.fail('never fires'))();
});
