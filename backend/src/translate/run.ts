import { query, transaction } from '../db.js';
import { env } from '../env.js';
import { logger } from '../log.js';
import { mapLimit } from '../util.js';
import {
  isTargetLanguage,
  translateRecipe,
  TARGET_LANGUAGES,
  type TargetLanguage,
  type TranslateInput,
  type TranslationResult,
} from './llm.js';

const log = logger('translate');

/**
 * Stage 5: published recipes, restated in another language.
 *
 * Unlike every stage before it, this one reads `public.*` rather than
 * `crawler.recipe_staging`, and it runs AFTER publish rather than before.
 * That is not an accident of ordering - it is forced by what the overlay is
 * keyed on (migration 0015):
 *
 *   - Child overlays are addressed by `sort_order`, which only exists once the
 *     publisher has written the child rows.
 *   - The staleness gate compares against `public.recipes.content_fingerprint`,
 *     which is a published column.
 *
 * So a recipe becomes translatable the moment it goes live, and a recrawl that
 * changes it makes the translation stale the moment it is republished. There
 * is no window in which the app can serve translated text belonging to a
 * different version of the recipe: the API simply stops applying the overlay
 * (see api/queries/recipes.ts) until this stage catches up.
 */

interface CandidateRow {
  id: number;
  title: string;
  description: string | null;
  cuisine: string | null;
  content_fingerprint: string | null;
}

interface ChildRow {
  recipe_id: number;
  sort_order: number;
  text: string;
  amount: string | null;
  timer_name: string | null;
  ingredients: string[] | null;
}

/**
 * What still needs translating into `locale`, newest-first by nothing in
 * particular - `order by id` so a `--limit`ed run is resumable and two runs
 * never fight over the same rows.
 *
 * Three reasons a recipe is a candidate, and the query has to state all three
 * or a re-run quietly does nothing:
 *   1. never translated into this locale;
 *   2. translated, but the recipe has been republished since (fingerprint moved);
 *   3. translated at an older TRANSLATION_VERSION (the prompt has changed).
 */
async function candidates(locale: string, limit: number, force: boolean): Promise<CandidateRow[]> {
  const staleness = force
    ? 'true'
    : `(tr.recipe_id is null
        or tr.source_fingerprint is distinct from r.content_fingerprint
        or tr.translation_version is null
        or tr.translation_version < $3)`;

  return query<CandidateRow>(
    `select r.id, r.title, r.description, r.cuisine, r.content_fingerprint
       from public.recipes r
       left join public.recipe_translations tr
              on tr.recipe_id = r.id and tr.locale = $1
      where ${staleness}
      order by r.id
      limit $2`,
    [locale, limit, env.translationVersion],
  );
}

/** The three child sets for a page of recipes, in two round trips rather than 3N. */
async function children(recipeIds: number[]) {
  const [ingredients, steps, notes] = await Promise.all([
    query<ChildRow>(
      `select recipe_id, sort_order, ingredient_text as text, amount,
              null as timer_name, null as ingredients
         from public.recipe_ingredients
        where recipe_id = any($1) order by recipe_id, sort_order`,
      [recipeIds],
    ),
    query<ChildRow>(
      `select recipe_id, sort_order, instruction_text as text, null as amount,
              timer_name,
              -- jsonb -> text[] here rather than in JS, so a malformed array
              -- fails loudly at the boundary instead of shaping a bad prompt.
              coalesce(
                (select array_agg(value::text) from jsonb_array_elements_text(ingredients) as value),
                '{}'::text[]
              ) as ingredients
         from public.recipe_instructions
        where recipe_id = any($1) order by recipe_id, sort_order`,
      [recipeIds],
    ),
    query<ChildRow>(
      `select recipe_id, sort_order, note_text as text, null as amount,
              null as timer_name, null as ingredients
         from public.recipe_notes
        where recipe_id = any($1) order by recipe_id, sort_order`,
      [recipeIds],
    ),
  ]);

  const group = (rows: ChildRow[]): Map<number, ChildRow[]> => {
    const byRecipe = new Map<number, ChildRow[]>();
    for (const row of rows) {
      const list = byRecipe.get(row.recipe_id);
      if (list) list.push(row);
      else byRecipe.set(row.recipe_id, [row]);
    }
    return byRecipe;
  };

  return { ingredients: group(ingredients), steps: group(steps), notes: group(notes) };
}

/**
 * Write one recipe's overlay.
 *
 * Delete-then-insert per child set, inside one transaction with the parent
 * row: an overlay is only ever whole. A partial write is the one state the
 * read path cannot detect - it gates on the parent's fingerprint, so a parent
 * that landed without its children would serve a translated title above
 * English steps.
 *
 * The delete also handles a recipe that lost steps between publishes: rows at
 * positions that no longer exist would otherwise linger and attach themselves
 * to whatever ends up at that sort_order next.
 */
async function writeOverlay(
  recipeId: number,
  locale: TargetLanguage,
  fingerprint: string | null,
  result: TranslationResult,
  model: string,
): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      `insert into public.recipe_translations
         (recipe_id, locale, title, description, cuisine,
          source_fingerprint, translation_version, model, translated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8, now())
       on conflict (recipe_id, locale) do update set
         title               = excluded.title,
         description         = excluded.description,
         cuisine             = excluded.cuisine,
         source_fingerprint  = excluded.source_fingerprint,
         translation_version = excluded.translation_version,
         model               = excluded.model,
         translated_at       = now()`,
      [
        recipeId, locale, result.title, result.description, result.cuisine,
        fingerprint, env.translationVersion, model,
      ],
    );

    for (const table of [
      'recipe_ingredient_translations',
      'recipe_instruction_translations',
      'recipe_note_translations',
    ]) {
      await client.query(
        `delete from public.${table} where recipe_id = $1 and locale = $2`,
        [recipeId, locale],
      );
    }

    for (const ingredient of result.ingredients) {
      await client.query(
        `insert into public.recipe_ingredient_translations
           (recipe_id, locale, sort_order, ingredient_text, amount)
         values ($1,$2,$3,$4,$5)`,
        [recipeId, locale, ingredient.sortOrder, ingredient.text, ingredient.amount],
      );
    }
    for (const step of result.steps) {
      await client.query(
        `insert into public.recipe_instruction_translations
           (recipe_id, locale, sort_order, instruction_text, timer_name, ingredients)
         values ($1,$2,$3,$4,$5,$6::jsonb)`,
        [recipeId, locale, step.sortOrder, step.text, step.timerName, JSON.stringify(step.ingredients)],
      );
    }
    for (const note of result.notes) {
      await client.query(
        `insert into public.recipe_note_translations
           (recipe_id, locale, sort_order, note_text)
         values ($1,$2,$3,$4)`,
        [recipeId, locale, note.sortOrder, note.text],
      );
    }
  });
}

export interface TranslateOptions {
  /** Defaults to TRANSLATE_LOCALES. Every entry must be a TARGET_LANGUAGES key. */
  locales?: string[];
  concurrency?: number;
  /** Re-translate rows that are already current. */
  force?: boolean;
  escalate?: boolean;
  /** Translate and print, write nothing. The way to read a prompt change. */
  dryRun?: boolean;
}

export async function translateAll(
  limit: number,
  options: TranslateOptions = {},
): Promise<{ ok: number; failed: number; skipped: number }> {
  const requested = options.locales?.length ? options.locales : env.translateLocales;

  // Named up front rather than per row: a typo in TRANSLATE_LOCALES should
  // stop the run, not spend a model call and then fail on the write.
  const unknown = requested.filter((locale) => !isTargetLanguage(locale));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown translation locale(s): ${unknown.join(', ')}. ` +
        `Known: ${Object.keys(TARGET_LANGUAGES).join(', ')}.`,
    );
  }
  const locales = requested as TargetLanguage[];

  let ok = 0;
  let failed = 0;
  let skipped = 0;

  for (const locale of locales) {
    const rows = await candidates(locale, limit, options.force ?? false);
    if (rows.length === 0) {
      log.info(`${locale}: nothing to translate`);
      continue;
    }

    const sets = await children(rows.map((row) => row.id));
    const model = options.escalate ? env.enrichEscalationModel : env.translateModel;
    log.info(
      `${locale}: translating ${rows.length} recipe(s) via ${env.enrichProvider}:${model}` +
        (options.dryRun ? ' (dry run)' : ''),
    );

    await mapLimit(rows, options.concurrency ?? 4, async (row) => {
      const steps = sets.steps.get(row.id) ?? [];
      // A recipe with no steps has nothing a cook reads. Translating its title
      // alone would mark it done and it would never be revisited.
      if (steps.length === 0) {
        skipped++;
        log.warn(`#${row.id} has no instructions - skipped`);
        return;
      }

      const input: TranslateInput = {
        recipeId: row.id,
        title: row.title,
        description: row.description,
        cuisine: row.cuisine,
        ingredients: (sets.ingredients.get(row.id) ?? []).map((child) => ({
          sortOrder: child.sort_order,
          text: child.text,
          amount: child.amount,
        })),
        steps: steps.map((child) => ({
          sortOrder: child.sort_order,
          text: child.text,
          timerName: child.timer_name,
          ingredients: child.ingredients ?? [],
        })),
        notes: (sets.notes.get(row.id) ?? []).map((child) => ({
          sortOrder: child.sort_order,
          text: child.text,
        })),
      };

      try {
        const { result, model } = await translateRecipe(input, locale, {
          escalate: options.escalate,
        });

        if (options.dryRun) {
          log.info(`#${row.id} ${row.title} -> ${result.title}`);
          for (const step of result.steps.slice(0, 2)) {
            log.info(`    ${step.sortOrder}. ${step.text}`);
          }
          ok++;
          return;
        }

        await writeOverlay(row.id, locale, row.content_fingerprint, result, model);
        log.info(
          `#${row.id} ${locale}: ${result.title} ` +
            `(${result.ingredients.length} ingredient(s), ${result.steps.length} step(s))`,
        );
        ok++;
      } catch (error) {
        failed++;
        log.error(`#${row.id} ${locale} translation failed`, String(error));
      }
    });
  }

  log.info(`translated ${ok} recipe(s), ${skipped} skipped, ${failed} failed`);
  return { ok, failed, skipped };
}

/**
 * How much of the published corpus is readable in each language.
 *
 * Counts only overlays the API would actually apply - current fingerprint AND
 * current version - because a row that exists but is not served is not
 * coverage, and the difference between the two numbers is the whole point of
 * running this after a republish.
 */
export async function translationCoverage(): Promise<
  { locale: string; current: number; stale: number; total: number }[]
> {
  return query(
    `select tr.locale,
            count(*) filter (
              where tr.source_fingerprint is not distinct from r.content_fingerprint
                and tr.translation_version >= $1
            )::int as current,
            count(*) filter (
              where tr.source_fingerprint is distinct from r.content_fingerprint
                 or tr.translation_version is null
                 or tr.translation_version < $1
            )::int as stale,
            (select count(*)::int from public.recipes) as total
       from public.recipe_translations tr
       join public.recipes r on r.id = tr.recipe_id
      group by tr.locale
      order by tr.locale`,
    [env.translationVersion],
  );
}

/**
 * The console's backlog number: how many published recipes each configured
 * locale still owes, and how many it owes because the recipe moved on.
 *
 * Reported for every locale in TRANSLATE_LOCALES, not just the ones with rows
 * already - a language nobody has translated yet is the largest backlog there
 * is, and `translationCoverage()` cannot show it, because it joins from the
 * overlay table and a locale with no overlay has nothing to join from.
 *
 * `stale` is a subset of `outstanding`, kept separate because the two mean
 * different things to whoever is looking: `outstanding` is work never done,
 * `stale` is work undone by a republish - a recipe the app is serving in
 * English right now despite having been translated once.
 */
export async function translationBacklog(): Promise<
  { locale: string; outstanding: number; stale: number; total: number }[]
> {
  return query(
    `select l.locale,
            count(*) filter (
              where tr.recipe_id is null
                 or tr.source_fingerprint is distinct from r.content_fingerprint
                 or tr.translation_version is null
                 or tr.translation_version < $2
            )::int as outstanding,
            count(*) filter (
              where tr.recipe_id is not null
                and (tr.source_fingerprint is distinct from r.content_fingerprint
                     or tr.translation_version is null
                     or tr.translation_version < $2)
            )::int as stale,
            count(*)::int as total
       from public.recipes r
       cross join unnest($1::text[]) as l(locale)
       left join public.recipe_translations tr
              on tr.recipe_id = r.id and tr.locale = l.locale
      group by l.locale
      order by l.locale`,
    [env.translateLocales, env.translationVersion],
  );
}
