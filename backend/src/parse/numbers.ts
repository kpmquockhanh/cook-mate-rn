/** Unicode vulgar fractions that appear constantly in scraped ingredient lines. */
const VULGAR: Record<string, number> = {
  '¼': 0.25, '½': 0.5, '¾': 0.75,
  '⅐': 1 / 7, '⅑': 1 / 9, '⅒': 0.1,
  '⅓': 1 / 3, '⅔': 2 / 3,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
  '⅙': 1 / 6, '⅚': 5 / 6,
  '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  dozen: 12, half: 0.5, quarter: 0.25, third: 1 / 3,
};

export function expandVulgarFractions(text: string): string {
  let out = '';
  for (const char of text) {
    const value = VULGAR[char];
    // "1½" must become "1 1/2", not "11/2" - insert a space when a digit precedes.
    if (value !== undefined) {
      const needsSpace = out.length > 0 && /\d/.test(out.at(-1)!);
      out += `${needsSpace ? ' ' : ''}${fractionString(value)}`;
    } else {
      out += char;
    }
  }
  return out;
}

function fractionString(value: number): string {
  const entry = Object.entries(VULGAR).find(([, v]) => v === value);
  if (!entry) return String(value);
  const map: Record<string, string> = {
    '¼': '1/4', '½': '1/2', '¾': '3/4', '⅐': '1/7', '⅑': '1/9', '⅒': '1/10',
    '⅓': '1/3', '⅔': '2/3', '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5',
    '⅙': '1/6', '⅚': '5/6', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
  };
  return map[entry[0]] ?? String(value);
}

export interface QuantityMatch {
  qty: number;
  qtyMax: number | null;
  /** Number of characters consumed from the start of the input. */
  length: number;
}

const NUMERIC_TOKEN = String.raw`\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?`;

/**
 * Parse a leading quantity, handling: "2", "2.5", "1/2", "1 1/2", "2-3",
 * "2 to 3", "2~3", and leading word numbers ("a pinch", "two cups").
 * Returns null when the line does not start with a quantity at all
 * ("Salt and pepper to taste").
 */
export function parseQuantity(input: string): QuantityMatch | null {
  const text = expandVulgarFractions(input).trimStart();
  const leadingTrim = input.length - input.trimStart().length;

  const rangePattern = new RegExp(
    String.raw`^(${NUMERIC_TOKEN}(?:\s+\d+\s*\/\s*\d+)?)\s*(?:-|–|—|~|\bto\b|\bor\b)\s*(${NUMERIC_TOKEN}(?:\s+\d+\s*\/\s*\d+)?)`,
    'i',
  );
  const range = rangePattern.exec(text);
  if (range) {
    const low = evaluate(range[1]!);
    const high = evaluate(range[2]!);
    if (low !== null && high !== null) {
      return { qty: low, qtyMax: high, length: range[0].length + leadingTrim };
    }
  }

  const singlePattern = new RegExp(String.raw`^(${NUMERIC_TOKEN}(?:\s+\d+\s*\/\s*\d+)?)`);
  const single = singlePattern.exec(text);
  if (single) {
    const value = evaluate(single[1]!);
    if (value !== null) return { qty: value, qtyMax: null, length: single[0].length + leadingTrim };
  }

  const word = /^([a-z]+)\b/i.exec(text);
  if (word) {
    const value = WORD_NUMBERS[word[1]!.toLowerCase()];
    if (value !== undefined) {
      return { qty: value, qtyMax: null, length: word[0].length + leadingTrim };
    }
  }

  return null;
}

/** Evaluate "1 1/2" -> 1.5, "3/4" -> 0.75, "2,5" -> 2.5. */
function evaluate(token: string): number | null {
  const parts = token.trim().split(/\s+/);
  let total = 0;
  for (const part of parts) {
    if (part.includes('/')) {
      const [numerator, denominator] = part.split('/').map((n) => Number.parseFloat(n.replace(',', '.')));
      if (!numerator || !denominator) return null;
      total += numerator / denominator;
    } else {
      const value = Number.parseFloat(part.replace(',', '.'));
      if (!Number.isFinite(value)) return null;
      total += value;
    }
  }
  return total > 0 ? Number(total.toFixed(4)) : null;
}
