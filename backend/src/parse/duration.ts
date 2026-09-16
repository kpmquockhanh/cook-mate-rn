/** Parse an ISO-8601 duration ("PT1H25M") into seconds. */
export function parseIsoDuration(value: string | undefined | null): number | null {
  if (!value) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value.trim());
  if (!match) return parseHumanDuration(value);
  const [, days, hours, minutes, seconds] = match;
  const total =
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);
  return total > 0 ? Math.round(total) : null;
}

/**
 * Parse human phrasing: "1 hr 25 mins", "20-25 minutes", "1.5 hours".
 * For a range we take the UPPER bound - an undercooked dish is the worse
 * failure mode, and cooking mode lets the user skip a timer early.
 */
export function parseHumanDuration(value: string | undefined | null): number | null {
  if (!value) return null;
  const text = value.toLowerCase();
  let total = 0;

  const pattern = /(\d+(?:[.,]\d+)?)\s*(?:-|–|—|to|or)?\s*(\d+(?:[.,]\d+)?)?\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g;
  for (const match of text.matchAll(pattern)) {
    const low = Number.parseFloat(match[1]!.replace(',', '.'));
    const high = match[2] ? Number.parseFloat(match[2].replace(',', '.')) : null;
    const amount = high ?? low;
    const unit = match[3]!;
    if (/^h/.test(unit)) total += amount * 3600;
    else if (/^m/.test(unit)) total += amount * 60;
    else total += amount;
  }
  return total > 0 ? Math.round(total) : null;
}

/** "Serves 4", "4 servings", "4-6", "makes 12 cookies" -> a number. */
export function parseServings(value: string | undefined | null): number | null {
  if (!value) return null;
  const match = /(\d+)\s*(?:-|–|to)?\s*(\d+)?/.exec(value);
  if (!match) return null;
  const low = Number.parseInt(match[1]!, 10);
  const high = match[2] ? Number.parseInt(match[2], 10) : null;
  const servings = high ? Math.round((low + high) / 2) : low;
  return servings > 0 && servings <= 100 ? servings : null;
}

/** Format seconds the way the app's `cooking_time` field expects ("1h 25m"). */
export function formatCookingTime(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}
