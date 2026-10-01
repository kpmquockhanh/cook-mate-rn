import pg from 'pg';
import { env } from './env.js';
import { logger } from './log.js';

const log = logger('db');

// Postgres NUMERIC arrives as a string by default; we want numbers everywhere.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));

let poolRef: pg.Pool | null = null;

/**
 * The pool's options, split out so tests can check them without connecting.
 *
 * TLS is the URL's business: there is deliberately no `ssl` key, so pg applies
 * `sslmode` from the connection string. No `sslmode` means plain TCP (docker
 * compose, localhost). `?sslmode=verify-full` means TLS with a certificate
 * that must verify; `?sslmode=no-verify` means TLS against a self-signed
 * server. Avoid `require`: pg 8 treats it as verify-full but warns that pg 9
 * changes its meaning. One catch: with no `sslmode` in the URL, pg falls back
 * to the PGSSLMODE environment variable, so an exported PGSSLMODE=require
 * turns TLS on against a server that has none.
 */
export function poolConfig(connectionString: string): pg.PoolConfig {
  return {
    connectionString,
    max: Math.max(4, env.crawlConcurrency + 2),
    // Without this a wrong host hangs the API request (or the test suite)
    // instead of failing; pg waits indefinitely by default. It is generous
    // because a remote server can legitimately take several seconds to accept
    // a connection, and a timeout shorter than a healthy connect turns
    // ordinary latency into an outage.
    connectionTimeoutMillis: env.dbConnectTimeoutMs,
  };
}

export function pool(): pg.Pool {
  if (!poolRef) {
    poolRef = new pg.Pool(poolConfig(env.databaseUrl));

    // An idle client whose connection drops - a laptop sleeping, wifi changing,
    // a server restarting - makes pg emit 'error' on the POOL, not on any query.
    // Node treats an unhandled 'error' event as fatal, so without this listener
    // a transient network blip takes down the console or the API rather than
    // costing one reconnect.
    poolRef.on('error', (error) => {
      log.warn('idle client error (the pool will reconnect)', String(error));
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
