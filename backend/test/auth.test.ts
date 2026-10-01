import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTestAuthEnv,
  authHeaders,
  installTestJwks,
  mintHs256Token,
  mintToken,
  TEST_AUTHORIZED_PARTY,
  TEST_ISSUER,
  TEST_USER_ID,
} from './auth-helpers.js';

// Must run before src/env.ts is loaded, hence the dynamic imports below.
applyTestAuthEnv();

const { buildServer } = await import('../src/api/server.js');
const { setJwksForTesting, verifyAccessToken } = await import('../src/api/auth.js');
const { close } = await import('../src/db.js');
const { env } = await import('../src/env.js');
installTestJwks(setJwksForTesting);

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
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

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
    const response = await get(bearer('not-a-jwt'));
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'invalid_token');
  });

  await t.test('rejects a token signed with a key outside the JWKS', async () => {
    const response = await get(bearer(await mintToken({ wrongKey: true })));
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'invalid_token');
  });

  await t.test('rejects a token from another Clerk instance', async () => {
    const response = await get(bearer(await mintToken({ issuer: 'https://someone-else.clerk.accounts.dev' })));
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'invalid_token');
  });

  // Clerk never issues HS256, so a token using it is forged or stale, whatever
  // its claims say.
  await t.test('rejects an HS256 token', async () => {
    const response = await get(bearer(await mintHs256Token()));
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'invalid_token');
  });

  await t.test('rejects a token with no subject', async () => {
    const response = await get(bearer(await mintToken({ sub: null })));
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'invalid_token');
  });

  await t.test('rejects a web token from an origin that is not an authorized party', async () => {
    const response = await get(bearer(await mintToken({ azp: 'https://evil.example.com' })));
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'invalid_token');
  });

  // CLERK_AUTHORIZED_PARTIES is set with a trailing slash and spaces in
  // applyTestAuthEnv; the browser's azp has neither.
  await t.test('accepts a web token from an authorized party, however the list was written', async () => {
    const first = await get(bearer(await mintToken({ azp: TEST_AUTHORIZED_PARTY })));
    assert.notEqual(first.statusCode, 401);
    const second = await get(bearer(await mintToken({ azp: 'https://app.example.com' })));
    assert.notEqual(second.statusCode, 401);
  });

  await t.test('accepts a native token, which carries no azp', async () => {
    const response = await get(await authHeaders());
    // 200 with a database behind it, 500 without - either way it is not the
    // guard turning it away.
    assert.notEqual(response.statusCode, 401);
  });

  await t.test('rejects a token minted without exp', async () => {
    const response = await get(bearer(await mintToken({ omitExp: true })));
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'invalid_token');
  });

  // An empty CLERK_AUTHORIZED_PARTIES means no web client is allowed, but
  // native tokens (no azp) must keep working.
  await t.test('with no authorized parties, rejects azp tokens and accepts native ones', async () => {
    const saved = [...env.clerkAuthorizedParties];
    env.clerkAuthorizedParties.length = 0;
    try {
      const web = await get(bearer(await mintToken({ azp: TEST_AUTHORIZED_PARTY })));
      assert.equal(web.statusCode, 401);
      assert.equal(web.json().reason, 'invalid_token');
      const native = await get(await authHeaders());
      assert.notEqual(native.statusCode, 401);
    } finally {
      env.clerkAuthorizedParties.push(...saved);
    }
  });

  await t.test('reports an expired token distinctly so the app can refresh', async () => {
    const response = await get(bearer(await mintToken({ expiresInSeconds: -60 })));
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'token_expired');
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
    const user = await verifyAccessToken(await mintToken({ email: 'chef@example.com', name: 'Chef' }));
    assert.equal(user.id, TEST_USER_ID);
    assert.equal(user.email, 'chef@example.com');
    assert.equal(user.name, 'Chef');
    assert.equal(user.sessionId, 'sess_test');
    assert.equal(user.claims.iss, TEST_ISSUER);
  });
});
