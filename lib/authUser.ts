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

/** The part of Clerk's UserResource that saving a display name needs. */
export interface DisplayNameTarget {
  unsafeMetadata?: Record<string, unknown>;
  update(params: { unsafeMetadata: Record<string, unknown> }): Promise<unknown>;
}

/**
 * Stores the Settings name in Clerk's unsafeMetadata.display_name, keeping the
 * other keys. Rejects with no user, so the caller shows an error instead of
 * closing the dialog as though the name had been saved.
 */
export async function saveDisplayName(
  user: DisplayNameTarget | null | undefined,
  name: string
): Promise<void> {
  if (!user) throw new Error('Not signed in');
  await user.update({ unsafeMetadata: { ...user.unsafeMetadata, display_name: name } });
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
