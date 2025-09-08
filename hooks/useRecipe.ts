import { useCallback, useEffect, useRef, useState } from 'react';

export interface RecipeDetail {
  id: string | number;
  title: string;
  thumbnail: string;
  images?: Image[]; // Array of additional images
  cookingTime: string;
  servings: number;
  rating: number;
  reviewCount: number;
  isFavorite: boolean;
  ingredients: Ingredient[];
  reviews: Review[];
  instructions: Instruction[];
  notes: Note[];
  // Allow additional fields without forcing any
  [key: string]: unknown;
}

export interface Image {
  id: string;
  image_path: string;
}

export interface Note {
  id: string;
  note_text: string;
}

export interface Ingredient {
  id: string;
  ingredient_text: string;
  amount: string;
  checked: boolean;
}

export interface Instruction {
  id: string;
  instruction_text: string;
  ingredients: string[];
  duration?: number; // in seconds
  timerName?: string;
}

export interface Review {
  id: string;
  user: string;
  rating: number;
  comment: string;
}

export interface UseRecipeOptions {
  id: string | number;
}

export interface UseRecipeResult {
  data: RecipeDetail | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

function mapDbRowToRecipeDetail(row: any): RecipeDetail {
  return {
    id: row.id,
    title: row.title,
    thumbnail: row.thumbnail ?? row.image ?? row.image_url ?? '',
    images: Array.isArray(row.images) ? row.images.map((image: any) => ({
      id: image.id ?? String(Math.random()),
      image_path: image.image_path ?? image.image ?? image.image_url ?? '',
    })) : [],
    cookingTime: row.cooking_time ?? row.time ?? '30m',
    servings: row.servings ?? 4,
    rating: typeof row.rating === 'number' ? row.rating : 0,
    reviewCount: row.review_count ?? row.reviewCount ?? 0,
    isFavorite: row.is_favorite ?? row.isFavorite ?? false,
    ingredients: Array.isArray(row.ingredients) ? row.ingredients.map((ing: any, index: number) => ({
      id: ing.id ?? String(index + 1),
      name: ing.name ?? ing.ingredient ?? '',
      amount: ing.amount ?? ing.quantity ?? '',
      checked: false,
    })) : [],
    directions: Array.isArray(row.directions) ? row.directions : [],
    cookingSteps: Array.isArray(row.cooking_steps) ? row.cooking_steps.map((step: any, index: number) => ({
      id: step.id ?? `step-${index + 1}`,
      instruction: step.instruction ?? step.step ?? '',
      ingredients: Array.isArray(step.ingredients) ? step.ingredients : [],
      duration: step.duration,
      timerName: step.timer_name ?? step.timerName,
    })) : [],
    reviews: Array.isArray(row.reviews) ? row.reviews.map((review: any) => ({
      id: review.id ?? String(Math.random()),
      user: review.user ?? review.username ?? 'Anonymous',
      rating: typeof review.rating === 'number' ? review.rating : 5,
      comment: review.comment ?? review.text ?? '',
    })) : [],
    notes: Array.isArray(row.notes) ? row.notes.map((note: any) => ({
      id: note.id ?? String(Math.random()),
      note_text: note.note_text ?? note.note ?? '',
    })) : [],
    ...row,
  } as RecipeDetail;
}

export function useRecipe(options: UseRecipeOptions): UseRecipeResult {
  const { id } = options;
  
  const [data, setData] = useState<RecipeDetail | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef<boolean>(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchRecipe = useCallback(async () => {
    if (!id) {
      setError('Recipe ID is required');
      return;
    }

    setLoading(true);
    setError(null);
    
    try {
      const apiBase = process.env.EXPO_PUBLIC_API_URL;
      if (!apiBase) {
        throw new Error('Missing EXPO_PUBLIC_API_URL');
      }

      const url = `${apiBase.replace(/\/$/, '')}/recipes/${id}`;
      const response = await fetch(url, { method: 'GET' });

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Recipe not found');
        }
        throw new Error(`Request failed: ${response.status}`);
      }
      
      const json = await response.json();
      const recipeData = json?.data ?? json;
      if (!recipeData) {
        throw new Error('Invalid recipe data received');
      }

      const mapped = mapDbRowToRecipeDetail(recipeData);
      
      if (mountedRef.current) {
        setData(mapped);
      }
    } catch (err: any) {
      if (mountedRef.current) {
        setError(err?.message ?? 'Failed to fetch recipe');
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [id]);

  useEffect(() => {
    // Fetch recipe when id changes
    if (id) {
      fetchRecipe();
    }
  }, [id]);

  return {
    data,
    loading,
    error,
    refetch: fetchRecipe,
  };
}

export default useRecipe;
