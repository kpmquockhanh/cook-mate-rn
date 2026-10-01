/**
 * Why the Postgres tests should skip, or false to run them.
 *
 * Offline and on a laptop with no database they skip, so `npm test` stays
 * green. With REQUIRE_DATABASE=1 or true (CI) a missing or unreachable database
 * throws instead: a broken service container must fail the job, not turn into
 * green skips nobody reads.
 *
 * src/db.js is imported inside the function on purpose. Callers import this
 * module statically, and api.test.ts must set its auth env before anything
 * under src/ loads.
 */
export async function databaseSkipReason(): Promise<string | false> {
  // Load the project's .env the way every entry point does, so a developer
  // with a working database actually runs these instead of watching them skip.
  await import('dotenv/config');
  const flag = process.env.REQUIRE_DATABASE ?? '';
  const required = requireDatabase(flag);

  if (!process.env.DATABASE_URL) {
    if (required) throw new Error(`REQUIRE_DATABASE=${flag} but DATABASE_URL is not set`);
    return 'DATABASE_URL not set';
  }

  try {
    const { query } = await import('../src/db.js');
    await query('select 1');
    return false;
  } catch (error) {
    if (required) {
      throw new Error(`REQUIRE_DATABASE=${flag} but the database is unreachable: ${String(error)}`, {
        cause: error,
      });
    }
    return `database unreachable (${String(error).slice(0, 60)})`;
  }
}

/**
 * Whether REQUIRE_DATABASE asks for a database. Anything it does not recognise
 * throws: `REQUIRE_DATABASE=yes` reading as "not required" would quietly turn
 * CI's database tests back into skips.
 */
function requireDatabase(flag: string): boolean {
  const value = flag.trim().toLowerCase();
  if (value === '1' || value === 'true') return true;
  if (value === '' || value === '0' || value === 'false') return false;
  throw new Error(`REQUIRE_DATABASE must be 1, true, 0, false or empty, got "${flag}"`);
}
