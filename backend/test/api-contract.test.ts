import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DETAIL_COLUMNS, LIST_COLUMNS } from '../src/api/queries/recipes.js';
import { ORDER_BY } from '../src/api/schema.js';
import { MAPPING } from '../src/publish/mapping.js';

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

test('child fields emitted by the detail SQL exist in the mapping', async () => {
  // Read the keys straight out of the json_build_object(...) calls rather than
  // re-declaring them here, so the test cannot drift from the query it checks.
  const sql = await readFile(QUERY_SOURCE, 'utf8');
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
