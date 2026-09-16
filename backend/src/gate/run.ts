import { query } from '../db.js';
import { env } from '../env.js';
import { logger } from '../log.js';
import type { StagingRow } from '../types.js';
import { fingerprint, gradeRecipe } from './score.js';

const log = logger('gate');

export async function gateAll(limit: number): Promise<Record<string, number>> {
  const rows = await query<StagingRow>(
    `select * from crawler.recipe_staging
      where status in ('parsed','enriched','review','rejected')
        and edited_by_human = false
      order by id
      limit $1`,
    [limit],
  );

  const tally: Record<string, number> = { approved: 0, review: 0, rejected: 0, duplicate: 0 };

  for (const row of rows) {
    const result = gradeRecipe(row, env.qualityMinScore);
    const print = fingerprint(row);

    // Dedupe: if an earlier row with the same fingerprint is already approved
    // or published, this one is a syndicated copy.
    const duplicate = await query<{ id: number }>(
      `select id from crawler.recipe_staging
        where content_fingerprint = $1
          and id <> $2
          and status in ('approved','published')
        limit 1`,
      [print, row.id],
    );

    let status = result.status;
    const issues = [...result.issues];
    if (duplicate.length > 0 && status !== 'rejected') {
      status = 'rejected';
      issues.push({
        code: 'duplicate',
        severity: 'fatal',
        message: `Duplicate of staging row #${duplicate[0]!.id}`,
      });
      tally.duplicate = (tally.duplicate ?? 0) + 1;
    }

    await query(
      `update crawler.recipe_staging
          set content_fingerprint = $2,
              quality_score       = $3,
              quality_issues      = $4,
              status              = $5,
              gated_at            = now()
        where id = $1 and edited_by_human = false`,
      [row.id, print, result.score, JSON.stringify(issues), status],
    );

    tally[status] = (tally[status] ?? 0) + 1;
  }

  log.info(
    `gated ${rows.length}: ${tally.approved} approved, ${tally.review} review, ${tally.rejected} rejected (${tally.duplicate} duplicates)`,
  );
  return tally;
}
