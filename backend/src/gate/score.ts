import type { QualityIssue, StagingRow } from '../types.js';
import { sha256 } from '../util.js';

const HARD_MAX_STEP_CHARS = 300;

/**
 * A recipe fingerprint that survives syndication: the same dish republished on
 * five domains gets five URLs and five titles but the same canonical ingredient
 * set. Falls back to normalized raw names when canonical matching is incomplete.
 */
export function fingerprint(row: StagingRow): string {
  const keys = row.ingredients
    .map((i) => i.canonicalSlug ?? i.name.toLowerCase().replace(/[^a-z]/g, ''))
    .filter(Boolean)
    .sort();
  const title = (row.title ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return sha256(`${title}|${[...new Set(keys)].join(',')}`);
}

export interface GateResult {
  score: number;
  issues: QualityIssue[];
  status: 'approved' | 'review' | 'rejected';
}

/**
 * Scoring starts at 100 and subtracts. `fatal` issues cap the recipe out of
 * publication entirely; `major` and `minor` reduce the score, and anything
 * under QUALITY_MIN_SCORE lands in review rather than in front of users.
 */
export function gradeRecipe(row: StagingRow, minScore: number): GateResult {
  const issues: QualityIssue[] = [];
  const fail = (code: string, severity: QualityIssue['severity'], message: string) =>
    issues.push({ code, severity, message });

  // --- structural completeness ---------------------------------------------
  if (!row.title || row.title.length < 3) fail('no_title', 'fatal', 'Missing or too-short title');
  if (row.ingredients.length < 3) fail('too_few_ingredients', 'fatal', `Only ${row.ingredients.length} ingredients`);
  if (row.steps.length < 2) fail('too_few_steps', 'fatal', `Only ${row.steps.length} steps`);
  if (!row.enriched) fail('not_enriched', 'fatal', 'Enrichment has not run');

  // --- fields Cooking Mode needs -------------------------------------------
  if (!row.image_url) fail('no_image', 'major', 'No image URL');
  if (!row.servings) fail('no_servings', 'major', 'Servings unknown - scaling and shopping list will be wrong');
  if (!row.total_time_seconds) fail('no_total_time', 'major', 'No total time for the recipe card');

  // --- canonical ingredient coverage ---------------------------------------
  const unmatched = row.ingredients.filter((i) => i.canonicalId === null);
  if (unmatched.length > 0) {
    const ratio = unmatched.length / row.ingredients.length;
    fail(
      'unmatched_ingredients',
      ratio > 0.3 ? 'major' : 'minor',
      `${unmatched.length}/${row.ingredients.length} unmatched: ${unmatched.slice(0, 5).map((i) => i.name).join(', ')}`,
    );
  }
  const noQuantity = row.ingredients.filter((i) => i.qty === null && !i.optional);
  if (noQuantity.length > row.ingredients.length * 0.25) {
    fail('missing_quantities', 'major', `${noQuantity.length} ingredients have no parsed quantity`);
  }

  // --- step shape -----------------------------------------------------------
  const longSteps = row.steps.filter((s) => s.text.length > HARD_MAX_STEP_CHARS);
  if (longSteps.length > 0) {
    fail('steps_too_long', 'major', `${longSteps.length} step(s) exceed ${HARD_MAX_STEP_CHARS} chars`);
  }

  if (row.enriched) {
    const enrichedSteps = row.enriched.steps;
    if (enrichedSteps.length !== row.steps.length) {
      fail('step_count_mismatch', 'fatal', 'Enrichment returned a different number of steps');
    }
    const badDuration = enrichedSteps.filter(
      (s) => s.durationSeconds !== null && (s.durationSeconds < 30 || s.durationSeconds > 8 * 3600),
    );
    if (badDuration.length > 0) {
      fail('implausible_duration', 'major', `${badDuration.length} step(s) with out-of-range durations`);
    }
    const linked = enrichedSteps.filter((s) => s.ingredientIndices.length > 0).length;
    if (linked === 0 && row.ingredients.length > 0) {
      fail('no_step_links', 'major', 'No step links to any ingredient - highlighting will be dead');
    }
    const timers = enrichedSteps.filter((s) => s.durationSeconds !== null).length;
    if (timers === 0) {
      fail('no_timers', 'minor', 'No timers - this recipe gains little from Cooking Mode');
    }
    const orphanIngredients = row.ingredients.filter(
      (i) => !enrichedSteps.some((s) => s.ingredientIndices.includes(i.index)),
    );
    if (orphanIngredients.length > row.ingredients.length * 0.5) {
      fail('many_orphan_ingredients', 'minor', `${orphanIngredients.length} ingredients are never used by a step`);
    }
  }

  const weights = { fatal: 100, major: 12, minor: 4 } as const;
  const penalty = issues.reduce((sum, issue) => sum + weights[issue.severity], 0);
  const score = Math.max(0, 100 - penalty);
  const hasFatal = issues.some((i) => i.severity === 'fatal');

  return {
    score,
    issues,
    status: hasFatal ? 'rejected' : score >= minScore ? 'approved' : 'review',
  };
}
