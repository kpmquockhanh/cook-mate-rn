import { createHash } from 'node:crypto';
import { pool } from '../db.js';
import { logger } from '../log.js';

const log = logger('lock');

/**
 * Namespace for every advisory lock this application takes, so a key collision
 * with anything else sharing the database is a two-part accident rather than a
 * one-part one. Advisory locks are global to the database, not to a schema.
 */
const NAMESPACE = 0x636d; // "cm"

/**
 * Stages that must not run beside each other, beyond the obvious "not twice at
 * once". `pipeline` runs crawl, parse, images, enrich and gate itself, so it has
 * to hold their locks too or a console pipeline and a CLI `crawl` would overlap
 * while each believed it was alone.
 */
const COVERS: Record<string, readonly string[]> = {
  pipeline: ['pipeline', 'crawl', 'parse', 'images', 'enrich', 'gate'],
};

/** A stable signed int32 per stage name, which is what the two-argument form takes. */
function keyFor(kind: string): number {
  return createHash('sha256').update(kind).digest().readInt32BE(0);
}

export interface JobLock {
  /** Release every lock held, and hand the connection back. */
  release(): Promise<void>;
}

/**
 * Take the advisory locks covering `kind`, or return null if another process
 * already holds one.
 *
 * This replaces an in-process guard that could only ever see jobs started by
 * the same Node process. The console runs in a container while the CLI runs on
 * a laptop, both against the same database, so "is a crawl already running?"
 * is a question only the database can answer.
 *
 * The locks are session-scoped, which is the property that makes them safe
 * here: a crashed or killed process drops its connection and Postgres releases
 * everything it held, with no stale row for an operator to clean up. That also
 * means the connection must be held for as long as the job runs, so this takes
 * a client out of the pool and keeps it.
 */
export async function acquireJobLock(kind: string): Promise<JobLock | null> {
  const kinds = [...(COVERS[kind] ?? [kind])].sort();
  const client = await pool().connect();

  // Every caller takes its keys in the same sorted order, and never waits for
  // one, so two jobs wanting overlapping sets cannot deadlock: the loser sees
  // a false and gives back what it holds.
  const taken: number[] = [];
  const releaseAll = async () => {
    // Releasing the client does NOT drop session locks - the connection lives
    // on in the pool and would carry them to whoever gets it next. Unlock
    // explicitly, and if that fails, destroy the connection rather than return
    // a poisoned one.
    try {
      await client.query('select pg_advisory_unlock_all()');
      client.release();
    } catch (error) {
      log.warn(`could not release ${kind} lock cleanly; dropping the connection`, String(error));
      client.release(error instanceof Error ? error : new Error(String(error)));
    }
  };

  try {
    for (const name of kinds) {
      const key = keyFor(name);
      const { rows } = await client.query<{ got: boolean }>(
        'select pg_try_advisory_lock($1, $2) as got',
        [NAMESPACE, key],
      );
      if (!rows[0]?.got) {
        log.info(`${kind} is already running elsewhere (held: ${name})`);
        await releaseAll();
        return null;
      }
      taken.push(key);
    }
  } catch (error) {
    await releaseAll();
    throw error;
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await releaseAll();
    },
  };
}

/**
 * Run `fn` holding the locks for `kind`, releasing them whatever happens.
 * Throws a 409-shaped error when another process is already running it, which
 * is the same shape the console's HTTP layer was already turning into a 409.
 */
export async function withJobLock<T>(kind: string, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireJobLock(kind);
  if (!lock) {
    throw Object.assign(new Error(`a ${kind} job is already running`), { status: 409 });
  }
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
