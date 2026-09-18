import { useCallback, useEffect, useRef, useState } from 'react';
// REST API via EXPO_PUBLIC_API_URL. apiFetch attaches the caller's Supabase
// access token - the API rejects an unauthenticated read with a 401.
import { apiFetch } from '../lib/api';
import { t } from '../lib/i18n/translate';

export interface RecipeListItem {
  id: string | number;
  title: string;
  time?: string;
  difficulty?: string;
  rating?: number;
  /** AI-generated 0-10 quality score from enrichment, distinct from `rating`. */
  aiScore?: number;
  image?: string;
  isFavorite?: boolean;
  /** Facets the publisher derives (migration 0012), not guesses from the title. */
  meal?: string;
  mainIngredient?: string;
  diet?: string[];
  totalMinutes?: number;
  /** Hands-on minutes: the total minus every unattended stretch. */
  activeMinutes?: number;
  /** Completed cooks in the last 30 days, across everyone. */
  cookCount?: number;
  // Allow additional fields without forcing any
  [key: string]: unknown;
}

export type Meal = 'breakfast' | 'lunch' | 'dinner' | 'dessert' | 'snack' | 'basics';
export type MainIngredient =
  | 'chicken' | 'beef' | 'pork' | 'seafood' | 'pasta' | 'egg' | 'veg';
export type Diet = 'vegetarian' | 'vegan' | 'pescatarian' | 'gluten_free';
export type Difficulty = 'easy' | 'medium' | 'hard';

export interface UseRecipesOptions {
  search?: string;
  /** Page size. loadMore() fetches the next `limit` rows, it does not grow this. */
  limit?: number;
  orderBy?: string;
  order?: 'asc' | 'desc';
  category?: string;

  // Facets. Every one of these is a column the API filters on directly - the
  // app no longer fetches a page and sifts it (see lib/recipeFacets.ts).
  meal?: Meal;
  mainIngredient?: MainIngredient;
  diet?: Diet;
  difficulty?: Difficulty;
  cuisine?: string;
  /** Total-time ceiling in minutes. */
  maxMinutes?: number;
  /** Hands-on ceiling in minutes. */
  maxActiveMinutes?: number;
  /** Long on the clock, short on work. The server owns both thresholds. */
  handsOff?: boolean;

  /** Most completed cooks in the last 30 days. Real usage, not a scraped rating. */
  popular?: boolean;
  /** Only what the signed-in user has favourited. */
  favorites?: boolean;
}

export interface UseRecipesResult<TItem = RecipeListItem> {
  data: TItem[];
  /** A first page is in flight (initial load, option change, or refetch). */
  loading: boolean;
  /** A loadMore() page is in flight. Never true at the same time as `loading`. */
  loadingMore: boolean;
  error: string | null;
  /** Reloads the first page, discarding pages already appended. */
  refetch: () => Promise<void>;
  /** Appends the next page. A no-op while a request is in flight or at the end. */
  loadMore: () => void;
  hasMore: boolean;
}

const DEFAULT_LIMIT = 20;

/** Seconds on the wire, minutes on screen - nothing displays seconds. */
function minutes(seconds: unknown): number | undefined {
  return typeof seconds === 'number' ? Math.round(seconds / 60) : undefined;
}

function mapDbRowToRecipe(row: any): RecipeListItem {
  return {
    ...row,
    id: row.id,
    title: row.title,
    time: row.time ?? row.cooking_time ?? undefined,
    difficulty: row.difficulty ?? undefined,
    rating: typeof row.rating === 'number' ? row.rating : undefined,
    aiScore: typeof row.ai_score === 'number' ? row.ai_score : undefined,
    image: row.image ?? row.image_url ?? undefined,
    isFavorite: row.is_favorite ?? row.isFavorite ?? false,
    meal: row.meal ?? undefined,
    mainIngredient: row.main_ingredient ?? undefined,
    diet: Array.isArray(row.diet) ? row.diet : [],
    totalMinutes: minutes(row.total_time_seconds),
    activeMinutes: minutes(row.active_time_seconds),
    cookCount: typeof row.cook_count === 'number' ? row.cook_count : 0,
  } as RecipeListItem;
}

/** The options with every default filled in - what one request is made of. */
interface Query {
  search: string;
  category: string;
  meal: string;
  mainIngredient: string;
  diet: string;
  difficulty: string;
  cuisine: string;
  maxMinutes: number;
  maxActiveMinutes: number;
  handsOff: boolean;
  popular: boolean;
  favorites: boolean;
  orderBy: string;
  order: 'asc' | 'desc';
  limit: number;
}

// Absent facets are '' / 0 rather than undefined so the serialized key below
// is stable: JSON.stringify drops undefined values, and two option objects
// that differ only in which keys are present would otherwise share a key.
function normalize(options?: UseRecipesOptions): Query {
  return {
    search: options?.search?.trim() ?? '',
    category: options?.category?.trim() ?? '',
    meal: options?.meal ?? '',
    mainIngredient: options?.mainIngredient ?? '',
    diet: options?.diet ?? '',
    difficulty: options?.difficulty ?? '',
    cuisine: options?.cuisine?.trim() ?? '',
    maxMinutes: options?.maxMinutes ?? 0,
    maxActiveMinutes: options?.maxActiveMinutes ?? 0,
    handsOff: options?.handsOff === true,
    popular: options?.popular === true,
    favorites: options?.favorites === true,
    orderBy: options?.orderBy ?? 'created_at',
    order: options?.order === 'asc' ? 'asc' : 'desc',
    limit: options?.limit ?? DEFAULT_LIMIT,
  };
}

function buildPath(query: Query, offset: number): string {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.category) params.set('category', query.category);
  if (query.meal) params.set('meal', query.meal);
  if (query.mainIngredient) params.set('mainIngredient', query.mainIngredient);
  if (query.diet) params.set('diet', query.diet);
  if (query.difficulty) params.set('difficulty', query.difficulty);
  if (query.cuisine) params.set('cuisine', query.cuisine);
  if (query.maxMinutes > 0) params.set('maxMinutes', String(query.maxMinutes));
  if (query.maxActiveMinutes > 0) {
    params.set('maxActiveMinutes', String(query.maxActiveMinutes));
  }
  if (query.handsOff) params.set('handsOff', 'true');
  if (query.popular) params.set('popular', 'true');
  if (query.favorites) params.set('favorites', 'true');
  params.set('orderBy', query.orderBy);
  params.set('order', query.order);
  params.set('limit', String(query.limit));
  if (offset > 0) params.set('offset', String(offset));
  return `/recipes?${params.toString()}`;
}

/**
 * Lists recipes, one page at a time.
 *
 * The first page is fetched on mount and again whenever any option value
 * changes - screens just render their filter state into the options and let
 * this hook follow. `loadMore()` appends the next page by offset; the server
 * orders every list with an id tiebreak, so pages do not overlap.
 */
export function useRecipes<TItem = RecipeListItem>(
  options?: UseRecipesOptions
): UseRecipesResult<TItem> {
  const [data, setData] = useState<TItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(true);

  // Callers pass options straight from render state (a search box, a category
  // chip), so the object identity changes every render. Everything below keys
  // off this serialized form, which changes only when a value actually does -
  // and a request is rebuilt from it, so the two can never drift apart.
  const key = JSON.stringify(normalize(options));

  const mountedRef = useRef<boolean>(true);
  // Rows the server has already handed over for this query - the offset of the
  // next page. Counts rows received, not rows kept, so de-duplicating a page
  // can never make the next one re-read rows we already skipped past.
  const offsetRef = useRef<number>(0);
  // Only the newest request may write state; a slower earlier one is dropped.
  const requestIdRef = useRef<number>(0);
  const inFlightRef = useRef<boolean>(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (append: boolean): Promise<void> => {
    const query: Query = JSON.parse(key);
    const limit = query.limit;
    const requestId = ++requestIdRef.current;

    inFlightRef.current = true;
    if (append) {
      setLoadingMore(true);
    } else {
      // A fresh first page: forget where the last one had got to, and let
      // loadMore() run again even if the previous query had reached its end.
      offsetRef.current = 0;
      setLoading(true);
      setHasMore(true);
    }
    setError(null);
    const offset = offsetRef.current;

    try {
      const payload = await apiFetch<unknown>(buildPath(query, offset), { method: 'GET' });
      const rows = Array.isArray(payload) ? payload : [];
      const mapped = rows.map(mapDbRowToRecipe) as unknown as TItem[];

      if (!mountedRef.current || requestId !== requestIdRef.current) return;

      offsetRef.current = offset + mapped.length;
      setHasMore(mapped.length >= limit);

      if (append) {
        setData((prev) => {
          const seen = new Set(prev.map((item) => (item as any).id));
          return [...prev, ...mapped.filter((item) => !seen.has((item as any).id))];
        });
      } else {
        setData(mapped);
      }
    } catch (err: any) {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setError(err?.message ?? t('error.recipesFetch'));
      // Leave the rows already on screen alone on a failed loadMore - dropping
      // them would turn a dead page into an empty list.
      if (!append) {
        setData([]);
        setHasMore(false);
      }
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        inFlightRef.current = false;
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [key]);

  // Mount, and then any change to the query: start over at the first page.
  useEffect(() => {
    // react-hooks/set-state-in-effect sees the spinner flags `load` raises
    // before it awaits; fetching on mount is exactly what an effect is for, and
    // raising them a microtask later would only add a frame with no spinner.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(false);
  }, [load]);

  const refetch = useCallback(async (): Promise<void> => {
    await load(false);
  }, [load]);

  const loadMore = useCallback((): void => {
    if (inFlightRef.current || !hasMore) return;
    load(true);
  }, [hasMore, load]);

  return {
    data,
    loading,
    loadingMore,
    error,
    refetch,
    loadMore,
    hasMore,
  };
}

export default useRecipes;
