import { one, query } from '../../db.js';
import {
  HANDS_OFF_MAX_ACTIVE_SECONDS,
  HANDS_OFF_MIN_TOTAL_SECONDS,
  ORDER_BY,
  type ListQuery,
} from '../schema.js';

/**
 * The columns the API exposes. Kept as arrays rather than inline SQL so
 * test/api-contract.test.ts can diff them against src/publish/mapping.ts - the
 * publisher writes these columns and the API reads them, and nothing else
 * connects the two.
 */
export const LIST_COLUMNS = [
  'id',
  'title',
  'thumbnail',
  'cooking_time',
  'difficulty',
  'rating',
  'ai_score',
  'review_count',
  'category',
  'cuisine',
  // Facets (migration 0012). The app filters on these and prints the two
  // times; before them it guessed all of this from the title.
  'total_time_seconds',
  'active_time_seconds',
  'meal',
  'main_ingredient',
  'diet',
  'created_at',
] as const;

export const DETAIL_COLUMNS = [
  ...LIST_COLUMNS,
  'description',
  'servings',
  'source_url',
  'source_name',
  'source_license',
] as const;

export interface RecipeListRow {
  id: number;
  title: string;
  thumbnail: string | null;
  cooking_time: string | null;
  difficulty: string | null;
  rating: number | null;
  ai_score: number | null;
  review_count: number;
  category: string | null;
  cuisine: string | null;
  total_time_seconds: number | null;
  active_time_seconds: number | null;
  meal: string | null;
  main_ingredient: string | null;
  diet: string[];
  created_at: string;
  /** Whether the caller has favourited it. Always present, false when signed out. */
  is_favorite: boolean;
  /** Completed cooks across all users in the popularity window. */
  cook_count: number;
}

/** How far back "popular" looks. Long enough to rank, short enough to move. */
const POPULAR_WINDOW_DAYS = 30;

/**
 * One page of recipes.
 *
 * `userId` is the caller's, and it does two things: it decides `is_favorite`
 * on every row, and it is what `favorites: true` filters by. It is never
 * interpolated - like every value here it goes in as a parameter.
 */
export async function listRecipes(
  options: ListQuery,
  userId: string | null,
): Promise<RecipeListRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];

  /** Appends a value and returns its placeholder, so the two cannot drift. */
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  const user = bind(userId);

  if (options.search) {
    // pg_trgm is installed by migration 0001, so a gin_trgm_ops index on title
    // is a cheap upgrade here once the table is big enough to need it.
    where.push(`r.title ilike '%' || ${bind(options.search)} || '%'`);
  }
  if (options.category) where.push(`r.category = ${bind(options.category)}`);
  if (options.meal) where.push(`r.meal = ${bind(options.meal)}`);
  if (options.mainIngredient) where.push(`r.main_ingredient = ${bind(options.mainIngredient)}`);
  if (options.difficulty) where.push(`r.difficulty = ${bind(options.difficulty)}`);
  if (options.cuisine) where.push(`r.cuisine ilike ${bind(options.cuisine)}`);
  // `diet` is empty when the recipe's ingredients did not all resolve to the
  // canonical dictionary, so an unknown recipe is never returned as safe.
  if (options.diet) where.push(`r.diet @> array[${bind(options.diet)}]::text[]`);

  if (options.maxMinutes !== undefined) {
    where.push(`r.total_time_seconds is not null
                and r.total_time_seconds <= ${bind(options.maxMinutes * 60)}`);
  }
  if (options.maxActiveMinutes !== undefined) {
    where.push(`r.active_time_seconds is not null
                and r.active_time_seconds <= ${bind(options.maxActiveMinutes * 60)}`);
  }
  if (options.handsOff) {
    where.push(`r.active_time_seconds is not null
                and r.active_time_seconds <= ${bind(HANDS_OFF_MAX_ACTIVE_SECONDS)}
                and r.total_time_seconds >= ${bind(HANDS_OFF_MIN_TOTAL_SECONDS)}`);
  }

  if (options.favorites) {
    // An exists() rather than a join: the same row can only be favourited once
    // per user, but this keeps paging honest regardless.
    where.push(`exists (select 1 from public.user_favorites f
                         where f.recipe_id = r.id and f.user_id = ${user}::uuid)`);
  }

  // Ordering. `popular` counts real cooking events; everything else is a
  // column. Both need a deterministic tiebreak or rows repeat across pages.
  let orderBy: string;
  if (options.popular) {
    orderBy = 'cook_count desc, r.ai_score desc nulls last, r.id';
  } else {
    orderBy = `r.${ORDER_BY[options.orderBy]} ${options.order === 'asc' ? 'asc' : 'desc'}, r.id`;
  }

  const limit = bind(options.limit);
  const offset = bind(options.offset);

  return query<RecipeListRow>(
    `select ${LIST_COLUMNS.map((c) => `r.${c}`).join(', ')},
            exists (
              select 1 from public.user_favorites f
               where f.recipe_id = r.id and f.user_id = ${user}::uuid
            ) as is_favorite,
            (
              -- ::int because node-pg hands back a bigint count as a string,
              -- and the app would render that as text on a card.
              select count(*)::int from public.user_recipe_events e
               where e.recipe_id = r.id
                 and e.kind = 'completed'
                 and e.created_at > now() - interval '${POPULAR_WINDOW_DAYS} days'
            ) as cook_count
       from public.recipes r
      ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
      order by ${orderBy}
      limit ${limit} offset ${offset}`,
    values,
  );
}

/**
 * One round trip, not five. Each child set is aggregated in a correlated
 * subquery ordered by sort_order, matching the order publish/run.ts wrote them.
 *
 * `reviews` is a literal empty array: the app renders a reviews section but no
 * table backs it yet, and an empty list is the honest answer.
 */
export async function getRecipe(
  id: number,
  userId: string | null,
): Promise<Record<string, unknown> | null> {
  return one(
    `select ${DETAIL_COLUMNS.map((c) => `r.${c}`).join(', ')},
            exists (
              select 1 from public.user_favorites f
               where f.recipe_id = r.id and f.user_id = $2::uuid
            ) as is_favorite,
            coalesce((
              select json_agg(json_build_object('id', i.id, 'image_path', i.image_path)
                              order by i.sort_order, i.id)
                from public.recipe_images i where i.recipe_id = r.id
            ), '[]'::json) as images,
            coalesce((
              select json_agg(json_build_object(
                       'id', g.id, 'ingredient_text', g.ingredient_text, 'amount', g.amount)
                              order by g.sort_order, g.id)
                from public.recipe_ingredients g where g.recipe_id = r.id
            ), '[]'::json) as ingredients,
            coalesce((
              select json_agg(json_build_object(
                       'id', s.id, 'instruction_text', s.instruction_text,
                       'ingredients', s.ingredients, 'duration', s.duration,
                       'timer_name', s.timer_name)
                              order by s.sort_order, s.id)
                from public.recipe_instructions s where s.recipe_id = r.id
            ), '[]'::json) as instructions,
            coalesce((
              select json_agg(json_build_object('id', n.id, 'note_text', n.note_text)
                              order by n.sort_order, n.id)
                from public.recipe_notes n where n.recipe_id = r.id
            ), '[]'::json) as notes,
            '[]'::json as reviews
       from public.recipes r
      where r.id = $1`,
    [id, userId],
  );
}

// --- Per-user writes --------------------------------------------------------

/** Idempotent: favouriting twice is one row, and the second call is a no-op. */
export async function addFavorite(userId: string, recipeId: number): Promise<void> {
  await query(
    `insert into public.user_favorites (user_id, recipe_id)
     values ($1::uuid, $2)
     on conflict (user_id, recipe_id) do nothing`,
    [userId, recipeId],
  );
}

export async function removeFavorite(userId: string, recipeId: number): Promise<void> {
  await query(
    `delete from public.user_favorites where user_id = $1::uuid and recipe_id = $2`,
    [userId, recipeId],
  );
}

/**
 * Append-only. The app reports these as they happen, so this is the hot write
 * path of the whole API - one insert, no read, no uniqueness to check.
 */
export async function recordEvent(
  userId: string,
  recipeId: number,
  kind: string,
): Promise<void> {
  await query(
    `insert into public.user_recipe_events (user_id, recipe_id, kind)
     values ($1::uuid, $2, $3)`,
    [userId, recipeId, kind],
  );
}
