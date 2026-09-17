// Ingredient amounts come from the crawler as free-form strings (e.g. "2 cups",
// "1 1/2 tsp", "1/2"), not a numeric quantity + unit pair, so scaling has to
// parse the leading number out of the string rather than just multiplying a field.

const UNICODE_FRACTIONS: Record<string, number> = {
  '¼': 1 / 4,
  '½': 1 / 2,
  '¾': 3 / 4,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '⅕': 1 / 5,
  '⅛': 1 / 8,
  '⅜': 3 / 8,
  '⅝': 5 / 8,
  '⅞': 7 / 8,
};

const UNICODE_FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join('');

// Matches a leading quantity: "1", "1.5", "1/2", "1 1/2", a unicode fraction
// like "¾", or a whole number glued to one (the crawler emits these with no
// space, e.g. "1½"), optionally followed by more text (unit and anything else).
const LEADING_QUANTITY_RE = new RegExp(
  `^\\s*(\\d+\\s+\\d+/\\d+|\\d+\\s*[${UNICODE_FRACTION_CHARS}]|\\d+/\\d+|\\d+(?:\\.\\d+)?|[${UNICODE_FRACTION_CHARS}])\\s*(.*)$`
);

function parseQuantityToken(token: string): number {
  const wholePlusUnicodeMatch = token.match(
    new RegExp(`^(\\d+)\\s*([${UNICODE_FRACTION_CHARS}])$`)
  );
  if (wholePlusUnicodeMatch) {
    const [, whole, fraction] = wholePlusUnicodeMatch;
    return Number(whole) + UNICODE_FRACTIONS[fraction];
  }

  if (token in UNICODE_FRACTIONS) {
    return UNICODE_FRACTIONS[token];
  }

  const mixedMatch = token.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixedMatch) {
    const [, whole, num, denom] = mixedMatch;
    return Number(whole) + Number(num) / Number(denom);
  }

  const fractionMatch = token.match(/^(\d+)\/(\d+)$/);
  if (fractionMatch) {
    const [, num, denom] = fractionMatch;
    return Number(num) / Number(denom);
  }

  return Number(token);
}

// Rounds to the nearest eighth and renders common fractions the way a recipe
// would (e.g. "1 1/2" rather than "1.5"), which keeps the scaled amount
// readable instead of dumping a repeating decimal.
function formatQuantity(value: number): string {
  const rounded = Math.round(value * 8) / 8;
  const whole = Math.floor(rounded);
  const remainder = Math.round((rounded - whole) * 8);

  const eighthsToFraction: Record<number, string> = {
    0: '',
    1: '1/8',
    2: '1/4',
    3: '3/8',
    4: '1/2',
    5: '5/8',
    6: '3/4',
    7: '7/8',
  };

  const fractionPart = eighthsToFraction[remainder] ?? '';

  if (!fractionPart) {
    return String(whole || rounded);
  }

  return whole > 0 ? `${whole} ${fractionPart}` : fractionPart;
}

/**
 * Scales the leading numeric quantity in a free-form ingredient amount string
 * (e.g. "2 cups" -> "4 cups" for ratio 2) and leaves the rest of the string
 * (unit, notes) untouched. Amounts with no parseable leading number, or an
 * empty string, are returned unchanged.
 */
export function scaleIngredientAmount(amount: string, ratio: number): string {
  if (!amount || !Number.isFinite(ratio) || ratio <= 0) {
    return amount;
  }

  const match = amount.match(LEADING_QUANTITY_RE);
  if (!match) {
    return amount;
  }

  const [, quantityToken, rest] = match;
  const quantity = parseQuantityToken(quantityToken);
  if (!Number.isFinite(quantity)) {
    return amount;
  }

  const scaled = formatQuantity(quantity * ratio);
  return rest ? `${scaled} ${rest}` : scaled;
}
