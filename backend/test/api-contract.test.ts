import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DETAIL_COLUMNS, LIST_COLUMNS } from '../src/api/queries/recipes.js';
import { ORDER_BY } from '../src/api/schema.js';
import { MAPPING, TRANSLATION_MAPPING } from '../src/publish/mapping.js';

// The publisher writes these tables and the API reads them. Nothing else ties
// the two together, so a rename on one side is silent until a screen renders
// blank. These assertions need no database.

const here = path.dirname(fileURLToPath(import.meta.url));
const QUERY_SOURCE = path.resolve(here, '../src/api/queries/recipes.ts');

/** Columns that legitimately exist without the publisher writing them. */
const NOT_PUBLISHED = new Set(['created_at']);
/** Surrogate keys the app uses for list rendering; mapping.ts omits them. */
const SURROGATE = new Set(['id']);

const recipeColumns = new Set<string>(Object.values(MAPPING.recipes.columns));

test('every recipe column the API selects is one the publisher writes', () => {
  const unknown = DETAIL_COLUMNS.filter(
    (column) => !recipeColumns.has(column) && !NOT_PUBLISHED.has(column),
  );
  assert.deepEqual(
    unknown,
    [],
    `not in MAPPING.recipes.columns: ${unknown.join(', ')}`,
  );
});

test('list columns are a subset of detail columns', () => {
  const detail = new Set<string>(DETAIL_COLUMNS);
  const missing = LIST_COLUMNS.filter((column) => !detail.has(column));
  assert.deepEqual(missing, [], `list selects columns detail does not: ${missing.join(', ')}`);
});

test('sortable columns are real recipe columns', () => {
  for (const column of Object.values(ORDER_BY)) {
    assert.ok(
      recipeColumns.has(column) || NOT_PUBLISHED.has(column),
      `ORDER_BY exposes '${column}', which is not a recipes column`,
    );
  }
});

/**
 * The detail query wraps translated fields in coalesce()/nullif() (migration
 * 0015), which would hide them from the pattern below. Dropping the wrapper
 * call leaves `'key', alias.column` exactly as the untranslated fields read,
 * so both kinds are checked by the same assertion.
 */
function unwrap(sql: string): string {
  return sql.replace(/\b(?:coalesce|nullif)\(/g, '');
}

test('child fields emitted by the detail SQL exist in the mapping', async () => {
  // Read the keys straight out of the json_build_object(...) calls rather than
  // re-declaring them here, so the test cannot drift from the query it checks.
  const sql = unwrap(await readFile(QUERY_SOURCE, 'utf8'));
  const emitted = [...sql.matchAll(/'(\w+)',\s*\w+\.\w+/g)].map((match) => match[1]!);
  assert.ok(emitted.length > 0, 'found no json_build_object keys - did the query change shape?');

  const childColumns = new Set<string>([
    ...Object.values(MAPPING.images.columns),
    ...Object.values(MAPPING.ingredients.columns),
    ...Object.values(MAPPING.instructions.columns),
    ...Object.values(MAPPING.notes.columns),
  ]);

  const unknown = [...new Set(emitted)].filter(
    (field) => !childColumns.has(field) && !SURROGATE.has(field),
  );
  assert.deepEqual(unknown, [], `emitted but not in MAPPING: ${unknown.join(', ')}`);
});

test('the fields the app reads are all emitted', async () => {
  // hooks/useRecipe.ts reads these names off each child row.
  const sql = await readFile(QUERY_SOURCE, 'utf8');
  for (const field of ['image_path', 'ingredient_text', 'amount', 'instruction_text', 'duration', 'timer_name', 'note_text']) {
    assert.ok(sql.includes(`'${field}'`), `detail query never emits '${field}'`);
  }
});

// --- Translation overlay (migration 0015) -----------------------------------

test('every translated column exists on both the base table and the overlay', () => {
  const overlay = new Set<string>(Object.values(TRANSLATION_MAPPING.recipe.columns));
  // Kept in step with TRANSLATED_COLUMNS in queries/recipes.ts: a column
  // coalesced there must exist on recipe_translations, or the join is a
  // guaranteed runtime error on the first localized request.
  for (const column of ['title', 'description', 'cuisine']) {
    assert.ok(recipeColumns.has(column), `'${column}' is not a published recipes column`);
    assert.ok(overlay.has(column), `'${column}' is coalesced but not on the translation overlay`);
  }
});

test('child overlays carry the text fields their base tables carry', () => {
  const pairs: [Record<string, string>, Record<string, string>][] = [
    [MAPPING.ingredients.columns, TRANSLATION_MAPPING.ingredients.columns],
    [MAPPING.instructions.columns, TRANSLATION_MAPPING.instructions.columns],
    [MAPPING.notes.columns, TRANSLATION_MAPPING.notes.columns],
  ];
  // Text the reader sees must be translatable; everything else (qty, duration,
  // canonical_id) is deliberately absent from the overlay and shared instead.
  const TEXT = new Set([
    'ingredient_text', 'amount', 'instruction_text', 'timer_name', 'ingredients', 'note_text',
  ]);

  for (const [base, overlay] of pairs) {
    const overlayColumns = new Set(Object.values(overlay));
    const missing = Object.values(base).filter((c) => TEXT.has(c) && !overlayColumns.has(c));
    assert.deepEqual(missing, [], `overlay cannot translate: ${missing.join(', ')}`);
    // Every child overlay is addressed by position, never by the child row's
    // id - publish/run.ts replaces child rows wholesale on each publish.
    assert.ok(overlayColumns.has('sort_order'), 'child overlay is not keyed by sort_order');
    assert.ok(overlayColumns.has('locale'), 'child overlay has no locale');
  }
});

test('the overlay is gated on content_fingerprint, not just on locale', async () => {
  // The one thing that stops a recrawled recipe from being served with the
  // previous version's translated steps. Asserted on the SQL because there is
  // no cheaper way to catch its removal than a screen of wrong instructions.
  const sql = await readFile(QUERY_SOURCE, 'utf8');
  assert.match(
    sql,
    /tr\.source_fingerprint is not distinct from r\.content_fingerprint/,
    'translation join no longer checks the fingerprint',
  );
  assert.ok(
    recipeColumns.has('content_fingerprint'),
    'the join reads content_fingerprint, which the publisher must write',
  );
});
