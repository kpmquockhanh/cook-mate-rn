import { query } from '../db.js';
import type { ParsedIngredient } from '../types.js';
import { toGrams, findUnit } from '../parse/units.js';

export interface CanonicalRow {
  id: number;
  slug: string;
  display_name: string;
  aliases: string[];
  category: string | null;
  grams_per_unit: Record<string, number>;
  density_g_per_ml: number | null;
}

let cache: CanonicalRow[] | null = null;
let aliasIndex: Map<string, CanonicalRow> | null = null;

/** Drop words that carry no identity so "large free-range eggs" -> "egg". */
const NOISE = new Set([
  'fresh', 'frozen', 'dried', 'large', 'medium', 'small', 'extra', 'organic',
  'free', 'range', 'freerange', 'whole', 'raw', 'ripe', 'ground', 'good',
  'quality', 'best', 'plain', 'unsalted', 'salted', 'low', 'fat', 'reduced',
  'nonfat', 'skinless', 'boneless', 'lean', 'cold', 'warm', 'hot', 'room',
  'temperature', 'finely', 'roughly', 'thinly', 'freshly', 'about', 'approx',
]);

export function normalizeName(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
    .map(singularize)
    .filter((word) => !NOISE.has(word));
  return words.join(' ').trim();
}

function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('oes')) return word.slice(0, -2);
  if (word.endsWith('ses') || word.endsWith('shes') || word.endsWith('ches')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export async function loadCanonical(force = false): Promise<CanonicalRow[]> {
  if (cache && !force) return cache;
  cache = await query<CanonicalRow>(
    `select id, slug, display_name, aliases, category, grams_per_unit, density_g_per_ml
       from crawler.ingredients_canonical`,
  );
  aliasIndex = new Map();
  for (const row of cache) {
    for (const alias of [row.display_name, row.slug.replace(/-/g, ' '), ...row.aliases]) {
      aliasIndex.set(normalizeName(alias), row);
    }
  }
  return cache;
}

/** Dice coefficient over character bigrams - cheap, no dependency, good enough. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const set = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const gram = s.slice(i, i + 2);
      set.set(gram, (set.get(gram) ?? 0) + 1);
    }
    return set;
  };
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  for (const [gram, count] of left) {
    const other = right.get(gram);
    if (other) shared += Math.min(count, other);
  }
  return (2 * shared) / (a.length - 1 + b.length - 1);
}

export interface MatchResult {
  row: CanonicalRow | null;
  confidence: number;
}

/**
 * Three passes, strongest first:
 *   1. exact normalized alias hit  -> 1.0
 *   2. head-noun containment       -> 0.85
 *   3. bigram similarity >= 0.78   -> that score
 * Anything weaker is deliberately left unmatched and routed to the review
 * queue: a wrong canonical link silently corrupts every shopping list it
 * touches, which is far worse than an unmatched row a human can fix once.
 */
export async function matchIngredient(name: string): Promise<MatchResult> {
  const rows = await loadCanonical();
  const normalized = normalizeName(name);
  if (!normalized) return { row: null, confidence: 0 };

  const exact = aliasIndex!.get(normalized);
  if (exact) return { row: exact, confidence: 1 };

  // Containment: "boneless chicken thigh" contains canonical "chicken thigh".
  let containment: CanonicalRow | null = null;
  let containmentLength = 0;
  for (const row of rows) {
    for (const alias of [row.display_name, ...row.aliases]) {
      const candidate = normalizeName(alias);
      if (!candidate || candidate.length <= containmentLength) continue;
      const pattern = new RegExp(`(^|\\s)${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s)`);
      if (pattern.test(normalized)) {
        containment = row;
        containmentLength = candidate.length;
      }
    }
  }
  if (containment) return { row: containment, confidence: 0.85 };

  let best: CanonicalRow | null = null;
  let bestScore = 0;
  for (const row of rows) {
    for (const alias of [row.display_name, ...row.aliases]) {
      const score = similarity(normalized, normalizeName(alias));
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }
  }
  return bestScore >= 0.78 ? { row: best, confidence: Number(bestScore.toFixed(2)) } : { row: null, confidence: Number(bestScore.toFixed(2)) };
}

/** Attach canonical ids and recompute grams now that density is known. */
export async function resolveIngredients(
  ingredients: ParsedIngredient[],
  sourceUrl: string,
): Promise<ParsedIngredient[]> {
  const resolved: ParsedIngredient[] = [];
  for (const ingredient of ingredients) {
    const { row, confidence } = await matchIngredient(ingredient.name);
    if (!row) {
      await recordUnmatched(ingredient.name, sourceUrl);
      resolved.push({ ...ingredient, matchConfidence: confidence });
      continue;
    }
    resolved.push({
      ...ingredient,
      canonicalId: row.id,
      canonicalSlug: row.slug,
      matchConfidence: confidence,
      qtyGrams:
        ingredient.qty !== null
          ? toGrams(ingredient.qty, ingredient.unit ? findUnit(ingredient.unit) : null, row)
          : null,
    });
  }
  return resolved;
}

async function recordUnmatched(name: string, sourceUrl: string): Promise<void> {
  const normalized = normalizeName(name);
  if (!normalized) return;
  await query(
    `insert into crawler.unmatched_ingredients (raw_name, normalized, example_url)
     values ($1, $2, $3)
     on conflict (normalized) do update
        set occurrences = crawler.unmatched_ingredients.occurrences + 1,
            last_seen   = now()`,
    [name, normalized, sourceUrl],
  );
}

/** The manual task that most improves pipeline quality, ranked by impact. */
export async function reportUnmatched(limit = 50): Promise<void> {
  const rows = await query<{ raw_name: string; normalized: string; occurrences: number; example_url: string }>(
    `select raw_name, normalized, occurrences, example_url
       from crawler.unmatched_ingredients
      where resolved_to is null
      order by occurrences desc
      limit $1`,
    [limit],
  );
  if (rows.length === 0) {
    console.log('No unmatched ingredients. The canonical dictionary covers everything seen so far.');
    return;
  }
  console.log(`Top ${rows.length} unmatched ingredients - add these to seed/canonical-ingredients.json:\n`);
  for (const row of rows) {
    console.log(`  ${String(row.occurrences).padStart(4)}x  ${row.normalized.padEnd(32)} (e.g. "${row.raw_name}")`);
  }
}
