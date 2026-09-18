import { query } from '../db.js';
import { env } from '../env.js';
import { logger } from '../log.js';
import type { StagingRow } from '../types.js';
import { mapLimit } from '../util.js';
import { enrichRecipe } from './llm.js';

const log = logger('enrich');

/**
 * Stage 2. Selects rows that have never been enriched, or were enriched by an
 * older prompt version - bumping ENRICHMENT_VERSION re-runs the whole corpus
 * from stored raw pages without touching the network. Human-edited rows are
 * never overwritten.
 *
 * `includePublished` reaches rows that are already live. Without it, a bumped
 * version only ever improves recipes nobody has seen yet, which stopped being
 * acceptable once the publisher started deriving facets - meal, cuisine,
 * hands-on time - from what the model says. Re-enriching costs one model call
 * per row and changes nothing on its own: the rows have to be republished
 * (`publish --republish`) for the app to see the difference.
 */
export async function enrichAll(
  limit: number,
  options: { escalate?: boolean; concurrency?: number; includePublished?: boolean } = {},
): Promise<{ ok: number; failed: number }> {
  const statuses = options.includePublished
    ? ['parsed', 'enriched', 'review', 'published']
    : ['parsed', 'enriched', 'review'];

  const rows = await query<StagingRow>(
    `select * from crawler.recipe_staging
      where edited_by_human = false
        and status = any($3)
        and (enrichment_version is null or enrichment_version < $1)
        and jsonb_array_length(steps) > 0
      order by id
      limit $2`,
    [env.enrichmentVersion, limit, statuses],
  );

  if (rows.length === 0) {
    log.info('nothing to enrich');
    return { ok: 0, failed: 0 };
  }

  const model = options.escalate ? env.enrichEscalationModel : env.enrichModel;
  log.info(`enriching ${rows.length} recipe(s) via ${env.enrichProvider}:${model}`);

  let ok = 0;
  let failed = 0;

  await mapLimit(rows, options.concurrency ?? 4, async (row) => {
    try {
      const { result, model } = await enrichRecipe(
        {
          title: row.title ?? 'Untitled recipe',
          ingredients: row.ingredients,
          steps: row.steps,
          servingsHint: row.servings,
          totalTimeHint: row.total_time_seconds,
        },
        { escalate: options.escalate },
      );

      await query(
        `update crawler.recipe_staging
            set enriched           = $2,
                enrichment_version = $3,
                enrichment_model   = $4,
                servings           = coalesce($5, servings),
                total_time_seconds = coalesce($6, total_time_seconds),
                -- A row that is already live stays live. Sending it back to
                -- 'enriched' would drop it out of the set that
                -- publish --republish looks at, so the improved enrichment
                -- could never reach the app, and the row would need re-gating
                -- to get back.
                status             = case when status = 'published'
                                          then 'published' else 'enriched' end,
                enriched_at        = now()
          where id = $1 and edited_by_human = false`,
        [
          row.id,
          JSON.stringify(result),
          env.enrichmentVersion,
          model,
          result.servings,
          result.totalTimeSeconds,
        ],
      );

      const timers = result.steps.filter((s) => s.durationSeconds !== null).length;
      log.info(`#${row.id} ${row.title ?? ''} -> ${result.steps.length} steps, ${timers} timer(s)`);
      ok++;
    } catch (error) {
      failed++;
      log.error(`#${row.id} enrichment failed`, String(error));
    }
  });

  log.info(`enriched ${ok} recipe(s), ${failed} failed`);
  return { ok, failed };
}

/** Re-run rows the gate rejected, on the stronger model. */
export async function enrichEscalate(limit: number) {
  const rows = await query<{ id: number }>(
    `select id from crawler.recipe_staging
      where status = 'review' and edited_by_human = false
      order by quality_score desc nulls last
      limit $1`,
    [limit],
  );
  if (rows.length === 0) {
    log.info('no rows in review to escalate');
    return { ok: 0, failed: 0 };
  }
  // Clear the version stamp so enrichAll picks them up, then run on the big model.
  await query(
    `update crawler.recipe_staging set enrichment_version = null where id = any($1)`,
    [rows.map((r) => r.id)],
  );
  log.info(`escalating ${rows.length} recipe(s) to ${env.enrichEscalationModel}`);
  return enrichAll(limit, { escalate: true, concurrency: 2 });
}
