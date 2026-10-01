import React, { createContext, useContext, useEffect } from 'react';
import { useAuth as useClerkAuth, useClerk, useUser } from '@clerk/expo';
import { registerTokenGetter } from './authToken';
import { authGateState, saveDisplayName, toAppUser, type AppUser } from './authUser';

type AuthContextType = {
  user: AppUser | null;
  loading: boolean;
  signOut: () => Promise<void>;
  /** Stored in Clerk's unsafeMetadata.display_name; the user object updates itself. */
  updateDisplayName: (name: string) => Promise<void>;
};

const AuthContext = createContext<AuthContextType | null>(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

type AuthProviderProps = {
  children: React.ReactNode;
};

/**
 * Wraps Clerk behind the app's own auth shape, so screens never import Clerk.
 * Must sit inside ClerkProvider (app/_layout.tsx).
 */
export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const { isLoaded, isSignedIn, getToken } = useClerkAuth();
  const { user: clerkUser } = useUser();
  const clerk = useClerk();

  // apiFetch is plain code outside React; this is how it gets tokens.
  useEffect(() => {
    registerTokenGetter((options) => getToken(options));
    return () => registerTokenGetter(null);
  }, [getToken]);

  const gate = authGateState({ isLoaded, isSignedIn, hasUser: !!clerkUser });

  const value: AuthContextType = {
    user: gate === 'signedIn' ? toAppUser(clerkUser) : null,
    loading: gate === 'loading',
    signOut: async () => {
      await clerk.signOut();
    },
    updateDisplayName: (name: string) => saveDisplayName(clerkUser, name),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
