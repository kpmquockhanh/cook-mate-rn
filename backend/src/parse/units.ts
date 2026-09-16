export type UnitSystem = 'volume' | 'mass' | 'count' | 'length';

export interface UnitDef {
  canonical: string;
  system: UnitSystem;
  aliases: string[];
  /** Millilitres for volume units, grams for mass units. */
  ml?: number;
  grams?: number;
}

export const UNITS: UnitDef[] = [
  // --- volume (US unless noted) ---
  { canonical: 'cup', system: 'volume', ml: 236.588, aliases: ['cup', 'cups', 'c'] },
  { canonical: 'tbsp', system: 'volume', ml: 14.787, aliases: ['tbsp', 'tbsps', 'tbs', 'tblsp', 'tablespoon', 'tablespoons', 'T'] },
  { canonical: 'tsp', system: 'volume', ml: 4.929, aliases: ['tsp', 'tsps', 'teaspoon', 'teaspoons', 't'] },
  { canonical: 'fl oz', system: 'volume', ml: 29.574, aliases: ['fl oz', 'fl. oz.', 'fluid ounce', 'fluid ounces', 'floz'] },
  { canonical: 'ml', system: 'volume', ml: 1, aliases: ['ml', 'mls', 'millilitre', 'millilitres', 'milliliter', 'milliliters', 'cc'] },
  { canonical: 'l', system: 'volume', ml: 1000, aliases: ['l', 'lt', 'ltr', 'litre', 'litres', 'liter', 'liters'] },
  { canonical: 'quart', system: 'volume', ml: 946.353, aliases: ['quart', 'quarts', 'qt', 'qts'] },
  { canonical: 'pint', system: 'volume', ml: 473.176, aliases: ['pint', 'pints', 'pt', 'pts'] },
  { canonical: 'gallon', system: 'volume', ml: 3785.41, aliases: ['gallon', 'gallons', 'gal'] },

  // --- mass ---
  { canonical: 'g', system: 'mass', grams: 1, aliases: ['g', 'gr', 'gram', 'grams', 'gramme', 'grammes'] },
  { canonical: 'kg', system: 'mass', grams: 1000, aliases: ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms'] },
  { canonical: 'oz', system: 'mass', grams: 28.3495, aliases: ['oz', 'ozs', 'ounce', 'ounces'] },
  { canonical: 'lb', system: 'mass', grams: 453.592, aliases: ['lb', 'lbs', 'pound', 'pounds', '#'] },
  { canonical: 'mg', system: 'mass', grams: 0.001, aliases: ['mg', 'milligram', 'milligrams'] },

  // --- count / imprecise (no conversion; grams come from the canonical entry) ---
  { canonical: 'piece', system: 'count', aliases: ['piece', 'pieces', 'pc', 'pcs', 'whole'] },
  { canonical: 'clove', system: 'count', aliases: ['clove', 'cloves'] },
  { canonical: 'slice', system: 'count', aliases: ['slice', 'slices'] },
  { canonical: 'can', system: 'count', aliases: ['can', 'cans', 'tin', 'tins'] },
  { canonical: 'package', system: 'count', aliases: ['package', 'packages', 'pkg', 'packet', 'packets', 'pack'] },
  { canonical: 'bunch', system: 'count', aliases: ['bunch', 'bunches'] },
  { canonical: 'sprig', system: 'count', aliases: ['sprig', 'sprigs'] },
  { canonical: 'stalk', system: 'count', aliases: ['stalk', 'stalks', 'stick', 'sticks'] },
  { canonical: 'head', system: 'count', aliases: ['head', 'heads'] },
  { canonical: 'pinch', system: 'count', aliases: ['pinch', 'pinches'] },
  { canonical: 'dash', system: 'count', aliases: ['dash', 'dashes'] },
  { canonical: 'handful', system: 'count', aliases: ['handful', 'handfuls'] },
  { canonical: 'sheet', system: 'count', aliases: ['sheet', 'sheets'] },
  { canonical: 'fillet', system: 'count', aliases: ['fillet', 'fillets', 'filet', 'filets'] },
];

const lookup = new Map<string, UnitDef>();
for (const unit of UNITS) {
  for (const alias of unit.aliases) {
    lookup.set(alias.toLowerCase().replace(/\./g, ''), unit);
  }
}

/** Longest alias first so "fl oz" wins over "oz" when both could match. */
const sortedAliases = [...lookup.keys()].sort((a, b) => b.length - a.length);

export function findUnit(token: string): UnitDef | null {
  return lookup.get(token.toLowerCase().replace(/\./g, '').trim()) ?? null;
}

/** Match a unit at the start of `text`; returns the def and chars consumed. */
export function matchLeadingUnit(text: string): { unit: UnitDef; length: number } | null {
  const lower = text.toLowerCase().replace(/\./g, '');
  for (const alias of sortedAliases) {
    if (!lower.startsWith(alias)) continue;
    // Must be a whole token: "gallon" should not match inside "galangal".
    const next = lower[alias.length];
    if (next !== undefined && /[a-z]/.test(next)) continue;
    // Recover the length in the ORIGINAL string (dots were stripped above).
    let consumed = 0;
    let seen = 0;
    while (seen < alias.length && consumed < text.length) {
      if (text[consumed] !== '.') seen++;
      consumed++;
    }
    return { unit: lookup.get(alias)!, length: consumed };
  }
  return null;
}

/**
 * Convert to grams. Volume needs a density (g/ml) from the canonical entry;
 * count units need an explicit grams-per-unit. Returns null when we genuinely
 * cannot know - better a null than a fabricated weight in a shopping list.
 */
export function toGrams(
  qty: number,
  unit: UnitDef | null,
  canonical?: { density_g_per_ml?: number | null; grams_per_unit?: Record<string, number> } | null,
): number | null {
  if (!unit) {
    const perUnit = canonical?.grams_per_unit?.['piece'];
    return perUnit ? Number((qty * perUnit).toFixed(2)) : null;
  }
  if (unit.system === 'mass' && unit.grams) return Number((qty * unit.grams).toFixed(2));
  if (unit.system === 'volume' && unit.ml) {
    const perUnitOverride = canonical?.grams_per_unit?.[unit.canonical];
    if (perUnitOverride) return Number((qty * perUnitOverride).toFixed(2));
    const density = canonical?.density_g_per_ml;
    if (density) return Number((qty * unit.ml * density).toFixed(2));
    return null;
  }
  const perUnit = canonical?.grams_per_unit?.[unit.canonical];
  return perUnit ? Number((qty * perUnit).toFixed(2)) : null;
}
