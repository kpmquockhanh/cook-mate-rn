import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTestAuthEnv,
  authHeaders,
  mintToken,
  TEST_ISSUER,
  TEST_USER_ID,
} from './auth-helpers.js';

// Must run before src/env.ts is loaded, hence the dynamic imports below.
applyTestAuthEnv();

const { buildServer } = await import('../src/api/server.js');
const { verifyAccessToken } = await import('../src/api/auth.js');
const { close } = await import('../src/db.js');

/**
 * No database needed: the guard rejects before any handler runs, and the one
 * authorised case only asserts that the request got *past* the guard. That
 * keeps the security tests running everywhere, which is the point of them.
 */
test('API authentication', async (t) => {
  const app = await buildServer();

  t.after(async () => {
    await app.close();
    await close();
  });

  const get = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/recipes?limit=1', headers });

  await t.test('rejects a request with no Authorization header', async () => {
    const response = await get();
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'missing_token');
    assert.match(String(response.headers['www-authenticate']), /^Bearer/);
  });

  await t.test('rejects a non-Bearer Authorization header', async () => {
    const response = await get({ authorization: 'Basic dXNlcjpwYXNz' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'missing_token');
  });

  await t.test('rejects a token that is not a JWT', async () => {
    const response = await get({ authorization: 'Bearer not-a-jwt' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'invalid_token');
  });

  await t.test('rejects a token signed with the wrong secret', async () => {
    const response = await get({
      authorization: `Bearer ${await mintToken({ secret: 'a-different-secret-entirely' })}`,
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'invalid_token');
  });

  await t.test('rejects a token from another issuer', async () => {
    const response = await get({
      authorization: `Bearer ${await mintToken({ issuer: 'https://someone-else.supabase.co/auth/v1' })}`,
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'invalid_token');
  });

  // The publishable/anon key is a JWT too, and it is public. `aud: authenticated`
  // is what stops it standing in for a signed-in user.
  await t.test('rejects an anon-audience token', async () => {
    const response = await get({ authorization: `Bearer ${await mintToken({ audience: 'anon' })}` });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'invalid_token');
  });

  await t.test('reports an expired token distinctly so the app can refresh', async () => {
    const response = await get({
      authorization: `Bearer ${await mintToken({ expiresInSeconds: -60 })}`,
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'token_expired');
  });

  await t.test('lets a valid token through to the handler', async () => {
    const response = await get(await authHeaders());
    // 200 with a database behind it, 500 without - either way it is not the
    // guard turning it away.
    assert.notEqual(response.statusCode, 401);
  });

  await t.test('/health stays public - probes carry no session', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.notEqual(response.statusCode, 401);
  });

  await t.test('an unauthenticated request never reaches an unknown route either', async () => {
    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });
    assert.equal(response.statusCode, 401);
  });

  await t.test('verifyAccessToken exposes the claims routes key off', async () => {
    const user = await verifyAccessToken(await mintToken({ email: 'chef@example.com' }));
    assert.equal(user.id, TEST_USER_ID);
    assert.equal(user.email, 'chef@example.com');
    assert.equal(user.role, 'authenticated');
    assert.equal(user.claims.iss, TEST_ISSUER);
  });
});
