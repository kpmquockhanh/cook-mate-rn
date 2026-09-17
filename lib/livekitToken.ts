import { useCallback, useEffect, useRef, useState } from 'react';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { errorMessage, logger } from './log';

const log = logger('livekit-token');

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

/**
 * supabase-js collapses every non-2xx edge function response into the same
 * "Edge Function returned a non-2xx status code", which is useless in a log and
 * worse on screen. The real reason is in the response body the error carries.
 */
async function describeFunctionError(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    const status = error.context?.status;
    try {
      const body = await error.context.json();
      if (typeof body?.error === 'string') return `${body.error} (HTTP ${status})`;
    } catch {
      // A non-JSON body is not worth failing the error path over.
    }
    return `Voice service returned HTTP ${status ?? 'error'}`;
  }
  return errorMessage(error, 'Could not start the voice assistant');
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

  // A refetch can overtake an in-flight one (a retry tap, a recipe change).
  // Only the newest request is allowed to write state, so a slow failure cannot
  // wipe out the credentials a later call already succeeded in fetching.
  const requestId = useRef(0);

  const fetchToken = useCallback(async () => {
    if (!recipeId) return;

    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    log.info(`Requesting credentials for recipe ${recipeId}`);

    try {
      const { data, error: fnError } = await supabase.functions.invoke<LiveKitCredentials>(
        'livekit-token',
        { body: { recipeId } }
      );

      if (fnError) throw fnError;
      if (!data?.token || !data?.serverUrl) {
        throw new Error('Token endpoint returned an incomplete response');
      }

      if (id !== requestId.current) return;
      log.info(`Got credentials for room ${data.roomName}`, {
        identity: data.identity,
        serverUrl: data.serverUrl,
        expiresInMinutes: Math.round((data.expiresAt - Date.now()) / 60000),
      });
      setCredentials(data);
      setError(null);
    } catch (e) {
      const message = await describeFunctionError(e);
      log.error(`Could not fetch a token for recipe ${recipeId}: ${message}`, e);
      if (id !== requestId.current) return;
      setCredentials(null);
      setError(message);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [recipeId]);

  useEffect(() => {
    setCredentials((current) => (isUsable(current) ? current : null));
    fetchToken();
  }, [fetchToken]);

  // A cooking session can outlive the token. Re-mint it just before it lapses
  // rather than letting the room drop mid-recipe with no explanation.
  useEffect(() => {
    if (!credentials) return;

    const delay = credentials.expiresAt - Date.now() - REFRESH_MARGIN_MS;
    if (delay <= 0) return;

    const timer = setTimeout(() => {
      log.info('Token is close to expiring; refreshing');
      fetchToken();
    }, delay);
    return () => clearTimeout(timer);
  }, [credentials, fetchToken]);

  return { credentials, loading, error, refresh: fetchToken };
}
