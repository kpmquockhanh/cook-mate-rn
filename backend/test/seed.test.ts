import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The seed is upserted by slug and its aliases drive ingredient matching, so a
// duplicate slug silently overwrites an entry and an alias claimed by two
// entries makes matching order-dependent. Both are invisible at runtime -
// `npm run seed` reports success either way - which is why they are asserted
// here instead.

const here = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.resolve(here, '../seed/canonical-ingredients.json');

// Mirrors the comment on crawler.ingredients_canonical.category in 0002.
const CATEGORIES = new Set([
  'produce', 'dairy', 'meat', 'seafood', 'pantry', 'spice', 'bakery', 'other',
]);

interface SeedEntry {
  slug: string;
  display_name: string;
  aliases?: string[];
  category?: string;
  grams_per_unit?: Record<string, number>;
  density_g_per_ml?: number;
}

const entries: SeedEntry[] = JSON.parse(await readFile(SEED_PATH, 'utf8'));

test('seed is a non-empty array of well-formed entries', () => {
  assert.ok(Array.isArray(entries) && entries.length > 0);
  for (const entry of entries) {
    assert.ok(entry.slug, `entry missing slug: ${JSON.stringify(entry)}`);
    assert.ok(entry.display_name, `${entry.slug}: missing display_name`);
    assert.match(entry.slug, /^[a-z0-9-]+$/, `${entry.slug}: slug must be kebab-case`);
  }
});

test('slugs are unique', () => {
  const seen = new Set<string>();
  const duplicates = entries.filter((e) => !seen.add(e.slug)).map((e) => e.slug);
  assert.deepEqual(duplicates, [], `duplicate slugs: ${duplicates.join(', ')}`);
});

test('no name or alias is claimed by two entries', () => {
  const owners = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const name of [entry.display_name, ...(entry.aliases ?? [])]) {
      const key = name.toLowerCase().trim();
      const set = owners.get(key) ?? new Set<string>();
      set.add(entry.slug);
      owners.set(key, set);
    }
  }
  const ambiguous = [...owners.entries()]
    .filter(([, slugs]) => slugs.size > 1)
    .map(([name, slugs]) => `${name} -> ${[...slugs].join(' / ')}`);
  assert.deepEqual(ambiguous, [], `ambiguous aliases:\n  ${ambiguous.join('\n  ')}`);
});

test('categories and unit weights are usable', () => {
  for (const entry of entries) {
    if (entry.category !== undefined) {
      assert.ok(CATEGORIES.has(entry.category), `${entry.slug}: bad category ${entry.category}`);
    }
    for (const [unit, grams] of Object.entries(entry.grams_per_unit ?? {})) {
      assert.ok(
        typeof grams === 'number' && Number.isFinite(grams) && grams > 0,
        `${entry.slug}: grams_per_unit.${unit} must be a positive number`,
      );
    }
    if (entry.density_g_per_ml !== undefined) {
      assert.ok(entry.density_g_per_ml > 0, `${entry.slug}: density must be positive`);
    }
  }
});
