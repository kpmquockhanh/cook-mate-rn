/**
 * The app's view of the signed-in user, independent of the auth provider.
 * Screens read this instead of Clerk's user object so a provider change stays
 * inside AuthContext. Pure, so it runs under `node:test`.
 */
export interface AppUser {
  /** Clerk user id (`user_…`); the backend keys per-user rows on the same value. */
  id: string;
  email: string | null;
  /** The name set in Settings, else the provider's first name (Google fills it). */
  displayName: string | null;
}

/** The fields of Clerk's UserResource this module reads. */
export interface ClerkUserLike {
  id: string;
  firstName?: string | null;
  primaryEmailAddress?: { emailAddress: string } | null;
  unsafeMetadata?: Record<string, unknown>;
}

const nonBlank = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

export function toAppUser(user: ClerkUserLike | null | undefined): AppUser | null {
  if (!user) return null;
  return {
    id: user.id,
    email: user.primaryEmailAddress?.emailAddress ?? null,
    displayName: nonBlank(user.unsafeMetadata?.display_name) ?? nonBlank(user.firstName),
  };
}

export type AuthGate = 'loading' | 'signedIn' | 'signedOut';

/**
 * What the root layout should render. "Signed in but no user object yet" is
 * loading, not signed out: the session can resolve a beat before the user.
 */
export function authGateState(state: {
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  hasUser: boolean;
}): AuthGate {
  if (!state.isLoaded) return 'loading';
  if (!state.isSignedIn) return 'signedOut';
  return state.hasUser ? 'signedIn' : 'loading';
}
