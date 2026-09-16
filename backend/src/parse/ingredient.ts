import type { ParsedIngredient } from '../types.js';
import { collapseWhitespace, decodeEntities } from '../util.js';
import { expandVulgarFractions, parseQuantity } from './numbers.js';
import { matchLeadingUnit, toGrams, type UnitDef } from './units.js';

/** Trailing clauses that describe preparation rather than identity. */
const PREP_WORDS = [
  'chopped', 'finely chopped', 'roughly chopped', 'minced', 'diced', 'sliced',
  'thinly sliced', 'grated', 'shredded', 'crushed', 'peeled', 'seeded',
  'deseeded', 'stemmed', 'trimmed', 'halved', 'quartered', 'cubed', 'julienned',
  'melted', 'softened', 'room temperature', 'chilled', 'beaten', 'lightly beaten',
  'whisked', 'drained', 'rinsed', 'divided', 'packed', 'lightly packed',
  'sifted', 'toasted', 'roasted', 'cooked', 'uncooked', 'raw', 'fresh', 'frozen',
  'thawed', 'cut into chunks', 'cut into strips', 'torn', 'zested', 'juiced',
  'plus more for serving', 'plus more', 'for garnish', 'for serving', 'to taste',
  'or more to taste', 'at room temperature', 'well shaken',
];

const OPTIONAL_MARKERS = /\b(optional|if desired|to taste|as needed)\b/i;

// "1 (14 oz) can tomatoes" - the parenthetical is package size, not the quantity.
const LEADING_PAREN = /^\(([^)]*)\)\s*/;

export interface ParseIngredientOptions {
  index: number;
}

/**
 * Deterministic ingredient parser. Everything here is rules - the LLM never
 * sees an ingredient line. Rules are cheap, reproducible, and unit-testable;
 * the LLM is reserved for the judgements rules genuinely cannot make.
 */
export function parseIngredient(raw: string, options: ParseIngredientOptions): ParsedIngredient {
  const original = collapseWhitespace(decodeEntities(raw));
  // Expand vulgar fractions up front so quantity offsets and this string share
  // one coordinate space - "1½" is 2 chars but "1 1/2" is 5.
  let working = expandVulgarFractions(original);
  let note: string | null = null;

  const optional = OPTIONAL_MARKERS.test(working);

  // --- quantity -------------------------------------------------------------
  const quantity = parseQuantity(working);
  let qty: number | null = null;
  let qtyMax: number | null = null;
  if (quantity) {
    qty = quantity.qty;
    qtyMax = quantity.qtyMax;
    working = working.slice(quantity.length).trimStart();
  }

  // A parenthetical immediately after the quantity is package size: capture it
  // as a note and, when it holds its own qty+unit, prefer it as the real amount.
  const leadingParen = LEADING_PAREN.exec(working);
  if (leadingParen) {
    note = leadingParen[1]!.trim();
    working = working.slice(leadingParen[0].length);
    const inner = parseQuantity(note);
    const innerUnit = inner ? matchLeadingUnit(note.slice(inner.length).trimStart()) : null;
    if (inner && innerUnit && qty !== null) {
      // "2 (14 oz) cans diced tomatoes" -> 28 oz of "diced tomatoes".
      // The container noun ("cans") has been absorbed into the total, so drop
      // it rather than leaving it stuck to the front of the name.
      qty = Number((qty * inner.qty).toFixed(4));
      qtyMax = null;
      const container = matchLeadingUnit(working.trimStart());
      if (container && container.unit.system === 'count') {
        working = working.trimStart().slice(container.length);
      }
      working = `${innerUnit.unit.canonical} ${working.trimStart()}`;
    }
  }

  // --- unit -----------------------------------------------------------------
  let unit: UnitDef | null = null;
  const unitMatch = matchLeadingUnit(working);
  if (unitMatch) {
    unit = unitMatch.unit;
    working = working.slice(unitMatch.length).trimStart();
  }

  // "of" after a unit: "a pinch of salt"
  working = working.replace(/^of\s+/i, '');

  // --- prep clause ----------------------------------------------------------
  let prep: string | null = null;
  const commaSplit = working.split(',');
  if (commaSplit.length > 1) {
    const tail = commaSplit.slice(1).join(',').trim();
    const tailLower = tail.toLowerCase();
    if (PREP_WORDS.some((word) => tailLower.includes(word))) {
      prep = tail.replace(/\.$/, '');
      working = commaSplit[0]!.trim();
    }
  }

  // Trailing parenthetical is a note ("(about 2 cups)")
  const trailingParen = /\s*\(([^)]*)\)\s*$/.exec(working);
  if (trailingParen) {
    note = note ? `${note}; ${trailingParen[1]!.trim()}` : trailingParen[1]!.trim();
    working = working.slice(0, trailingParen.index).trim();
  }

  // A bare prep word can also be a suffix with no comma: "garlic minced"
  if (!prep) {
    for (const word of [...PREP_WORDS].sort((a, b) => b.length - a.length)) {
      const pattern = new RegExp(`\\s+${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
      if (pattern.test(working)) {
        prep = word;
        working = working.replace(pattern, '').trim();
        break;
      }
    }
  }

  const name = collapseWhitespace(
    working
      .replace(OPTIONAL_MARKERS, '')
      .replace(/^[-–—•*\s]+/, '')
      .replace(/[,.;:]+$/, '')
      .trim(),
  );

  return {
    index: options.index,
    raw: original,
    qty,
    qtyMax,
    unit: unit?.canonical ?? null,
    name,
    prep,
    note,
    optional,
    qtyGrams: qty !== null ? toGrams(qty, unit, null) : null,
    canonicalId: null,
    canonicalSlug: null,
    matchConfidence: 0,
  };
}

/** Rebuild the display amount the app shows in `recipe_ingredients.amount`. */
export function formatAmount(ingredient: ParsedIngredient): string {
  if (ingredient.qty === null) return '';
  const number = (value: number) => {
    const rounded = Number(value.toFixed(2));
    const fractions: Array<[number, string]> = [
      [0.25, '¼'], [0.33, '⅓'], [0.5, '½'], [0.67, '⅔'], [0.75, '¾'],
    ];
    const whole = Math.floor(rounded);
    const remainder = Number((rounded - whole).toFixed(2));
    const glyph = fractions.find(([v]) => Math.abs(v - remainder) < 0.02)?.[1];
    if (glyph) return whole > 0 ? `${whole}${glyph}` : glyph;
    return String(rounded);
  };

  const amount = ingredient.qtyMax !== null
    ? `${number(ingredient.qty)}-${number(ingredient.qtyMax)}`
    : number(ingredient.qty);
  return ingredient.unit ? `${amount} ${ingredient.unit}` : amount;
}
