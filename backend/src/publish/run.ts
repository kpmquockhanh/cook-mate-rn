import type { PoolClient } from 'pg';
import { normalizeImages } from '../crawl/images.js';
import { query, transaction } from '../db.js';
import { logger } from '../log.js';
import { formatCookingTime } from '../parse/duration.js';
import { formatAmount } from '../parse/ingredient.js';
import type { StagingRow } from '../types.js';
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

async function publishOne(client: PoolClient, row: StagingRow): Promise<number> {
  const source = await client.query<SourceRow>(
    `select name, license, allow_image_use from crawler.sources where id = $1`,
    [row.source_id],
  );
  const sourceRow = source.rows[0];
  const enriched = row.enriched!;

  const R = MAPPING.recipes.columns;
  const recipeResult = await client.query<{ id: number }>(
    `insert into ${MAPPING.recipes.table}
       (${R.title}, ${R.description}, ${R.thumbnail}, ${R.cookingTime}, ${R.servings},
        ${R.difficulty}, ${R.rating}, ${R.aiScore}, ${R.reviewCount}, ${R.category}, ${R.cuisine},
        ${R.sourceUrl}, ${R.sourceName}, ${R.sourceLicense}, ${R.urlHash},
        ${R.contentFingerprint}, ${R.qualityScore}, ${R.enrichmentVersion},
        ${R.crawledAt}, ${R.publishedAt})
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now(),now())
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
       ${R.publishedAt}        = now()
     returning ${R.id} as id`,
    [
      row.title,
      row.description,
      // Only republish the source's photo when the licence actually allows it.
      sourceRow?.allow_image_use ? row.image_url : null,
      formatCookingTime(enriched.totalTimeSeconds ?? row.total_time_seconds),
      enriched.servings ?? row.servings,
      enriched.difficulty,
      row.source_rating,
      enriched.aiScore,
      row.source_review_count ?? 0,
      row.category,
      row.cuisine,
      row.source_url,
      sourceRow?.name ?? null,
      sourceRow?.license ?? null,
      row.url_hash,
      row.content_fingerprint,
      row.quality_score,
      row.enrichment_version,
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

  if (sourceRow?.allow_image_use) {
    const I = MAPPING.images.columns;
    // Also deduped here, not just at extraction time, so rows parsed before
    // the extractors learned about CDN resize variants still publish a gallery
    // of distinct photos instead of the same one four times.
    for (const [order, imagePath] of normalizeImages(row.image_urls).entries()) {
      await client.query(
        `insert into ${MAPPING.images.table} (${I.recipeId}, ${I.imagePath}, ${I.sortOrder})
         values ($1,$2,$3)`,
        [recipeId, imagePath, order],
      );
    }
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
