/**
 * The bridge between Clerk (React hooks) and apiFetch (plain functions).
 * AuthContext registers Clerk's getToken here; apiFetch reads through it. Kept
 * free of React and react-native so the retry rule is unit-testable.
 */
export type TokenGetter = (options?: { skipCache?: boolean }) => Promise<string | null>;

let getter: TokenGetter | null = null;

export function registerTokenGetter(fn: TokenGetter | null): void {
  getter = fn;
}

/**
 * The current session token, or null when signed out. A getter that throws
 * (Clerk unreachable with an expired cached token) also yields null: the
 * request then goes out bare and fails the normal way - a ConnectionError when
 * offline, a 401 otherwise - instead of as a raw Clerk exception.
 */
export async function currentToken(options?: { skipCache?: boolean }): Promise<string | null> {
  if (!getter) return null;
  try {
    return await getter(options);
  } catch {
    return null;
  }
}

/**
 * Sends once with the cached token; on a 401, retries exactly once with a
 * freshly minted one. Clerk tokens live about a minute, so one can expire
 * between being read and being verified. No fresh token means the session is
 * gone: the first 401 is returned and AuthContext routes back to sign-in.
 */
export async function sendWithAuthRetry<R extends { status: number }>(
  send: (token: string | null) => Promise<R>,
): Promise<R> {
  const first = await send(await currentToken());
  if (first.status !== 401) return first;

  const fresh = await currentToken({ skipCache: true });
  if (!fresh) return first;
  return send(fresh);
}
