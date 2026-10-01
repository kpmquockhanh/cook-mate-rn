import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { close } from '../src/db.js';
import { databaseSkipReason } from './db-helpers.js';

// Nothing listens on port 1, so this fails fast with ECONNREFUSED and never
// touches a real database.
const UNREACHABLE = 'postgres://x:y@127.0.0.1:1/none';

const saved = {
  DATABASE_URL: process.env.DATABASE_URL,
  REQUIRE_DATABASE: process.env.REQUIRE_DATABASE,
};

afterEach(async () => {
  // The pool is built once per URL; drop it so the next case connects afresh.
  await close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('no DATABASE_URL skips with a reason', async () => {
  process.env.DATABASE_URL = ''; // '' not delete: dotenv would refill a missing key
  process.env.REQUIRE_DATABASE = '';
  assert.equal(await databaseSkipReason(), 'DATABASE_URL not set');
});

test('an unreachable database skips with a reason', async () => {
  process.env.DATABASE_URL = UNREACHABLE;
  process.env.REQUIRE_DATABASE = '';
  const reason = await databaseSkipReason();
  assert.equal(typeof reason, 'string');
  assert.match(reason as string, /^database unreachable/);
});

test('REQUIRE_DATABASE=1 turns an unreachable database into a failure', async () => {
  process.env.DATABASE_URL = UNREACHABLE;
  process.env.REQUIRE_DATABASE = '1';
  await assert.rejects(databaseSkipReason(), (error: Error) => {
    assert.match(error.message, /^REQUIRE_DATABASE=1 but the database is unreachable: /);
    assert.ok(error.cause, 'the connection error should be kept as cause');
    return true;
  });
});

test('REQUIRE_DATABASE=1 with no DATABASE_URL is a failure, not a skip', async () => {
  process.env.DATABASE_URL = '';
  process.env.REQUIRE_DATABASE = '1';
  await assert.rejects(databaseSkipReason(), /^Error: REQUIRE_DATABASE=1 but DATABASE_URL is not set/);
});

test('REQUIRE_DATABASE=true counts as set', async () => {
  process.env.DATABASE_URL = '';
  process.env.REQUIRE_DATABASE = 'true';
  await assert.rejects(databaseSkipReason(), /^Error: REQUIRE_DATABASE=true but DATABASE_URL is not set/);
});

test('REQUIRE_DATABASE=0 and =false still skip', async () => {
  for (const value of ['0', 'false']) {
    process.env.DATABASE_URL = '';
    process.env.REQUIRE_DATABASE = value;
    assert.equal(await databaseSkipReason(), 'DATABASE_URL not set', `REQUIRE_DATABASE=${value}`);
  }
});

test('an unrecognised REQUIRE_DATABASE is an error, not a silent skip', async () => {
  process.env.DATABASE_URL = '';
  process.env.REQUIRE_DATABASE = 'yes please';
  await assert.rejects(databaseSkipReason(), /REQUIRE_DATABASE must be 1, true, 0, false or empty, got "yes please"/);
});
