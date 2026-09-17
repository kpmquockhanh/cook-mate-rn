import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTestAuthEnv, authHeaders } from './auth-helpers.js';

// Every route but /health needs a token now. Override the auth env before
// anything under src/ loads, then mint tokens locally - these tests need a
// database, not a Supabase auth server.
applyTestAuthEnv();

// These exercise real routes against a real database. They run through
// app.inject(), so no port is bound and nothing listens - but they still need
// Postgres. When it is not reachable the suite skips rather than fails, so
// `npm test` stays green offline and in CI without secrets.
async function skipReason(): Promise<string | false> {
  if (!process.env.DATABASE_URL) return 'DATABASE_URL not set';
  try {
    const { query } = await import('../src/db.js');
    await query('select 1');
    return false;
  } catch (error) {
    return `database unreachable (${String(error).slice(0, 60)})`;
  }
}

const skip = await skipReason();

test('recipes API', { skip }, async (t) => {
  const { buildServer } = await import('../src/api/server.js');
  const { close } = await import('../src/db.js');
  const app = await buildServer();

  t.after(async () => {
    await app.close();
    await close();
  });

  await t.test('GET /health reports a live database', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
  });

  await t.test('GET /recipes returns a data array', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/recipes?limit=2',
      headers: await authHeaders(),
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.ok(Array.isArray(body.data), 'expected { data: [...] }');
    assert.ok(body.data.length <= 2, 'limit was not honoured');
  });

  await t.test('GET /recipes sets CORS headers - the web build depends on them', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/recipes?limit=1',
      headers: { ...(await authHeaders()), origin: 'http://localhost:8081' },
    });
    assert.ok(response.headers['access-control-allow-origin']);
  });

  await t.test('an unknown orderBy falls back instead of injecting', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/recipes?orderBy=${encodeURIComponent('id; drop table public.recipes --')}`,
      headers: await authHeaders(),
    });
    assert.equal(response.statusCode, 200);
    // The table is still there, which is the actual assertion.
    const after = await app.inject({
      method: 'GET',
      url: '/recipes?limit=1',
      headers: await authHeaders(),
    });
    assert.equal(after.statusCode, 200);
  });

  await t.test('a missing recipe is a 404, which the app maps to "Recipe not found"', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/recipes/999999999',
      headers: await authHeaders(),
    });
    assert.equal(response.statusCode, 404);
  });

  await t.test('a non-numeric id is a 404, not a 500', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/recipes/not-a-number',
      headers: await authHeaders(),
    });
    assert.equal(response.statusCode, 404);
  });

  // The guard is global, so this is what catches a route added later that
  // happens to be reachable without a session.
  await t.test('every recipe route 401s without a token', async () => {
    for (const url of ['/recipes', '/recipes?limit=1', '/recipes/1']) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 401, `${url} was reachable unauthenticated`);
    }
  });
});
