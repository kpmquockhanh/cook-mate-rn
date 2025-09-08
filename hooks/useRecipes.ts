import { useCallback, useEffect, useRef, useState } from 'react';
// Removed Supabase dependency in favor of REST API via EXPO_PUBLIC_API_URL

export interface RecipeListItem {
  id: string | number;
  title: string;
  time?: string;
  difficulty?: string;
  rating?: number;
  image?: string;
  isFavorite?: boolean;
  // Allow additional fields without forcing any
  [key: string]: unknown;
}

export interface UseRecipesOptions {
  search?: string;
  limit?: number;
  orderBy?: string;
  order?: 'asc' | 'desc';
  category?: string;
  featured?: boolean;
  popular?: boolean;
  append?: boolean; // New option for pagination
}

export interface UseRecipesResult<TItem = RecipeListItem> {
  data: TItem[];
  loading: boolean;
  error: string | null;
  refetch: (overrideOptions?: Partial<UseRecipesOptions>) => Promise<void>;
  hasMore: boolean; // New property to indicate if more data is available
}

function mapDbRowToRecipe(row: any): RecipeListItem {
  return {
    id: row.id,
    title: row.title,
    time: row.time ?? row.cooking_time ?? undefined,
    difficulty: row.difficulty ?? undefined,
    rating: typeof row.rating === 'number' ? row.rating : undefined,
    image: row.image ?? row.image_url ?? undefined,
    isFavorite: row.is_favorite ?? row.isFavorite ?? false,
    ...row,
  } as RecipeListItem;
}

export function useRecipes<TItem = RecipeListItem>(options?: UseRecipesOptions): UseRecipesResult<TItem> {
  const defaulted: Required<Pick<UseRecipesOptions, 'limit' | 'orderBy' | 'order' | 'append'>> & Omit<UseRecipesOptions, 'limit' | 'orderBy' | 'order' | 'append'> = {
    limit: 20,
    orderBy: 'created_at',
    order: 'desc',
    append: false,
    ...(options || {}),
  } as any;

  const [data, setData] = useState<TItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [currentOptions, setCurrentOptions] = useState<UseRecipesOptions>(defaulted);
  const mountedRef = useRef<boolean>(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchRecipes = useCallback(async (overrideOptions?: Partial<UseRecipesOptions>) => {
    setLoading(true);
    setError(null);
    
    try {
      const apiBase = process.env.EXPO_PUBLIC_API_URL;
      if (!apiBase) {
        throw new Error('Missing EXPO_PUBLIC_API_URL');
      }

      const effective: UseRecipesOptions = {
        ...currentOptions,
        ...(overrideOptions || {}),
      };

      if (overrideOptions && Object.keys(overrideOptions).length > 0) {
        setCurrentOptions(effective);
      }

      const params = new URLSearchParams();
      if (typeof effective.search === 'string' && effective.search.trim().length > 0) params.set('search', effective.search.trim());
      if (typeof effective.category === 'string' && effective.category.trim().length > 0) params.set('category', effective.category.trim());
      if (effective.featured === true) params.set('featured', 'true');
      if (effective.popular === true) params.set('popular', 'true');
      if (effective.orderBy) params.set('orderBy', effective.orderBy);
      if (effective.order) params.set('order', effective.order);
      if (typeof effective.limit === 'number') params.set('limit', String(effective.limit));

      const url = `${apiBase.replace(/\/$/, '')}/recipes${params.toString() ? `?${params.toString()}` : ''}`;

      const response = await fetch(url, { method: 'GET' });
      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }
      const json = await response.json();
      const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];

      const mapped = (rows ?? []).map(mapDbRowToRecipe) as unknown as TItem[];
      
      if (mountedRef.current) {
        if (effective.append && !overrideOptions?.search) {
          // For pagination, append new data and remove duplicates
          setData(prevData => {
            const existingIds = new Set(prevData.map(item => (item as any).id));
            const newItems = mapped.filter(item => !existingIds.has((item as any).id));
            return [...prevData, ...newItems];
          });
        } else {
          // For new searches or initial load, replace data
          setData(mapped);
        }
        
        // Check if we have more data available
        setHasMore(mapped.length >= (effective.limit || 20));
      }
    } catch (err: any) {
      if (mountedRef.current) {
        setError(err?.message ?? 'Failed to fetch recipes');
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [currentOptions]);

  useEffect(() => {
    // initial fetch
    fetchRecipes();
  }, []);

  return {
    data,
    loading,
    error,
    refetch: fetchRecipes,
    hasMore,
  };
}

export default useRecipes;


