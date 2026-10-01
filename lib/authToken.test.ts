import assert from 'node:assert/strict';
import test from 'node:test';
import {
  currentToken,
  registerTokenGetter,
  sendWithAuthRetry,
  type TokenGetter,
} from './authToken';

function recordingGetter(tokens: { cached: string | null; fresh: string | null }) {
  const calls: (boolean | undefined)[] = [];
  const getter: TokenGetter = async (options) => {
    calls.push(options?.skipCache);
    return options?.skipCache ? tokens.fresh : tokens.cached;
  };
  return { getter, calls };
}

function recordingSend(statuses: number[]) {
  const tokens: (string | null)[] = [];
  const send = async (token: string | null) => {
    tokens.push(token);
    return { status: statuses[tokens.length - 1] ?? 200 };
  };
  return { send, tokens };
}

test('authToken', async (t) => {
  t.afterEach(() => registerTokenGetter(null));

  await t.test('no getter registered means no token', async () => {
    assert.equal(await currentToken(), null);
  });

  await t.test('a getter that throws yields null instead of an error', async () => {
    registerTokenGetter(async () => {
      throw new Error('clerk offline');
    });
    assert.equal(await currentToken(), null);
  });

  await t.test('a success is sent once with the cached token', async () => {
    const { getter, calls } = recordingGetter({ cached: 'cached', fresh: 'fresh' });
    registerTokenGetter(getter);
    const { send, tokens } = recordingSend([200]);
    const response = await sendWithAuthRetry(send);
    assert.equal(response.status, 200);
    assert.deepEqual(tokens, ['cached']);
    assert.deepEqual(calls, [undefined]);
  });

  await t.test('a 401 retries exactly once with a fresh token', async () => {
    const { getter, calls } = recordingGetter({ cached: 'stale', fresh: 'fresh' });
    registerTokenGetter(getter);
    const { send, tokens } = recordingSend([401, 200]);
    const response = await sendWithAuthRetry(send);
    assert.equal(response.status, 200);
    assert.deepEqual(tokens, ['stale', 'fresh']);
    assert.deepEqual(calls, [undefined, true]);
  });

  await t.test('a second 401 is returned, not retried again', async () => {
    registerTokenGetter(recordingGetter({ cached: 'stale', fresh: 'fresh' }).getter);
    const { send, tokens } = recordingSend([401, 401, 200]);
    const response = await sendWithAuthRetry(send);
    assert.equal(response.status, 401);
    assert.equal(tokens.length, 2);
  });

  await t.test('signed out (no fresh token) returns the first 401 without resending', async () => {
    registerTokenGetter(recordingGetter({ cached: null, fresh: null }).getter);
    const { send, tokens } = recordingSend([401]);
    const response = await sendWithAuthRetry(send);
    assert.equal(response.status, 401);
    assert.deepEqual(tokens, [null]);
  });

  // Clerk unreachable at the moment of the refresh: the caller gets the 401 it
  // already has, not a Clerk exception from inside apiFetch.
  await t.test(
    'a fresh-token getter that throws returns the first 401 without resending',
    async () => {
      registerTokenGetter(async (options) => {
        if (options?.skipCache) throw new Error('clerk unreachable');
        return 'cached';
      });
      const { send, tokens } = recordingSend([401]);
      const response = await sendWithAuthRetry(send);
      assert.equal(response.status, 401);
      assert.deepEqual(tokens, ['cached']);
    }
  );
});
