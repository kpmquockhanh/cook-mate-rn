import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

export interface LiveKitCredentials {
  token: string;
  serverUrl: string;
  roomName: string;
  identity: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** Refresh once the token is within this window of expiring. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function isUsable(creds: LiveKitCredentials | null): creds is LiveKitCredentials {
  return !!creds && creds.expiresAt - Date.now() > REFRESH_MARGIN_MS;
}

export interface UseLiveKitTokenResult {
  credentials: LiveKitCredentials | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Fetches a per-user, per-recipe LiveKit token from the `livekit-token` edge
 * function. The room and identity are decided server-side from the caller's
 * Supabase session, so two users never land in the same room.
 */
export function useLiveKitToken(recipeId: string | null): UseLiveKitTokenResult {
  const [credentials, setCredentials] = useState<LiveKitCredentials | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchToken = useCallback(async () => {
    if (!recipeId) return;

    setLoading(true);
    setError(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke<LiveKitCredentials>(
        'livekit-token',
        { body: { recipeId } }
      );

      if (fnError) throw fnError;
      if (!data?.token || !data?.serverUrl) {
        throw new Error('Token endpoint returned an incomplete response');
      }

      setCredentials(data);
    } catch (e) {
      console.error('[LiveKit] Could not fetch a token:', e);
      setCredentials(null);
      setError(e instanceof Error ? e.message : 'Could not start the voice assistant');
    } finally {
      setLoading(false);
    }
  }, [recipeId]);

  useEffect(() => {
    setCredentials((current) => (isUsable(current) ? current : null));
    fetchToken();
  }, [fetchToken]);

  return { credentials, loading, error, refresh: fetchToken };
}
