import { z } from 'zod';

/**
 * `orderBy` arrives from the client and lands in an `order by` clause, so it
 * must resolve through this map. Never interpolate the raw value.
 */
export const ORDER_BY = {
  created_at: 'created_at',
  rating: 'rating',
  title: 'title',
  cooking_time: 'cooking_time',
  // Sortable since migration 0012. `ai_score` is the only quality number worth
  // ordering by: the scraped `rating` is 5.00 on most rows, because sites only
  // keep the recipes their readers liked.
  ai_score: 'ai_score',
  total_time_seconds: 'total_time_seconds',
  active_time_seconds: 'active_time_seconds',
} as const;

export type OrderByKey = keyof typeof ORDER_BY;

/** Query strings arrive as 'true'/'false'; an absent flag is false. */
const boolish = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => value === true || value === 'true');

export const MEALS = ['breakfast', 'lunch', 'dinner', 'dessert', 'snack', 'basics'] as const;
export const MAIN_INGREDIENTS = [
  'chicken', 'beef', 'pork', 'seafood', 'pasta', 'egg', 'veg',
] as const;
export const DIETS = ['vegetarian', 'vegan', 'pescatarian', 'gluten_free'] as const;
export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;

/**
 * "Hands-off": long on the clock, short on work. Both halves matter - a
 * 10-minute recipe is not hands-off, it is just quick - so the pair is one flag
 * rather than two thresholds the client has to agree with the server about.
 */
export const HANDS_OFF_MAX_ACTIVE_SECONDS = 20 * 60;
export const HANDS_OFF_MIN_TOTAL_SECONDS = 60 * 60;

export const ListQuery = z.object({
  search: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),

  // Facets, all ANDed. Each one is a column migration 0012 added and
  // publish/facets.ts fills, not something derived from the title at read time.
  meal: z.enum(MEALS).optional(),
  mainIngredient: z.enum(MAIN_INGREDIENTS).optional(),
  diet: z.enum(DIETS).optional(),
  difficulty: z.enum(DIFFICULTIES).optional(),
  cuisine: z.string().trim().min(1).optional(),
  /** Total time ceiling, in minutes: `maxMinutes=30` is the "quick" rail. */
  maxMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  /** Hands-on ceiling, for cooks with a specific amount of attention to spare. */
  maxActiveMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  handsOff: boolish,

  // An unknown sort key falls back instead of 400ing. The app already ships
  // these values, and a list that refuses to load is worse than one sorted the
  // default way.
  orderBy: z
    .string()
    .optional()
    .transform((value): OrderByKey =>
      value && value in ORDER_BY ? (value as OrderByKey) : 'created_at',
    ),
  order: z.enum(['asc', 'desc']).catch('desc'),

  /**
   * Most cooked in the recent past, from the cooking events the app records.
   * This replaced a flag that ordered by the scraped source rating and called
   * the result popular; nothing in that number came from anyone using this app.
   */
  popular: boolish,
  /** Only the caller's own favourites. */
  favorites: boolish,

  // hooks/useRecipes.ts sends a fixed page size and walks `offset` forward, so
  // this is one page, not a running total. It reads `hasMore` off
  // rows.length >= limit, which means the server must never quietly return
  // fewer rows than asked for while more exist.
  limit: z.coerce.number().int().min(1).max(200).catch(20),
  offset: z.coerce.number().int().min(0).catch(0),
});

export type ListQuery = z.infer<typeof ListQuery>;

export const IdParam = z.object({
  // bigserial: big enough to exceed Number.MAX_SAFE_INTEGER in theory, but the
  // app round-trips ids as numbers, so keep it an int and reject junk.
  id: z.coerce.number().int().positive(),
});

/** Cooking events the app reports. See migration 0013. */
export const EVENT_KINDS = ['viewed', 'started', 'completed'] as const;

export const EventBody = z.object({
  kind: z.enum(EVENT_KINDS),
});
