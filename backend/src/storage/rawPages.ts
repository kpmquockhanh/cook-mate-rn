import { query } from '../db.js';
import { logger } from '../log.js';
import { urlHash } from '../util.js';
import { describeStore, readPage, writePage } from './pages.js';

const log = logger('storage');

/**
 * Whether `raw_pages.html` is still there.
 *
 * True between migration 0006 (which adds the storage reference) and 0007
 * (which drops the column once every page has been moved). Reading it lets the
 * accessor serve pages that have not been backfilled yet, so the pipeline keeps
 * working throughout the transition instead of only after it.
 */
let legacyColumn: Promise<boolean> | null = null;

export function resetSchemaProbe(): void {
  legacyColumn = null;
}

function hasLegacyHtmlColumn(): Promise<boolean> {
  if (!legacyColumn) {
    legacyColumn = query<{ exists: boolean }>(
      `select exists (
         select 1 from information_schema.columns
          where table_schema = 'crawler' and table_name = 'raw_pages' and column_name = 'html'
       ) as exists`,
    ).then((rows) => rows[0]?.exists ?? false);
  }
  return legacyColumn;
}

export interface StoredPage {
  html: string;
  httpStatus: number;
}

/**
 * The most recent stored copy of a page, wherever its bytes currently live.
 *
 * This is the one place that knows a page might still be in the old column, so
 * everything upstream - discovery reusing a walked page, a later re-extraction
 * pass - just asks for the HTML and gets it.
 */
export async function readRawPage(rawUrl: string): Promise<StoredPage | null> {
  let hash: string;
  try {
    hash = urlHash(rawUrl);
  } catch {
    return null;
  }

  const legacy = await hasLegacyHtmlColumn();
  const rows = await query<{
    storage_path: string | null;
    http_status: number | null;
    html?: string | null;
  }>(
    `select storage_path, http_status${legacy ? ', html' : ''}
       from crawler.raw_pages
      where url_hash = $1
      order by fetched_at desc
      limit 1`,
    [hash],
  );

  const row = rows[0];
  if (!row) return null;
  const httpStatus = row.http_status ?? 200;

  if (row.storage_path) {
    const html = await readPage(row.storage_path);
    return html === null ? null : { html, httpStatus };
  }
  // Not backfilled yet.
  return row.html ? { html: row.html, httpStatus } : null;
}

/** Put a page's bytes in the store and return the reference to record. */
export async function saveRawPageHtml(contentHash: string, html: string): Promise<string> {
  return writePage(contentHash, html);
}

/**
 * Move every page still held in the `html` column into object storage.
 *
 * Idempotent and resumable: it selects only rows that have not moved, and a row
 * is marked moved in the same statement that clears its HTML, so an interrupted
 * run loses nothing and repeats nothing. Migration 0007 refuses to drop the
 * column until this reports zero remaining.
 */
export async function backfillRawPages(
  batch = 200,
  signal?: AbortSignal,
): Promise<{ moved: number; remaining: number; failed: number }> {
  if (!(await hasLegacyHtmlColumn())) {
    log.info('no `html` column - every page is already in object storage');
    return { moved: 0, remaining: 0, failed: 0 };
  }

  log.info(`moving raw pages into ${describeStore()}`);
  let moved = 0;
  let failed = 0;

  for (;;) {
    if (signal?.aborted) {
      log.warn('backfill cancelled');
      break;
    }

    const rows = await query<{ id: number; content_hash: string; html: string }>(
      `select id, content_hash, html
         from crawler.raw_pages
        where html is not null and storage_path is null
        order by id
        limit $1`,
      [batch],
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      try {
        const objectPath = await saveRawPageHtml(row.content_hash, row.html);
        // Clearing the column and recording the path in one statement is what
        // makes an interrupted run safe: a row is never pathless and empty.
        await query(
          `update crawler.raw_pages set storage_path = $2, html = null where id = $1`,
          [row.id, objectPath],
        );
        moved++;
      } catch (error) {
        failed++;
        log.error(`page #${row.id} could not be moved`, String(error));
      }
    }

    log.info(`moved ${moved} page(s) so far`);

    // Every row in this batch failed, so the next batch returns the same rows.
    if (failed >= rows.length && moved === 0) {
      log.error('no page in this batch could be moved; stopping rather than looping');
      break;
    }
  }

  const counted = await query<{ count: number }>(
    `select count(*)::int as count from crawler.raw_pages
      where html is not null and storage_path is null`,
  );
  const remaining = counted[0]?.count ?? 0;

  log.info(
    remaining === 0
      ? `backfill complete: ${moved} page(s) moved. Run \`npm run migrate\` to drop the column.`
      : `backfill stopped with ${remaining} page(s) still to move (${failed} failed)`,
  );
  return { moved, remaining, failed };
}
