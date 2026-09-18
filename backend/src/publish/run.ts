import type { PoolClient } from 'pg';
import { normalizeImages } from '../crawl/images.js';
import { query, transaction } from '../db.js';
import { logger } from '../log.js';
import { formatCookingTime } from '../parse/duration.js';
import { formatAmount } from '../parse/ingredient.js';
import type { StagingRow } from '../types.js';
import { deriveFacets, type CanonicalFact } from './facets.js';
import { MAPPING } from './mapping.js';
import { preflight, printPreflight } from './preflight.js';

const log = logger('publish');

interface SourceRow {
  name: string;
  license: string | null;
  allow_image_use: boolean;
}

/**
 * Stage 4. Writes the app's wire shape exactly as the RN client reads it, so
 * `mapDbRowToRecipeDetail` needs no special cases. Idempotent on url_hash:
 * re-publishing the same source URL updates the existing recipe in place.
 *
 * `republish` also picks up rows already marked published, which is what you
 * want after changing something that publish derives rather than stores - a
 * source's `allow_image_use`, say, since the images live in staging either way
 * and only the publish step decides whether they reach the app.
 */
/**
 * What the Publish stage would actually do, as two numbers.
 *
 * `approved` is the obvious backlog: rows waiting to go live for the first
 * time. `stale` is the one the console used to hide - rows that are already
 * live but whose staging row has moved on since, because they were re-enriched
 * or their photos were mirrored. Publishing derives facets and copies image
 * paths, so "already published" stopped meaning "up to date" the moment those
 * arrived, and a console reading 0 was telling operators there was nothing to
 * do while the app served stale rows.
 *
 * Clearing `stale` needs the republish flag; a plain run only takes `approved`.
 */
export async function countPendingPublish(): Promise<{ approved: number; stale: number }> {
  const rows = await query<{ approved: number; stale: number }>(
    `select
       count(*) filter (where status = 'approved')::int as approved,
       count(*) filter (
         where status = 'published'
           and published_at is not null
           and (enriched_at > published_at or images_mirrored_at > published_at)
       )::int as stale
     from crawler.recipe_staging
     where enriched is not null`,
  );
  return rows[0] ?? { approved: 0, stale: 0 };
}

export async function publishAll(limit: number, republish = false): Promise<number> {
  const report = await preflight();
  if (!report.ok) {
    printPreflight(report);
    throw new Error('publish aborted: schema preflight failed');
  }

  const statuses = republish ? ['approved', 'published'] : ['approved'];
  const rows = await query<StagingRow>(
    `select * from crawler.recipe_staging
      where status = any($2) and enriched is not null
      order by quality_score desc nulls last, id
      limit $1`,
    [limit, statuses],
  );

  let published = 0;
  for (const row of rows) {
    try {
      const recipeId = await transaction((client) => publishOne(client, row));
      await query(
        `update crawler.recipe_staging
            set status = 'published', published_recipe_id = $2, published_at = now()
          where id = $1`,
        [row.id, recipeId],
      );
      published++;
      log.info(`#${row.id} -> recipes.${recipeId}  ${row.title ?? ''}`);
    } catch (error) {
      log.error(`#${row.id} publish failed`, String(error));
    }
  }

  log.info(`published ${published}/${rows.length}`);
  return published;
}

/**
 * What the app stores as a recipe's photo.
 *
 * A mirrored object path wins: the images stage has already copied the photo
 * into our own public bucket (see images/run.ts), and the app resolves a
 * relative path against EXPO_PUBLIC_STORAGE_URL. Falling back to the source's
 * own URL keeps rows published before the mirror existed working - utils/index.ts
 * passes an absolute URL through untouched.
 *
 * Either way `allow_image_use` governs: a source that does not permit it
 * publishes no photo at all, which is why 26 of the first 45 recipes have none.
 */
function heroImage(row: StagingRow, source: SourceRow | undefined): string | null {
  if (!source?.allow_image_use) return null;
  return row.image_paths[0] ?? row.image_url ?? null;
}

/**
 * The gallery, deduped here as well as at extraction time so rows parsed
 * before the extractors learned about CDN resize variants still publish
 * distinct photos instead of the same one four times.
 */
function galleryImages(row: StagingRow, source: SourceRow | undefined): string[] {
  if (!source?.allow_image_use) return [];
  return row.image_paths.length > 0 ? row.image_paths : normalizeImages(row.image_urls);
}

async function publishOne(client: PoolClient, row: StagingRow): Promise<number> {
  const source = await client.query<SourceRow>(
    `select name, license, allow_image_use from crawler.sources where id = $1`,
    [row.source_id],
  );
  const sourceRow = source.rows[0];
  const enriched = row.enriched!;

  // One lookup for the whole recipe. Only ingredients that resolved to the
  // dictionary come back, and facets.ts compares that count against the
  // recipe's own ingredient count before it claims any diet.
  const canonicalIds = row.ingredients
    .map((ingredient) => ingredient.canonicalId)
    .filter((id): id is number => typeof id === 'number');
  const facts = canonicalIds.length === 0
    ? []
    : (await client.query<{ slug: string; dietary_tags: string[] }>(
        `select slug, dietary_tags from crawler.ingredients_canonical where id = any($1)`,
        [canonicalIds],
      )).rows.map((fact): CanonicalFact => ({ slug: fact.slug, dietaryTags: fact.dietary_tags }));

  const facets = deriveFacets(row, enriched, facts);

  const R = MAPPING.recipes.columns;
  const recipeResult = await client.query<{ id: number }>(
    `insert into ${MAPPING.recipes.table}
       (${R.title}, ${R.description}, ${R.thumbnail}, ${R.cookingTime}, ${R.servings},
        ${R.difficulty}, ${R.rating}, ${R.aiScore}, ${R.reviewCount}, ${R.category}, ${R.cuisine},
        ${R.sourceUrl}, ${R.sourceName}, ${R.sourceLicense}, ${R.urlHash},
        ${R.contentFingerprint}, ${R.qualityScore}, ${R.enrichmentVersion},
        ${R.totalTimeSeconds}, ${R.activeTimeSeconds}, ${R.meal}, ${R.mainIngredient}, ${R.diet},
        ${R.crawledAt}, ${R.publishedAt})
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
             $19,$20,$21,$22,$23,now(),now())
     on conflict (${R.urlHash}) do update set
       ${R.title}              = excluded.${R.title},
       ${R.description}        = excluded.${R.description},
       ${R.thumbnail}          = excluded.${R.thumbnail},
       ${R.cookingTime}        = excluded.${R.cookingTime},
       ${R.servings}           = excluded.${R.servings},
       ${R.difficulty}         = excluded.${R.difficulty},
       ${R.aiScore}            = excluded.${R.aiScore},
       ${R.category}           = excluded.${R.category},
       ${R.cuisine}            = excluded.${R.cuisine},
       ${R.sourceName}         = excluded.${R.sourceName},
       ${R.sourceLicense}      = excluded.${R.sourceLicense},
       ${R.qualityScore}       = excluded.${R.qualityScore},
       ${R.enrichmentVersion}  = excluded.${R.enrichmentVersion},
       ${R.contentFingerprint} = excluded.${R.contentFingerprint},
       ${R.totalTimeSeconds}   = excluded.${R.totalTimeSeconds},
       ${R.activeTimeSeconds}  = excluded.${R.activeTimeSeconds},
       ${R.meal}               = excluded.${R.meal},
       ${R.mainIngredient}     = excluded.${R.mainIngredient},
       ${R.diet}               = excluded.${R.diet},
       ${R.publishedAt}        = now()
     returning ${R.id} as id`,
    [
      row.title,
      row.description,
      heroImage(row, sourceRow),
      formatCookingTime(enriched.totalTimeSeconds ?? row.total_time_seconds),
      enriched.servings ?? row.servings,
      enriched.difficulty,
      row.source_rating,
      enriched.aiScore,
      row.source_review_count ?? 0,
      row.category,
      facets.cuisine,
      row.source_url,
      sourceRow?.name ?? null,
      sourceRow?.license ?? null,
      row.url_hash,
      row.content_fingerprint,
      row.quality_score,
      row.enrichment_version,
      facets.totalTimeSeconds,
      facets.activeTimeSeconds,
      facets.meal,
      facets.mainIngredient,
      facets.diet,
    ],
  );

  const recipeId = recipeResult.rows[0]!.id;

  // Children are replace-on-publish: simpler and safer than diffing, because
  // instruction order and ingredient indices must stay internally consistent.
  for (const group of [MAPPING.images, MAPPING.ingredients, MAPPING.instructions, MAPPING.notes]) {
    await client.query(
      `delete from ${group.table} where ${group.columns.recipeId} = $1`,
      [recipeId],
    );
  }

  const I = MAPPING.images.columns;
  for (const [order, imagePath] of galleryImages(row, sourceRow).entries()) {
    await client.query(
      `insert into ${MAPPING.images.table} (${I.recipeId}, ${I.imagePath}, ${I.sortOrder})
       values ($1,$2,$3)`,
      [recipeId, imagePath, order],
    );
  }

  // ingredient_text is the exact string the app renders AND the string the
  // cooking screen substring-matches step ingredients against, so steps below
  // must reference these same strings verbatim.
  const ingredientText = new Map<number, string>();
  const G = MAPPING.ingredients.columns;
  for (const ingredient of row.ingredients) {
    const text = [ingredient.name, ingredient.prep].filter(Boolean).join(', ');
    ingredientText.set(ingredient.index, text);
    await client.query(
      `insert into ${MAPPING.ingredients.table}
         (${G.recipeId}, ${G.ingredientText}, ${G.amount}, ${G.sortOrder},
          ${G.canonicalId}, ${G.qty}, ${G.unit}, ${G.qtyGrams})
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        recipeId,
        text,
        formatAmount(ingredient),
        ingredient.index,
        ingredient.canonicalId,
        ingredient.qty,
        ingredient.unit,
        ingredient.qtyGrams,
      ],
    );
  }

  const S = MAPPING.instructions.columns;
  for (const step of enriched.steps) {
    const stepIngredients = step.ingredientIndices
      .map((index) => ingredientText.get(index))
      .filter((text): text is string => Boolean(text));
    await client.query(
      `insert into ${MAPPING.instructions.table}
         (${S.recipeId}, ${S.instructionText}, ${S.ingredients}, ${S.duration},
          ${S.timerName}, ${S.sortOrder})
       values ($1,$2,$3,$4,$5,$6)`,
      [recipeId, step.text, JSON.stringify(stepIngredients), step.durationSeconds, step.timerName, step.index],
    );
  }

  const N = MAPPING.notes.columns;
  for (const [order, note] of enriched.notes.entries()) {
    await client.query(
      `insert into ${MAPPING.notes.table} (${N.recipeId}, ${N.noteText}, ${N.sortOrder})
       values ($1,$2,$3)`,
      [recipeId, note, order],
    );
  }

  return recipeId;
}

export { preflight, printPreflight };
