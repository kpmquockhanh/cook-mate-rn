import { one, query } from '../../db.js';
import { ORDER_BY, type ListQuery } from '../schema.js';

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
  'review_count',
  'category',
  'cuisine',
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
  review_count: number;
  category: string | null;
  cuisine: string | null;
  created_at: string;
}

export async function listRecipes(options: ListQuery): Promise<RecipeListRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];

  if (options.search) {
    values.push(options.search);
    // pg_trgm is installed by migration 0001, so a gin_trgm_ops index on title
    // is a cheap upgrade here once the table is big enough to need it.
    where.push(`r.title ilike '%' || $${values.length} || '%'`);
  }
  if (options.category) {
    values.push(options.category);
    where.push(`r.category = $${values.length}`);
  }

  // popular/featured are derived - no column backs either. Both still need a
  // deterministic tiebreak or rows can repeat across pages.
  let orderBy: string;
  if (options.popular) {
    orderBy = 'r.rating desc nulls last, r.review_count desc, r.id';
  } else if (options.featured) {
    orderBy = 'r.quality_score desc nulls last, r.id';
  } else {
    orderBy = `r.${ORDER_BY[options.orderBy]} ${options.order === 'asc' ? 'asc' : 'desc'}, r.id`;
  }

  values.push(options.limit, options.offset);

  return query<RecipeListRow>(
    `select ${LIST_COLUMNS.map((c) => `r.${c}`).join(', ')}
       from public.recipes r
      ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
      order by ${orderBy}
      limit $${values.length - 1} offset $${values.length}`,
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
export async function getRecipe(id: number): Promise<Record<string, unknown> | null> {
  return one(
    `select ${DETAIL_COLUMNS.map((c) => `r.${c}`).join(', ')},
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
    [id],
  );
}
