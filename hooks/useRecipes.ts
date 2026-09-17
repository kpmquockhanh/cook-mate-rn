import { useCallback, useEffect, useRef, useState } from 'react';
// REST API via EXPO_PUBLIC_API_URL. apiFetch attaches the caller's Supabase
// access token - the API rejects an unauthenticated read with a 401.
import { apiFetch } from '../lib/api';

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
  // Allow additional fields without forcing any
  [key: string]: unknown;
}

export interface UseRecipesOptions {
  search?: string;
  /** Page size. loadMore() fetches the next `limit` rows, it does not grow this. */
  limit?: number;
  orderBy?: string;
  order?: 'asc' | 'desc';
  category?: string;
  featured?: boolean;
  popular?: boolean;
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

function mapDbRowToRecipe(row: any): RecipeListItem {
  return {
    id: row.id,
    title: row.title,
    time: row.time ?? row.cooking_time ?? undefined,
    difficulty: row.difficulty ?? undefined,
    rating: typeof row.rating === 'number' ? row.rating : undefined,
    aiScore: typeof row.ai_score === 'number' ? row.ai_score : undefined,
    image: row.image ?? row.image_url ?? undefined,
    isFavorite: row.is_favorite ?? row.isFavorite ?? false,
    ...row,
  } as RecipeListItem;
}

/** The options with every default filled in - what one request is made of. */
interface Query {
  search: string;
  category: string;
  featured: boolean;
  popular: boolean;
  orderBy: string;
  order: 'asc' | 'desc';
  limit: number;
}

function normalize(options?: UseRecipesOptions): Query {
  return {
    search: options?.search?.trim() ?? '',
    category: options?.category?.trim() ?? '',
    featured: options?.featured === true,
    popular: options?.popular === true,
    orderBy: options?.orderBy ?? 'created_at',
    order: options?.order === 'asc' ? 'asc' : 'desc',
    limit: options?.limit ?? DEFAULT_LIMIT,
  };
}

function buildPath(query: Query, offset: number): string {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.category) params.set('category', query.category);
  if (query.featured) params.set('featured', 'true');
  if (query.popular) params.set('popular', 'true');
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
      setError(err?.message ?? 'Failed to fetch recipes');
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
