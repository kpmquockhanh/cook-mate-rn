import { query } from '../db.js';
import { env } from '../env.js';
import { type Run, withRun } from '../jobs/runs.js';
import { logger } from '../log.js';
import { readRawPage } from '../storage/rawPages.js';
import { mapLimit, urlHash } from '../util.js';
import { classifyUrl } from './discover.js';
import { extractProse } from './prose.js';

const log = logger('extract');

interface PendingPage {
  id: number;
  url: string;
}

export interface ExtractTally {
  considered: number;
  extracted: number;
  notRecipe: number;
  failed: number;
}

/**
 * Tier D over the corpus.
 *
 * Selects pages the free tiers could not read and the current prompt version
 * has not seen. Every page here was already fetched and stored, so this makes
 * no request to any source site: bumping EXTRACTION_VERSION re-reads the whole
 * backlog offline, exactly as bumping ENRICHMENT_VERSION re-runs the stage
 * after it.
 */
export async function extractProseAll(
  limit: number,
  options: { dryRun?: boolean; concurrency?: number; signal?: AbortSignal } = {},
): Promise<ExtractTally> {
  return withRun('extract', { limit, dryRun: options.dryRun ?? false }, (run) =>
    extractWithin(limit, options, run),
  );
}

async function extractWithin(
  limit: number,
  options: { dryRun?: boolean; concurrency?: number; signal?: AbortSignal },
  run: Run,
): Promise<ExtractTally> {
  // Two ceilings on purpose: `--limit` is what the operator meant this run, and
  // EXTRACT_MAX_PAGES_PER_RUN is what a mistyped limit cannot get past.
  const ceiling = Math.min(limit, env.extractMaxPagesPerRun);
  if (ceiling < limit) {
    log.warn(`limit ${limit} capped to ${ceiling} by EXTRACT_MAX_PAGES_PER_RUN`);
  }

  const rows = await query<PendingPage>(
    `select id, url
       from crawler.raw_pages
      where extractor = 'none'
        and (extraction_version is null or extraction_version < $1)
      order by fetched_at desc
      limit $2`,
    [env.extractionVersion, ceiling * 3],
  );

  // A listing page is not worth a model call: it defeated tiers A-C because it
  // is a page of links, not because its recipe was written as prose. Filtering
  // on the URL shape here is free and is the difference between paying for
  // candidates and paying for navigation.
  const candidates = rows.filter((row) => {
    const verdict = classifyUrl(row.url);
    return verdict === 'recipe' || verdict === 'maybe';
  });
  const pages = candidates.slice(0, ceiling);
  run.bump('listings_skipped', rows.length - candidates.length);
  run.bump('considered', pages.length);

  if (pages.length === 0) {
    log.info('nothing to extract');
    return { considered: 0, extracted: 0, notRecipe: 0, failed: 0 };
  }

  log.info(
    `extracting ${pages.length} page(s) via ${env.enrichProvider}:${env.extractModel}` +
      ` (${rows.length - candidates.length} listing page(s) skipped)` +
      (options.dryRun ? ' - dry run, nothing written' : ''),
  );

  const tally: ExtractTally = { considered: pages.length, extracted: 0, notRecipe: 0, failed: 0 };

  await mapLimit(pages, options.concurrency ?? 4, async (page) => {
    if (options.signal?.aborted) return;
    try {
      const stored = await readRawPage(page.url);
      if (!stored) {
        tally.failed++;
        run.bump('failed_unreadable_page');
        log.warn(`#${page.id} ${page.url}: stored page could not be read`);
        return;
      }

      const { recipe, model, reason } = await extractProse(stored.html, page.url);

      if (options.dryRun) {
        log.info(
          recipe
            ? `#${page.id} would extract "${recipe.name ?? '(untitled)'}" from ${page.url}`
            : `#${page.id} no recipe (${reason}): ${page.url}`,
        );
        if (recipe) tally.extracted++;
        else tally.notRecipe++;
        return;
      }

      if (recipe) {
        await query(
          `update crawler.raw_pages
              set extracted = $2, extractor = 'llm',
                  extraction_version = $3, extraction_model = $4
            where id = $1`,
          [page.id, JSON.stringify(recipe), env.extractionVersion, model],
        );
        // The queue row says 'failed' because tiers A-C missed. Tier D has now
        // read it, so that verdict is out of date - and a 'failed' row is never
        // picked up by the revisit sweep, which only refreshes 'done'. Leaving
        // it would quietly exclude every prose-only recipe from staying fresh.
        await query(
          `update crawler.crawl_queue
              set status = 'done', last_error = null, finished_at = now()
            where url_hash = $1 and status = 'failed'`,
          [urlHash(page.url)],
        );
        tally.extracted++;
        run.bump('extracted');
        log.info(`#${page.id} ${recipe.name ?? '(untitled)'} (${recipe.recipeIngredient?.length} ingredients)`);
      } else {
        // Stamp the version but leave `extractor` as 'none'. The page stays a
        // miss for reporting, and this run's verdict stops the next run paying
        // to reach the same conclusion.
        await query(
          `update crawler.raw_pages
              set extraction_version = $2, extraction_model = $3
            where id = $1`,
          [page.id, env.extractionVersion, model],
        );
        // Replace the queue row's "awaiting extract" so it no longer reads as
        // pending. It stays 'failed': there is still no recipe at this URL.
        await query(
          `update crawler.crawl_queue
              set last_error = $2, finished_at = now()
            where url_hash = $1 and status = 'failed'`,
          [urlHash(page.url), `extract: no recipe (${reason ?? 'unknown'})`],
        );
        tally.notRecipe++;
        // By reason, because "the model declined" and "the model made it up"
        // are different problems with different fixes.
        run.bump(`no_recipe_${reason ?? 'unknown'}`.replace(/-/g, '_'));
        log.debug(`#${page.id} no recipe (${reason}): ${page.url}`);
      }
    } catch (error) {
      tally.failed++;
      run.bump('failed_error');
      log.error(`#${page.id} extraction failed`, String(error));
    }
  });

  log.info(
    `extracted ${tally.extracted} recipe(s); ${tally.notRecipe} page(s) carried none; ${tally.failed} failed`,
  );
  return tally;
}
