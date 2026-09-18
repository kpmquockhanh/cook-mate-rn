import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query } from '../db.js';
import { logger } from '../log.js';
import { loadCanonical } from './match.js';

const log = logger('seed');

interface SeedEntry {
  slug: string;
  display_name: string;
  aliases?: string[];
  category?: string;
  default_unit?: string;
  grams_per_unit?: Record<string, number>;
  density_g_per_ml?: number;
  is_pantry_staple?: boolean;
  /** meat | seafood | dairy | egg | animal | gluten - see migration 0012. */
  dietary_tags?: string[];
}

// ESM: __dirname does not exist. Derive the path from import.meta.url.
const here = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.resolve(here, '../../seed/canonical-ingredients.json');

/**
 * Idempotent upsert by slug. Re-running after you extend the JSON file only
 * adds/updates rows - it never drops canonical ids that published recipes
 * already point at.
 */
export async function seedCanonical(filePath = SEED_PATH): Promise<number> {
  const entries = JSON.parse(await readFile(filePath, 'utf8')) as SeedEntry[];
  let written = 0;

  for (const entry of entries) {
    await query(
      `insert into crawler.ingredients_canonical
         (slug, display_name, aliases, category, default_unit, grams_per_unit,
          density_g_per_ml, is_pantry_staple, dietary_tags)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (slug) do update set
         display_name     = excluded.display_name,
         aliases          = excluded.aliases,
         category         = excluded.category,
         default_unit     = excluded.default_unit,
         grams_per_unit   = excluded.grams_per_unit,
         density_g_per_ml = excluded.density_g_per_ml,
         is_pantry_staple = excluded.is_pantry_staple,
         dietary_tags     = excluded.dietary_tags`,
      [
        entry.slug,
        entry.display_name,
        entry.aliases ?? [],
        entry.category ?? null,
        entry.default_unit ?? null,
        JSON.stringify(entry.grams_per_unit ?? {}),
        entry.density_g_per_ml ?? null,
        entry.is_pantry_staple ?? false,
        entry.dietary_tags ?? [],
      ],
    );
    written++;
  }

  await loadCanonical(true);
  log.info(`seeded ${written} canonical ingredients`);
  return written;
}
