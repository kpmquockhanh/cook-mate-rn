import { resolveIngredients } from '../canonical/match.js';
import { query } from '../db.js';
import { logger } from '../log.js';
import type { ExtractedRecipe, ParsedIngredient } from '../types.js';
import { collapseWhitespace } from '../util.js';
import { parseIsoDuration, parseServings } from './duration.js';
import { parseIngredient } from './ingredient.js';
import { segmentSteps } from './steps.js';

const log = logger('parse');

interface RawPageRow {
  id: number;
  url: string;
  url_hash: string;
  source_id: number | null;
  extracted: ExtractedRecipe;
}

// `raw_pages` is append-only: a page re-fetched with different content is a new
// row beside the old one, not an edit. So the candidate set is the latest row
// per URL - parsing an older one would overwrite staging with content the
// source has already moved past.
const LATEST_PAGES = `select distinct on (url_hash) id, url, url_hash, source_id, extracted, fetched_at
     from crawler.raw_pages
    where extracted is not null
    order by url_hash, fetched_at desc`;

// What makes a row pending is "staging is not already built from THIS row", not
// "staging has heard of this URL". The old test could never be false once a URL
// had been parsed, which is why a source editing a recipe needed `--force` to
// reach the app.
//
// One definition, used by the stage and by the console's backlog count, so the
// badge cannot report a queue the stage would not work through.
const PENDING = `not exists (
        select 1 from crawler.recipe_staging s
         where s.url_hash = l.url_hash
           and (s.raw_page_id = l.id or s.edited_by_human)
      )`;

/** How many pages `parseAll` would pick up right now, ignoring any limit. */
export async function countPendingParse(): Promise<number> {
  const rows = await query<{ count: number }>(
    `with latest as (${LATEST_PAGES})
     select count(*)::int as count from latest l where ${PENDING}`,
  );
  return rows[0]?.count ?? 0;
}

/**
 * Stage 1: raw_pages -> recipe_staging. Purely deterministic, so it is safe to
 * re-run over the whole table any time you improve a parser.
 */
export async function parseAll(limit: number, force = false): Promise<number> {
  const pages = await query<RawPageRow>(
    `with latest as (${LATEST_PAGES})
     select l.id, l.url, l.url_hash, l.source_id, l.extracted
       from latest l
      ${force ? '' : `where ${PENDING}`}
      order by l.fetched_at desc
      limit $1`,
    [limit],
  );

  let written = 0;
  for (const page of pages) {
    try {
      await parseOne(page);
      written++;
    } catch (error) {
      log.error(`parse failed for ${page.url}`, String(error));
    }
  }
  log.info(`parsed ${written}/${pages.length} page(s) into staging`);
  return written;
}

async function parseOne(page: RawPageRow): Promise<void> {
  const raw = page.extracted;

  const ingredients: ParsedIngredient[] = (raw.recipeIngredient ?? [])
    .map((line, index) => parseIngredient(line, { index }))
    .filter((ingredient) => ingredient.name.length > 0)
    // Re-index after filtering: the LLM returns positions into THIS array, so a
    // gap here would silently mislink every step that follows it.
    .map((ingredient, index) => ({ ...ingredient, index }));

  const resolved = await resolveIngredients(ingredients, page.url);
  const steps = segmentSteps(raw.recipeInstructions ?? []);

  const totalTime =
    parseIsoDuration(raw.totalTime) ??
    ((parseIsoDuration(raw.prepTime) ?? 0) + (parseIsoDuration(raw.cookTime) ?? 0) || null);

  await query(
    `insert into crawler.recipe_staging (
       raw_page_id, url_hash, source_url, source_id, title, description, image_url,
       image_urls, servings, total_time_seconds, prep_time_seconds, cook_time_seconds,
       cuisine, category, keywords, source_rating, source_review_count,
       ingredients, steps, status, parsed_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'parsed',now())
     on conflict (url_hash) do update set
       raw_page_id        = excluded.raw_page_id,
       title              = excluded.title,
       description        = excluded.description,
       image_url          = excluded.image_url,
       image_urls         = excluded.image_urls,
       servings           = excluded.servings,
       total_time_seconds = excluded.total_time_seconds,
       prep_time_seconds  = excluded.prep_time_seconds,
       cook_time_seconds  = excluded.cook_time_seconds,
       cuisine            = excluded.cuisine,
       category           = excluded.category,
       keywords           = excluded.keywords,
       source_rating      = excluded.source_rating,
       source_review_count= excluded.source_review_count,
       ingredients        = excluded.ingredients,
       steps              = excluded.steps,
       -- New raw page behind this URL means the source changed the recipe, so
       -- the enrichment describing the OLD steps is not just stale, it is
       -- wrong: its timers and step-to-ingredient indices point into an array
       -- that no longer exists. Clearing it puts the row back in front of
       -- the enrich stage. A re-parse of the same page (--force) keeps it, so
       -- improving a parser does not re-buy the whole corpus.
       enriched           = case when crawler.recipe_staging.raw_page_id is distinct from excluded.raw_page_id
                                 then null else crawler.recipe_staging.enriched end,
       enrichment_version = case when crawler.recipe_staging.raw_page_id is distinct from excluded.raw_page_id
                                 then null else crawler.recipe_staging.enrichment_version end,
       enrichment_model   = case when crawler.recipe_staging.raw_page_id is distinct from excluded.raw_page_id
                                 then null else crawler.recipe_staging.enrichment_model end,
       status             = 'parsed',
       parsed_at          = now()
     where crawler.recipe_staging.edited_by_human = false`,
    [
      page.id,
      page.url_hash,
      page.url,
      page.source_id,
      raw.name ? collapseWhitespace(raw.name) : null,
      raw.description ?? null,
      raw.image?.[0] ?? null,
      JSON.stringify(raw.image ?? []),
      parseServings(raw.recipeYield),
      totalTime,
      parseIsoDuration(raw.prepTime),
      parseIsoDuration(raw.cookTime),
      raw.recipeCuisine ?? null,
      raw.recipeCategory ?? null,
      raw.keywords ?? [],
      raw.ratingValue ?? null,
      raw.ratingCount ?? null,
      JSON.stringify(resolved),
      JSON.stringify(steps),
    ],
  );
}
