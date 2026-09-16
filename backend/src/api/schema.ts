import { z } from 'zod';

/**
 * `orderBy` arrives from the client (hooks/useRecipes.ts sends 'created_at')
 * and lands in an `order by` clause, so it must resolve through this map.
 * Never interpolate the raw value.
 */
export const ORDER_BY = {
  created_at: 'created_at',
  rating: 'rating',
  title: 'title',
  cooking_time: 'cooking_time',
} as const;

export type OrderByKey = keyof typeof ORDER_BY;

/** Query strings arrive as 'true'/'false'; an absent flag is false. */
const boolish = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => value === true || value === 'true');

export const ListQuery = z.object({
  search: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  featured: boolish,
  popular: boolish,

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

  // app/(tabs)/all-recipes.tsx requests ITEMS_PER_PAGE * page, so this climbs
  // as the user scrolls. The cap has to stay above what that reaches or
  // `hasMore` (rows.length >= limit) goes false mid-list and paging stops.
  limit: z.coerce.number().int().min(1).max(200).catch(20),
  offset: z.coerce.number().int().min(0).catch(0),
});

export type ListQuery = z.infer<typeof ListQuery>;

export const IdParam = z.object({
  // bigserial: big enough to exceed Number.MAX_SAFE_INTEGER in theory, but the
  // app round-trips ids as numbers, so keep it an int and reject junk.
  id: z.coerce.number().int().positive(),
});
