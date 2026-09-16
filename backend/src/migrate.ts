import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from './db.js';
import { logger } from './log.js';

const log = logger('migrate');
const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, '../migrations');

export async function migrate(): Promise<void> {
  // The bookkeeping table lives inside 0001, so create it up front to make the
  // first run idempotent too.
  await query(`create schema if not exists crawler`);
  await query(
    `create table if not exists crawler.schema_migrations (
       filename text primary key,
       applied_at timestamptz not null default now()
     )`,
  );

  const applied = new Set(
    (await query<{ filename: string }>(`select filename from crawler.schema_migrations`))
      .map((r) => r.filename),
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  let count = 0;

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool().connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query(
        `insert into crawler.schema_migrations (filename) values ($1)`,
        [file],
      );
      await client.query('commit');
      log.info(`applied ${file}`);
      count++;
    } catch (error) {
      await client.query('rollback');
      throw new Error(`migration ${file} failed: ${String(error)}`);
    } finally {
      client.release();
    }
  }

  log.info(count === 0 ? 'database already up to date' : `applied ${count} migration(s)`);
}
