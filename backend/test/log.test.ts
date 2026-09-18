import assert from 'node:assert/strict';
import test from 'node:test';
import { type LogLine, logger, withLogSink } from '../src/log.js';

const messages = (lines: LogLine[]) => lines.map((line) => line.message);

test('a sink captures the lines emitted inside it', async () => {
  const captured: LogLine[] = [];
  const log = logger('test');

  await withLogSink((line) => captured.push(line), async () => {
    log.info('inside');
  });
  log.info('outside');

  // Only what was emitted within the callback: a sink is scoped to the work it
  // wrapped, not to the process.
  assert.deepEqual(messages(captured), ['inside']);
});

test('nested sinks both see the line', async () => {
  // This is what lets a crawl run store its own log while the console's job
  // runner, wrapped around it, keeps feeding the live panel. If the inner sink
  // replaced the outer one, the panel would go silent for exactly the stage it
  // was opened to watch.
  const outer: LogLine[] = [];
  const inner: LogLine[] = [];
  const log = logger('test');

  await withLogSink((line) => outer.push(line), async () => {
    log.info('before');
    await withLogSink((line) => inner.push(line), async () => {
      log.info('during');
    });
    log.info('after');
  });

  assert.deepEqual(messages(outer), ['before', 'during', 'after']);
  assert.deepEqual(messages(inner), ['during']);
});

test('a sink that throws does not take the other sinks, or the caller, down', async () => {
  // Log call sites are everywhere and none of them expect logging to throw.
  const inner: LogLine[] = [];
  const log = logger('test');

  await withLogSink(
    () => {
      throw new Error('sink is broken');
    },
    async () => {
      await withLogSink((line) => inner.push(line), async () => {
        log.info('still recorded');
      });
    },
  );

  assert.deepEqual(messages(inner), ['still recorded']);
});
