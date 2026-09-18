import type { Meal } from './recipeFacets';
import type { TranslationKey } from './i18n/en';

/**
 * What time it is, in the only terms a cook cares about.
 *
 * The home screen leads with the meal the user is most likely about to make,
 * so at 6pm the first rail is dinner and at 7am it is breakfast. With a
 * catalogue this small that single swap does more for "there is something here
 * for me" than any ranking would.
 */
export type Daypart = 'morning' | 'midday' | 'afternoon' | 'evening' | 'night';

export function currentDaypart(now: Date = new Date()): Daypart {
  const hour = now.getHours();
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 15) return 'midday';
  if (hour >= 15 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

/** The meal to lead with. */
export const MEAL_FOR_DAYPART: Record<Daypart, Meal> = {
  morning: 'breakfast',
  midday: 'lunch',
  afternoon: 'snack',
  evening: 'dinner',
  night: 'dessert',
};

/** "Good morning" and friends. The header used to say morning at midnight. */
export const GREETING_KEY_FOR_DAYPART: Record<Daypart, TranslationKey> = {
  morning: 'home.greetingMorning',
  midday: 'home.greetingAfternoon',
  afternoon: 'home.greetingAfternoon',
  evening: 'home.greetingEvening',
  night: 'home.greetingNight',
};

/** The heading over the leading rail: "Dinner tonight", "Breakfast ideas". */
export const HERO_TITLE_KEY_FOR_DAYPART: Record<Daypart, TranslationKey> = {
  morning: 'home.heroBreakfast',
  midday: 'home.heroLunch',
  afternoon: 'home.heroSnack',
  evening: 'home.heroDinner',
  night: 'home.heroDessert',
};
