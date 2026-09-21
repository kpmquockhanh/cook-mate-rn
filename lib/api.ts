import { supabase } from './supabase';
import { env } from './env';
import { t } from './i18n/translate';
import { isOnline, reportReachable, reportUnreachable } from './connectivity';

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
 * The request never got an HTTP answer: no network, the server is down, or it
 * took longer than REQUEST_TIMEOUT_MS. Kept apart from ApiError because the
 * right response is different - wait for the connection, not show a failure.
 */
export class ConnectionError extends Error {
  constructor(
    readonly kind: 'offline' | 'timeout',
    message: string
  ) {
    super(message);
    this.name = 'ConnectionError';
  }
}

/**
 * Gateway statuses: a proxy answered, but the API behind it did not. These
 * mean "server outage" to the user just as much as a refused connection does.
 */
const OUTAGE_STATUSES = new Set([502, 503, 504]);

/**
 * True for failures that are about reaching the server rather than about the
 * request itself - the ones worth keeping stale data on screen for and
 * retrying once the connection is back.
 */
export function isConnectionError(error: unknown): boolean {
  return (
    error instanceof ConnectionError ||
    (error instanceof ApiError && OUTAGE_STATUSES.has(error.status))
  );
}

const REQUEST_TIMEOUT_MS = 15_000;
/** Waits before each retry of an idempotent request; its length is the retry count. */
const RETRY_DELAYS_MS = [600, 1_800];

export interface ApiFetchInit extends RequestInit {
  /**
   * How many times to retry after a connection failure or gateway error.
   * Defaults to RETRY_DELAYS_MS.length for GET and 0 for everything else - a
   * write is only safe to repeat when the caller knows it is idempotent (a PUT
   * or DELETE that sets state, say), so it has to opt in.
   */
  retries?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * getSession() refreshes on its own when the stored token is past expiry, so
 * this is normally the only token call needed. It reads from AsyncStorage, so
 * it is async even when nothing is refreshed.
 */
async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * One fetch, with the token attached and a timeout, telling the connectivity
 * store whenever the API does answer. A transport failure
 * becomes a ConnectionError; a caller's own abort is rethrown as-is.
 */
async function request(path: string, init: RequestInit, token: string | null): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const callerSignal = init.signal;
  const forwardAbort = () => controller.abort();
  if (callerSignal?.aborted) controller.abort();
  callerSignal?.addEventListener('abort', forwardAbort);

  try {
    const response = await fetch(`${env.apiUrl}${path.startsWith('/') ? path : `/${path}`}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    // A gateway error is reported by apiFetch once its retries run out, so a
    // single bad response does not flash the outage banner.
    if (!OUTAGE_STATUSES.has(response.status)) reportReachable();
    return response;
  } catch (error) {
    if (callerSignal?.aborted) throw error;
    throw timedOut
      ? new ConnectionError('timeout', t('error.timeout'))
      : new ConnectionError('offline', t('error.connection'));
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardAbort);
  }
}

/**
 * Fetches an API path with the caller's session attached and the JSON body
 * unwrapped from the `{ data }` envelope the API returns.
 *
 * A 401 is retried exactly once against a force-refreshed session: a token can
 * expire in the gap between reading it and the server verifying it, and the
 * alternative is a spurious error screen on a session that is perfectly valid.
 *
 * Connection failures and gateway errors are retried with a short backoff
 * (see ApiFetchInit.retries), which rides out a blip. A real outage is not
 * retried here: once the connectivity store knows the API is down, requests
 * fail fast and screens reload through `onReconnect` instead.
 */
export async function apiFetch<T = unknown>(path: string, init: ApiFetchInit = {}): Promise<T> {
  const { retries, ...rest } = init;
  const method = (rest.method ?? 'GET').toUpperCase();
  // Retrying is for a blip. If the store already has the API down as an
  // outage, fail at once - the probe loop is already on it.
  const maxRetries = !isOnline() ? 0 : (retries ?? (method === 'GET' ? RETRY_DELAYS_MS.length : 0));

  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptFetch<T>(path, rest);
    } catch (error) {
      if (!isConnectionError(error) || rest.signal?.aborted) throw error;
      if (attempt >= maxRetries || !isOnline()) {
        reportUnreachable(error instanceof ConnectionError ? 'offline' : 'server-down');
        throw error;
      }
      await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
    }
  }
}

async function attemptFetch<T>(path: string, init: RequestInit): Promise<T> {
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
  // Whatever a gateway put in the body is not written for the user.
  if (OUTAGE_STATUSES.has(response.status)) message = t('error.serverDown');
  return new ApiError(response.status, message, reason);
}
