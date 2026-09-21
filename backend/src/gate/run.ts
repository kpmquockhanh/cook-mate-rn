import { query } from '../db.js';
import { env } from '../env.js';
import { logger } from '../log.js';
import type { StagingRow } from '../types.js';
import { fingerprint, gradeRecipe } from './score.js';

const log = logger('gate');

/** A staging row plus which extractor tier produced the page behind it. */
interface GateRow extends StagingRow {
  extractor: string;
}

export async function gateAll(limit: number): Promise<Record<string, number>> {
  const rows = await query<GateRow>(
    `select s.*, r.extractor
       from crawler.recipe_staging s
       join crawler.raw_pages r on r.id = s.raw_page_id
      where s.status in ('parsed','enriched','review','rejected')
        and s.edited_by_human = false
        -- A row that has not been enriched yet is not ready to be graded.
        -- Grading it hits the fatal not_enriched issue and parks it in
        -- 'rejected', which the enrich stage never reads - so it is never
        -- enriched, and it stays in this queue forever.
        and s.enriched is not null
      -- Never-gated rows first, then the longest-ago gated. Ordering by id alone
      -- made the lowest-id rows (already rejected, and unchanged since) fill the
      -- whole limit on every run and starve newer rows behind them.
      order by s.gated_at asc nulls first, s.id
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

    // A recipe a model read off an unstructured page is not eligible for
    // publication on the score alone. Tiers A-C copy what a site published
    // about itself; tier D is a reading of prose, and a reading can be wrong in
    // ways no score detects - a misread quantity looks exactly like a correct
    // one. A person sees it first.
    if (row.extractor === 'llm' && status === 'approved') {
      status = 'review';
      issues.push({
        code: 'llm_extracted',
        severity: 'minor',
        message: 'Extracted from unstructured page by a model - needs a human read before publishing',
      });
    }

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
