import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, ApiError } from './api';
import { errorMessage, logger } from './log';
import { t } from './i18n/translate';

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

/** The API's error text plus the status, which is what a bug report needs. */
function describeTokenError(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (HTTP ${error.status})`;
  return errorMessage(error, t('voice.detailTokenFailed'));
}

export interface UseLiveKitTokenResult {
  credentials: LiveKitCredentials | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Fetches a per-user, per-recipe LiveKit token from the API (`POST /voice/token`).
 * The room and identity are decided server-side from the caller's Clerk session,
 * so two users never land in the same room.
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
      const data = await apiFetch<LiveKitCredentials>('/voice/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipeId }),
      });
      if (!data?.token || !data?.serverUrl) {
        throw new Error(t('voice.detailIncompleteToken'));
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
      const message = describeTokenError(e);
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
