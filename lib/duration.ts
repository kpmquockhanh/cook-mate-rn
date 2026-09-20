// The runtime import is the non-React one, as hooks/useRecipe.ts does: a
// formatter should not drag SettingsContext in behind it.
import { t as activeT } from './i18n/translate';
import type { Translator } from './i18n';

/**
 * A recipe's total time, worded in the language on screen.
 *
 * The API also returns `cooking_time`, but that is a string the scraper
 * already formatted in the recipe's own language ('1h 20m'), and migration
 * 0015 deliberately leaves it out of the translation overlay: a formatted
 * string cannot be reworded, only re-parsed. `total_time_seconds` is a number
 * every locale shares, so the wording is assembled here from the `duration.*`
 * catalogue instead - which is also what step timers already do.
 *
 * Returns null rather than a placeholder when there is no number to format, so
 * a caller can fall back to the scraped string. An English '1h 20m' on a
 * Vietnamese recipe is worse than the same recipe with no time at all only if
 * you have something better to show, and here we do not.
 */
export function formatDuration(
  minutes: number | null | undefined,
  // Components pass their `useTranslation()` translator so a language change
  // re-renders them; callers outside React (cookingContext) take the ambient
  // one, which SettingsProvider keeps in step.
  translate: Translator = activeT
): string | null {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return null;

  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;

  if (hours === 0) return translate('duration.minutes', { count: rest });
  if (rest === 0) return translate('duration.hours', { count: hours });
  // Two units, space-joined: every language in the catalogue writes the larger
  // unit first, so this needs no per-language ordering.
  return `${translate('duration.hours', { count: hours })} ${translate('duration.minutes', { count: rest })}`;
}
