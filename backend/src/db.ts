import pg from 'pg';
import { env } from './env.js';

// Postgres NUMERIC arrives as a string by default; we want numbers everywhere.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));

let poolRef: pg.Pool | null = null;

export function pool(): pg.Pool {
  if (!poolRef) {
    poolRef = new pg.Pool({
      connectionString: env.databaseUrl,
      max: Math.max(4, env.crawlConcurrency + 2),
      // Supabase terminates TLS with its own CA chain; this matches what the
      // Supabase CLI and psql `sslmode=require` do.
      ssl: env.databaseUrl.includes('localhost') ? undefined : { rejectUnauthorized: false },
      // Without this a wrong host hangs the API request (or the test suite)
      // instead of failing; pg waits indefinitely by default.
      connectionTimeoutMillis: 10_000,
    });
  }
  return poolRef;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await pool().query<T>(text, values);
  return result.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, values);
  return rows[0] ?? null;
}

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function close(): Promise<void> {
  if (poolRef) {
    await poolRef.end();
    poolRef = null;
  }
}
