import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { apiFetch } from './api';
import { logger } from './log';

const log = logger('favorites');

/**
 * Which recipes the signed-in user has saved.
 *
 * The heart used to be decoration - `isFavorite` was read off a column that
 * never existed, and tapping it did nothing. It is now a real row in
 * public.user_favorites (migration 0013), and this context is what makes the
 * same recipe's heart agree with itself across the home rails, the list and the
 * detail screen without any of them refetching.
 *
 * Only overrides live here, not the whole set: a list row arrives from the API
 * already knowing whether it is favourited, so this holds just the ones the
 * user has toggled in this session, which is what the screens would otherwise
 * be out of date about.
 */

interface FavoritesContextValue {
  /** The server's answer, overridden by anything the user has toggled since. */
  isFavorite: (recipeId: string | number, serverValue?: boolean) => boolean;
  toggle: (recipeId: string | number, next: boolean) => Promise<void>;
  /** Bumped on every successful write, for screens that want to refetch. */
  version: number;
}

const FavoritesContext = createContext<FavoritesContextValue | null>(null);

export function FavoritesProvider({ children }: { children: ReactNode }) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [version, setVersion] = useState(0);

  const isFavorite = useCallback(
    (recipeId: string | number, serverValue = false) => overrides[String(recipeId)] ?? serverValue,
    [overrides]
  );

  const toggle = useCallback(async (recipeId: string | number, next: boolean) => {
    const key = String(recipeId);
    // Optimistic: a heart that waits for a round trip feels broken, and the
    // only cost of being wrong is putting it back.
    setOverrides((prev) => ({ ...prev, [key]: next }));

    try {
      // PUT and DELETE rather than a toggle endpoint, so a retry lands on the
      // state the user asked for instead of flipping it twice - which is also
      // what makes it safe to let apiFetch retry a blip.
      await apiFetch(`/recipes/${key}/favorite`, { method: next ? 'PUT' : 'DELETE', retries: 2 });
      setVersion((current) => current + 1);
    } catch (error) {
      log.warn('could not save favourite', String(error));
      setOverrides((prev) => ({ ...prev, [key]: !next }));
    }
  }, []);

  const value = useMemo(() => ({ isFavorite, toggle, version }), [isFavorite, toggle, version]);

  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}

export function useFavorites(): FavoritesContextValue {
  const context = useContext(FavoritesContext);
  if (!context) throw new Error('useFavorites must be used inside a FavoritesProvider');
  return context;
}
