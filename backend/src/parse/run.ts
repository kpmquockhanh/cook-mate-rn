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

/**
 * Stage 1: raw_pages -> recipe_staging. Purely deterministic, so it is safe to
 * re-run over the whole table any time you improve a parser.
 */
export async function parseAll(limit: number, force = false): Promise<number> {
  const pages = await query<RawPageRow>(
    `select r.id, r.url, r.url_hash, r.source_id, r.extracted
       from crawler.raw_pages r
      where r.extracted is not null
        ${force ? '' : 'and not exists (select 1 from crawler.recipe_staging s where s.url_hash = r.url_hash)'}
      order by r.fetched_at desc
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
