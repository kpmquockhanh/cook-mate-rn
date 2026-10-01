import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTestAuthEnv, authHeaders, installTestJwks } from './auth-helpers.js';
import { databaseSkipReason } from './db-helpers.js';

// Every route but /health needs a token now. Override the auth env before
// anything under src/ loads, then mint tokens locally - these tests need a
// database, not a Clerk instance.
applyTestAuthEnv();

// These exercise real routes against a real database. They run through
// app.inject(), so no port is bound and nothing listens - but they still need
// Postgres. db-helpers.ts decides whether a missing one skips (offline) or
// fails (CI, REQUIRE_DATABASE=1).
const skip = await databaseSkipReason();

test('recipes API', { skip }, async (t) => {
  const { buildServer } = await import('../src/api/server.js');
  const { close, one, query } = await import('../src/db.js');
  const { setJwksForTesting } = await import('../src/api/auth.js');
  installTestJwks(setJwksForTesting);
  const app = await buildServer();

  // Two recipes of our own, so the filter and favourite tests assert something
  // on an empty database (CI migrates but never publishes). The marker is in
  // both titles and every filter query searches for it, which keeps a
  // developer's real rows out of the results and puts ours on the first page.
  // Deleting them cascades to any favourites and events the tests left.
  const marker = `api-test-${process.pid}-${Date.now()}`;
  const insertFixture = async (fields: {
    title: string;
    meal: string;
    totalSeconds: number;
    activeSeconds: number;
    diet: string[];
  }): Promise<number> => {
    const row = await one<{ id: number }>(
      `insert into public.recipes (title, meal, total_time_seconds, active_time_seconds, diet)
       values ($1, $2, $3, $4, $5) returning id`,
      [`${fields.title} ${marker}`, fields.meal, fields.totalSeconds, fields.activeSeconds, fields.diet],
    );
    if (!row) throw new Error('fixture insert returned no row');
    return row.id;
  };
  // Quick, vegetarian, dinner.
  const quickId = await insertFixture({
    title: 'Quick vegetarian dinner',
    meal: 'dinner',
    totalSeconds: 20 * 60,
    activeSeconds: 15 * 60,
    diet: ['vegetarian'],
  });
  // Hands-off: eight hours on the clock, ten minutes of work, diet unknown.
  const slowId = await insertFixture({
    title: 'Slow cooker lunch',
    meal: 'lunch',
    totalSeconds: 8 * 60 * 60,
    activeSeconds: 10 * 60,
    diet: [],
  });
  const search = `search=${encodeURIComponent(marker)}`;
  const ids = (body: { data: { id: number }[] }) => body.data.map((row) => row.id);

  t.after(async () => {
    await query('delete from public.recipes where id = any($1::bigint[])', [[quickId, slowId]]);
    await app.close();
    await close();
  });

  await t.test('GET /health reports a live database', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
  });

  await t.test('GET /recipes returns the fixtures', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/recipes?${search}`,
      headers: await authHeaders(),
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(ids(response.json()).sort(), [quickId, slowId].sort());
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

  // --- Facets (migration 0012) ---------------------------------------------

  await t.test('a facet filter returns only rows carrying that facet', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/recipes?meal=dinner&limit=50&${search}`,
      headers: await authHeaders(),
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(ids(response.json()), [quickId]);
    for (const recipe of response.json().data) {
      assert.equal(recipe.meal, 'dinner', `${recipe.title} is not dinner`);
    }
  });

  await t.test('maxMinutes never returns a recipe of unknown length', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/recipes?maxMinutes=30&limit=50&${search}`,
      headers: await authHeaders(),
    });
    assert.deepEqual(ids(response.json()), [quickId]);
    for (const recipe of response.json().data) {
      assert.ok(
        typeof recipe.total_time_seconds === 'number' && recipe.total_time_seconds <= 1800,
        `${recipe.title} is ${recipe.total_time_seconds}s`,
      );
    }
  });

  await t.test('handsOff means long on the clock and short on work', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/recipes?handsOff=true&limit=50&${search}`,
      headers: await authHeaders(),
    });
    assert.deepEqual(ids(response.json()), [slowId]);
    for (const recipe of response.json().data) {
      assert.ok(recipe.active_time_seconds <= 20 * 60, `${recipe.title} is hands-on`);
      assert.ok(recipe.total_time_seconds >= 60 * 60, `${recipe.title} is not long`);
    }
  });

  await t.test('a diet filter never returns a recipe that claims no diet', async () => {
    // The safety property: `diet` is empty when an ingredient did not resolve,
    // so an unknown recipe must never come back as vegetarian.
    const response = await app.inject({
      method: 'GET',
      url: `/recipes?diet=vegetarian&limit=50&${search}`,
      headers: await authHeaders(),
    });
    assert.deepEqual(ids(response.json()), [quickId]);
    for (const recipe of response.json().data) {
      assert.ok(recipe.diet.includes('vegetarian'), `${recipe.title} is not vegetarian`);
    }
  });

  // --- Favourites and events (migration 0013) -------------------------------

  await t.test('favouriting is idempotent and visible on the recipe', async () => {
    const headers = await authHeaders();
    const recipe = { id: quickId };

    // Twice on purpose: the app retries, and a toggle endpoint would undo it.
    for (let i = 0; i < 2; i++) {
      const put = await app.inject({
        method: 'PUT',
        url: `/recipes/${recipe.id}/favorite`,
        headers,
      });
      assert.equal(put.statusCode, 200);
    }

    const after = await app.inject({
      method: 'GET',
      url: `/recipes/${recipe.id}`,
      headers,
    });
    assert.equal(after.json().data.is_favorite, true);

    const favorites = await app.inject({
      method: 'GET',
      url: '/recipes?favorites=true&limit=50',
      headers,
    });
    assert.ok(
      favorites.json().data.some((row: { id: number }) => row.id === recipe.id),
      'the favourited recipe is missing from ?favorites=true',
    );

    const remove = await app.inject({
      method: 'DELETE',
      url: `/recipes/${recipe.id}/favorite`,
      headers,
    });
    assert.equal(remove.statusCode, 200);

    const cleared = await app.inject({
      method: 'GET',
      url: `/recipes/${recipe.id}`,
      headers,
    });
    assert.equal(cleared.json().data.is_favorite, false);
  });

  await t.test('an event is accepted, and an unknown kind is refused', async () => {
    const headers = await authHeaders();
    const recipe = { id: quickId };

    const accepted = await app.inject({
      method: 'POST',
      url: `/recipes/${recipe.id}/events`,
      headers,
      payload: { kind: 'viewed' },
    });
    assert.equal(accepted.statusCode, 204);

    const refused = await app.inject({
      method: 'POST',
      url: `/recipes/${recipe.id}/events`,
      headers,
      payload: { kind: 'exploded' },
    });
    assert.equal(refused.statusCode, 400);
  });

  await t.test('one user cannot see another user\'s favourites', async () => {
    const mine = await authHeaders();
    const recipe = { id: quickId };

    await app.inject({ method: 'PUT', url: `/recipes/${recipe.id}/favorite`, headers: mine });

    const theirs = await authHeaders({ sub: '99999999-8888-7777-6666-555555555555' });
    const seen = await app.inject({
      method: 'GET',
      url: `/recipes/${recipe.id}`,
      headers: theirs,
    });
    assert.equal(seen.json().data.is_favorite, false, "another user's favourite leaked");

    await app.inject({ method: 'DELETE', url: `/recipes/${recipe.id}/favorite`, headers: mine });
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
