import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeJwt } from 'jose';
import { applyTestAuthEnv, authHeaders, installTestJwks, TEST_USER_ID } from './auth-helpers.js';

applyTestAuthEnv();
process.env.LIVEKIT_URL = 'wss://test.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'test-api-key';
process.env.LIVEKIT_API_SECRET = 'test-api-secret-that-is-long-enough-for-hs256';

const { buildServer } = await import('../src/api/server.js');
const { setJwksForTesting } = await import('../src/api/auth.js');
const { close } = await import('../src/db.js');
installTestJwks(setJwksForTesting);

// No database: the route only signs a token.
test('POST /voice/token', async (t) => {
  const app = await buildServer();
  t.after(async () => {
    await app.close();
    await close();
  });

  const post = async (payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/voice/token', payload: payload as object, headers });

  await t.test('401s without a token', async () => {
    const response = await post({ recipeId: '42' });
    assert.equal(response.statusCode, 401);
  });

  await t.test('400s without a recipeId', async () => {
    const response = await post({}, await authHeaders());
    assert.equal(response.statusCode, 400);
  });

  await t.test('400s for a whitespace-only recipeId', async () => {
    const response = await post({ recipeId: '   ' }, await authHeaders());
    assert.equal(response.statusCode, 400);
  });

  await t.test('mints a token for the caller\'s own room, with the agent dispatched', async () => {
    const response = await post({ recipeId: 42 }, await authHeaders({ name: 'Chef Test' }));
    assert.equal(response.statusCode, 200);
    const { data } = response.json();

    assert.equal(data.serverUrl, 'wss://test.livekit.cloud');
    assert.equal(data.roomName, `cooking-${TEST_USER_ID}-42`);
    assert.equal(data.identity, `user-${TEST_USER_ID}`);
    const ttlMs = data.expiresAt - Date.now();
    assert.ok(ttlMs > 110 * 60_000 && ttlMs <= 120 * 60_000, `expiresAt is ${ttlMs}ms away`);

    const claims = decodeJwt(data.token) as Record<string, unknown> & {
      video?: Record<string, unknown>;
    };
    assert.equal(claims.sub, `user-${TEST_USER_ID}`);
    assert.equal(claims.name, 'Chef Test');
    assert.equal(claims.video?.room, `cooking-${TEST_USER_ID}-42`);
    assert.equal(claims.video?.roomJoin, true);
    assert.equal(claims.video?.canPublishData, true);
    assert.equal(claims.video?.canUpdateOwnMetadata, true);
    // Without the explicit dispatch the room connects and no agent ever joins.
    assert.match(JSON.stringify(claims), /"cookmate"/);
  });

  await t.test('the room is derived from the verified user, never the body', async () => {
    const response = await post(
      { recipeId: '7', roomName: 'cooking-someone-else-7', identity: 'user-someone-else' },
      await authHeaders(),
    );
    assert.equal(response.json().data.roomName, `cooking-${TEST_USER_ID}-7`);
  });
});
