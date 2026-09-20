import { supabase } from './supabase';
import { env } from './env';
import { t } from './i18n/translate';

/**
 * The single way the app talks to the REST API (backend/src/api).
 *
 * Every route there except /health is behind a Supabase access token now, so a
 * bare `fetch` to EXPO_PUBLIC_API_URL gets a 401. Going through here keeps the
 * token attachment and the refresh-and-retry in one place instead of copied
 * into each hook.
 */

/** Thrown for any non-2xx response, so callers can branch on the status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The API's `reason` on a 401: 'missing_token' | 'invalid_token' | 'token_expired'. */
    readonly reason?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * getSession() refreshes on its own when the stored token is past expiry, so
 * this is normally the only token call needed. It reads from AsyncStorage, so
 * it is async even when nothing is refreshed.
 */
async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function request(path: string, init: RequestInit, token: string | null): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  return fetch(`${env.apiUrl}${path.startsWith('/') ? path : `/${path}`}`, { ...init, headers });
}

/**
 * Fetches an API path with the caller's session attached and the JSON body
 * unwrapped from the `{ data }` envelope the API returns.
 *
 * A 401 is retried exactly once against a force-refreshed session: a token can
 * expire in the gap between reading it and the server verifying it, and the
 * alternative is a spurious error screen on a session that is perfectly valid.
 */
export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  let response = await request(path, init, await accessToken());

  if (response.status === 401) {
    const { data, error } = await supabase.auth.refreshSession();
    // No refresh token, or the server rejected it: the session is genuinely
    // gone. Surface it rather than looping - AuthContext's onAuthStateChange
    // is what routes the user back to sign-in.
    if (error || !data.session) {
      throw await apiError(response);
    }
    response = await request(path, init, data.session.access_token);
  }

  if (!response.ok) throw await apiError(response);

  // A 204 has no body at all (the events endpoint answers that way), and
  // response.json() on an empty body throws a SyntaxError that would read as a
  // failed request for something that in fact succeeded.
  if (response.status === 204) return undefined as T;

  const json = await response.json();
  // The API wraps rows as { data: ... }; tolerate a bare body so a route that
  // does not wrap still works.
  return (json?.data ?? json) as T;
}

async function apiError(response: Response): Promise<ApiError> {
  let reason: string | undefined;
  // The user reads this one, so it is translated; `body.error` from the API
  // is not, because only the server knows what it says.
  let message = t('error.requestFailed', { status: response.status });
  try {
    const body = await response.json();
    if (typeof body?.reason === 'string') reason = body.reason;
    if (typeof body?.error === 'string') message = body.error;
  } catch {
    // A non-JSON error body (a proxy's HTML 502, say) is not worth failing on.
  }
  if (response.status === 401) message = t('error.signInAgain');
  return new ApiError(response.status, message, reason);
}
