import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyProbe } from './outage';

test('classifyProbe', async (t) => {
  await t.test('a healthy /health is online', () => {
    assert.equal(
      classifyProbe({ health: 'ok', storage: 'no-answer', browserOffline: false }),
      'online'
    );
  });

  // Any HTTP answer proves the network works, so a 502 from a proxy or a 503
  // from a dead database is our server, whatever storage does.
  await t.test('a /health that answers with an error is server-down', () => {
    assert.equal(
      classifyProbe({ health: 'error', storage: 'no-answer', browserOffline: false }),
      'server-down'
    );
  });

  await t.test('no /health but storage answering is server-down', () => {
    assert.equal(
      classifyProbe({ health: 'no-answer', storage: 'answered', browserOffline: false }),
      'server-down'
    );
  });

  await t.test('neither answering is offline', () => {
    assert.equal(
      classifyProbe({ health: 'no-answer', storage: 'no-answer', browserOffline: false }),
      'offline'
    );
  });

  await t.test('the browser saying offline wins over a stale storage answer', () => {
    assert.equal(
      classifyProbe({ health: 'no-answer', storage: 'answered', browserOffline: true }),
      'offline'
    );
  });
});
