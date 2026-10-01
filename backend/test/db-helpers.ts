/**
 * Why the Postgres tests should skip, or false to run them.
 *
 * Offline and on a laptop with no database they skip, so `npm test` stays
 * green. With REQUIRE_DATABASE=1 (CI) a missing or unreachable database throws
 * instead: a broken service container must fail the job, not turn into green
 * skips nobody reads.
 *
 * src/db.js is imported inside the function on purpose. Callers import this
 * module statically, and api.test.ts must set its auth env before anything
 * under src/ loads.
 */
export async function databaseSkipReason(): Promise<string | false> {
  // Load the project's .env the way every entry point does, so a developer
  // with a working database actually runs these instead of watching them skip.
  await import('dotenv/config');
  const required = process.env.REQUIRE_DATABASE === '1';

  if (!process.env.DATABASE_URL) {
    if (required) throw new Error('REQUIRE_DATABASE=1 but DATABASE_URL is not set');
    return 'DATABASE_URL not set';
  }

  try {
    const { query } = await import('../src/db.js');
    await query('select 1');
    return false;
  } catch (error) {
    if (required) {
      throw new Error(`REQUIRE_DATABASE=1 but the database is unreachable: ${String(error)}`, {
        cause: error,
      });
    }
    return `database unreachable (${String(error).slice(0, 60)})`;
  }
}
