import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

/**
 * The last recipe the user was cooking, so the home screen can offer to put
 * them back where they left off.
 *
 * Local-only and deliberately so: this is the state of one kitchen session on
 * one phone, and a round trip would make the home screen wait on the network
 * for the one row it most wants to render instantly. When Phase 4 adds
 * `user_recipe_events`, that table records the history for recommendations -
 * this stays the fast path for "carry on".
 */

const STORAGE_KEY = 'cookmate:lastCooking';

/**
 * A session older than this is not something to resume - it is yesterday's
 * dinner, and offering to rejoin it at step 4 would be worse than offering
 * nothing.
 */
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

export interface RecentCooking {
  id: string;
  title: string;
  thumbnail: string;
  /** 1-based, matching what the cooking screen shows. */
  step: number;
  totalSteps: number;
  /** Epoch ms, used only to expire the entry. */
  updatedAt: number;
}

function isFresh(entry: RecentCooking): boolean {
  return Date.now() - entry.updatedAt < STALE_AFTER_MS;
}

/** Overwrites the single stored session. Never throws: this is a nicety. */
export async function saveRecentCooking(entry: Omit<RecentCooking, 'updatedAt'>): Promise<void> {
  try {
    const payload: RecentCooking = { ...entry, updatedAt: Date.now() };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Losing the resume point costs the user one tap; failing the cooking
    // screen over it would cost them the recipe.
  }
}

export async function clearRecentCooking(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // As above.
  }
}

export async function readRecentCooking(): Promise<RecentCooking | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RecentCooking;
    if (!parsed?.id || typeof parsed.step !== 'number') return null;
    return isFresh(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reads the stored session, and re-reads it every time the screen regains
 * focus - the user leaves home, cooks four steps, and comes back to a card
 * that has to already say "step 5".
 */
export function useRecentCooking(): {
  entry: RecentCooking | null;
  dismiss: () => void;
} {
  const [entry, setEntry] = useState<RecentCooking | null>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      readRecentCooking().then((stored) => {
        if (active) setEntry(stored);
      });
      return () => {
        active = false;
      };
    }, [])
  );

  const dismiss = useCallback(() => {
    setEntry(null);
    clearRecentCooking();
  }, []);

  return { entry, dismiss };
}
