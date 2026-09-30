# Replace Supabase Auth with Clerk — design

Date: 2026-09-30
Status: approved in brainstorming, pending spec review

## Context and goal

CookMate authenticates with Supabase Auth (GoTrue): a hand-rolled email + password
screen in the app, Supabase access tokens verified locally by the Fastify API, and a
Supabase edge function (`livekit-token`) that mints LiveKit tokens.

We want to move to Clerk for:

- more sign-in methods without building each flow (Google now, Apple later);
- Clerk's user management dashboard;
- less lock-in to Supabase.

This is **sub-project 1 of 3** in removing Supabase entirely:

1. **Clerk auth + move `livekit-token` into the Fastify API** (this spec).
2. Storage → self-hosted MinIO (S3 API) for raw pages and recipe images.
3. Postgres → self-hosted Postgres.

Sub-projects 2 and 3 get their own specs. After this one, the app no longer depends
on Supabase at all; the backend still uses Supabase-hosted Postgres and Supabase
Storage until 2 and 3 land.

### Decisions

| Topic | Decision |
|---|---|
| Existing users | None worth keeping. Fresh start: per-user rows are wiped, no import into Clerk. |
| Sign-in methods | Google and email + password (with email-code verification). |
| Sign-in UI | Keep our `components/Auth.tsx` look, styling and en/vi strings; drive it with Clerk hooks. Same code on native and web. |
| Backend verification | Keep our `jose` verifier and point it at Clerk's JWKS (no `@clerk/fastify`, no secret key on the request path). |
| Display name | Stored in Clerk (`unsafeMetadata.display_name`, falling back to `firstName`). |
| Test users | Clerk dev-instance test emails (`+clerk_test`, code `424242`). `seed-auth` is deleted. |

### Success criteria

- The app has no `@supabase/supabase-js` dependency and no `lib/supabase.ts`.
- `supabase/functions/livekit-token` is gone; voice tokens come from `POST /voice/token`.
- A user can sign up with email (verified by code), sign in with email + password,
  sign in with Google, rename themselves, favorite recipes, and start a voice cooking
  session, on the iOS dev build and on web.
- Backend and app tests and typechecks pass.

### Non-goals

- Sign in with Apple. App Store guideline 4.8 will generally require it once Google
  sign-in ships on iOS; it is a follow-up and only needs Clerk dashboard config plus
  one more button.
- Storage and Postgres moves (sub-projects 2 and 3).
- Deleting the Supabase project.
- Organizations, roles, or any authorization beyond "signed-in user".

## Section 1 — Backend and data

### `backend/src/api/auth.ts`

- Verify only against Clerk's JWKS at `${CLERK_ISSUER}/.well-known/jwks.json`
  via `createRemoteJWKSet` (same cache/cooldown settings as today). Only asymmetric
  algorithms are accepted (`algorithms: ['RS256']`). The HS256 /
  `SUPABASE_JWT_SECRET` path is removed.
- Claims checked:
  - `iss` must equal `CLERK_ISSUER`;
  - `exp` / `nbf` with `clockTolerance: 10`;
  - no audience check (Clerk session tokens carry no `aud`);
  - `azp`: if present, it must be in `CLERK_AUTHORIZED_PARTIES`. If
    `CLERK_AUTHORIZED_PARTIES` is unset, any `azp` is rejected. Web tokens carry
    `azp` (the requesting origin); native tokens have none and skip this check;
  - `sub` must be a non-empty string.
- `AuthenticatedUser` becomes:

  ```ts
  interface AuthenticatedUser {
    id: string;              // Clerk user id (`user_…`), from `sub`
    email: string | null;    // custom session-token claim
    name: string | null;     // custom session-token claim
    sessionId: string | null; // `sid`
    claims: JWTPayload;
  }
  ```

  `role` is removed (nothing reads it).
- Unchanged: the root `onRequest` guard, `PUBLIC_ROUTES`, the `WWW-Authenticate`
  header, and the three 401 reasons `missing_token`, `invalid_token`, `token_expired`.
- A test-only hook (e.g. `setJwksForTesting(localJwks | null)`) lets tests inject a
  `createLocalJWKSet` so nothing hits the network.

The `email` and `name` claims come from a Clerk session-token template configured in
the dashboard (see "Clerk dashboard setup"):

```json
{ "email": "{{user.primary_email_address}}", "name": "{{user.full_name}}" }
```

### Env (`backend/src/env.ts`, `backend/.env.example`)

- Add `CLERK_ISSUER` (required; e.g. `https://<slug>.clerk.accounts.dev` in dev).
  `assertAuthConfigured()` refuses to boot without it.
- Add `CLERK_AUTHORIZED_PARTIES` (optional, comma-separated origins, e.g.
  `http://localhost:8081,https://app.example.com`).
- Add `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (needed by
  `/voice/token`; the route returns 500 and logs if they are missing, but the API
  still boots so recipe reads keep working).
- Remove `SUPABASE_JWT_SECRET`.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` remain for storage until
  sub-project 2. Their comments stop mentioning auth.

### Migration `backend/migrations/0017_clerk_user_ids.sql`

```sql
truncate public.user_favorites, public.user_recipe_events;

drop policy if exists "own rows" on public.user_favorites;
drop policy if exists "own rows" on public.user_recipe_events;

alter table public.user_favorites
  alter column user_id type text,
  add constraint user_favorites_user_id_nonempty check (user_id <> '');
alter table public.user_recipe_events
  alter column user_id type text,
  add constraint user_recipe_events_user_id_nonempty check (user_id <> '');
```

- RLS stays enabled with no policies, which denies all PostgREST access. The API
  connects as the table owner, so it is unaffected.
- Primary keys and indexes on `user_id` are rebuilt by `alter column … type`.
- The migration must be idempotent like its siblings: wrap the constraint additions
  so a re-run does not fail (check `pg_constraint` first, or `drop constraint if
  exists` before adding).
- `backend/src/api/queries/recipes.ts`: drop the six `::uuid` casts on `user_id`
  (use `::text` or no cast).

### New route `POST /voice/token` (`backend/src/api/routes/voice.ts`)

Ported one-for-one from `supabase/functions/livekit-token/index.ts`:

- Body `{ recipeId: string | number }` validated with zod; missing/empty → 400.
- Room `cooking-<slug(user.id)>-<slug(recipeId)>`; identity `user-<slug(user.id)>`;
  participant name `user.name ?? user.email ?? 'CookMate User'`.
- Same grants (`roomJoin`, `room`, `canPublish`, `canSubscribe`, `canPublishData`,
  `canUpdateOwnMetadata`), same TTL, and the explicit agent dispatch for `cookmate`.
- TTL stays 2 hours; dispatch via `RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName })] })`.
- Response `{ data: { token, serverUrl, roomName, expiresAt } }` (`expiresAt` in epoch
  ms). These are the fields the edge function returns and `lib/livekitToken.ts`
  consumes today, so the client's refresh-before-expiry logic keeps working.
- Adds `livekit-server-sdk` to `backend/package.json`.
- The agent name is a constant in `backend/src/api/routes/voice.ts` with a comment
  pointing at `agent/src/constants.ts`: packages build separately, so it is
  duplicated like the `cookmate_state` contract. Both must change together.
- Authenticated by the root guard like every other route (not added to
  `PUBLIC_ROUTES`).

### Deleted

- `backend/src/auth/seed.ts`, the `seed-auth` case and help line in
  `backend/src/cli.ts`, and the `seed:auth` script in `backend/package.json`.
- `supabase/functions/` (the edge function, its README, `deno.json`).
- `supabase/config.toml` and `supabase/.temp/` if nothing else still uses them
  (checked during implementation; storage and DB use connection strings/REST, not the
  Supabase CLI).

## Section 2 — App

### Dependencies and env

- Add `@clerk/clerk-expo`.
- Remove `@supabase/supabase-js` and `lib/supabase.ts`. Remove
  `react-native-url-polyfill` and `@react-native-async-storage/async-storage` only if
  nothing else imports them.
- `lib/env.ts`: `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` replaces
  `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (written as a
  literal `process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`). Update `.env.example`
  and whatever `npm run env:check` reads.

### Provider tree (`app/_layout.tsx`)

```
ClerkProvider (publishableKey, tokenCache from @clerk/clerk-expo/token-cache)
  └ AuthProvider → SettingsProvider → ShoppingProvider → FavoritesProvider → TimerProvider
```

The `user ? <RootStack/> : <Auth/>` gate is unchanged.

### `lib/AuthContext.tsx`

Rebuilt on Clerk's `useAuth` / `useUser`, keeping our own hook's shape:

```ts
type AuthContextType = {
  user: AppUser | null;
  loading: boolean;          // !isLoaded
  signOut: () => Promise<void>;
  updateDisplayName: (name: string) => Promise<void>;
};
```

- `AppUser = { id: string; email: string | null; displayName: string | null }`,
  produced by a pure mapper `toAppUser(clerkUser)` in `lib/authUser.ts`.
  `displayName` = trimmed `unsafeMetadata.display_name`, else trimmed `firstName`,
  else `null`.
- `updateDisplayName` calls `user.update({ unsafeMetadata: { ...existing,
  display_name } })`.
- On mount it calls `registerTokenGetter(getToken)` (from `lib/api.ts`) and
  unregisters on unmount.

Consumers:

- `app/(tabs)/settings.tsx`: read `user.displayName`, save via `updateDisplayName`;
  no `supabase` import.
- `components/HeaderSection.tsx`: read `user.displayName`.

### `lib/api.ts`

- New `registerTokenGetter(fn: ((opts?: { skipCache?: boolean }) => Promise<string | null>) | null)`.
- Every request gets its token from the registered getter.
- On a 401 it retries once with `getter({ skipCache: true })`, replacing
  `supabase.auth.refreshSession()`. A second 401 surfaces as an error (no loop, no
  forced sign-out).
- Retries, reachability reporting and `{ data }` unwrapping are otherwise unchanged.
  Comments stop referring to Supabase.

### `lib/livekitToken.ts`

- Becomes `apiFetch('/voice/token', { method: 'POST', body: JSON.stringify({ recipeId }) })`.
- The `FunctionsHttpError` handling is removed; errors follow `apiFetch`'s normal
  shape. The function's return type stays the same so `app/cooking/[id].tsx` and
  `LiveKitVoice` do not change.

### `components/Auth.tsx`

Same layout and styles; the screen gains a code step and a Google button.

- **Sign in:** `signIn.create({ identifier: email, password })`.
  - `status === 'complete'` → `setActive({ session: createdSessionId })`.
  - Status needs an email code (Clerk "client trust" on a new device, or an
    email-code second factor) → prepare the email code factor and switch to the code
    step. On a correct code → `setActive`.
- **Sign up:** `signUp.create({ emailAddress, password })` →
  `prepareEmailAddressVerification({ strategy: 'email_code' })` → code step →
  `attemptEmailAddressVerification({ code })` → `setActive`.
- **Code step:** code input, verify button, "resend code", and back to the form.
- **Google:** a "Continue with Google" button above an "or" divider.
  `useSSO().startSSOFlow({ strategy: 'oauth_google', redirectUrl:
  AuthSession.makeRedirectUri({ scheme: 'cookmate', path: 'sso-callback' }) })`, with
  `WebBrowser.maybeCompleteAuthSession()` at module level and browser warm-up on
  Android. On a returned `createdSessionId` → `setActive`. If the user cancels, no
  session comes back and the screen stays as it was, with no error.
- **Errors:** `lib/clerkErrors.ts` maps Clerk error codes to `TranslationKey`s
  (`form_password_incorrect`, `form_identifier_not_found`, `form_identifier_exists`,
  `form_password_pwned`, `form_password_length_too_short`, `form_code_incorrect`,
  `verification_expired`, …) and falls back to Clerk's `longMessage`, then to a
  generic key.
- **i18n (en + vi):** `auth.continueWithGoogle`, `auth.or`, `auth.verifyTitle`,
  `auth.verifyHint`, `auth.verifyButton`, `auth.resendCode`, plus the error strings.

### Clerk dashboard setup (documented in the root README)

- Email + password on, email verification by code on.
- Google social connection on; production instance uses its own Google OAuth
  credentials.
- Allowlisted redirect URL `cookmate://sso-callback`.
- Native applications registered: iOS and Android `com.kpmquockhanh.cookmate`.
- Session-token template with the `email` and `name` claims above.
- Web origins used in dev/prod listed so they match `CLERK_AUTHORIZED_PARTIES`.

## Section 3 — Error handling, testing, rollout

### Error handling

- **API 401:** `token_expired` / `invalid_token` → one retry with a fresh token; a
  second 401 surfaces as an auth error. If Clerk has actually ended the session,
  `isSignedIn` flips false and the root gate shows `<Auth/>`. `apiFetch` never signs
  the user out itself.
- **Clerk unreachable at startup:** `loading` tracks Clerk's `isLoaded`; with a
  cached token the user stays signed in and the existing offline/outage banner
  (`lib/connectivity.ts`) behaves as today.
- **Google cancelled:** no-op, no error shown.
- **Voice token failure:** the cooking screen keeps its current "voice unavailable"
  behaviour. A missing `LIVEKIT_*` config returns 500 and logs server-side, and never
  exposes details to the client.
- **Boot checks:** the API refuses to start without `CLERK_ISSUER`; `lib/env.ts`
  fails fast without `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`.

### Testing

Backend (`node:test`, `tsx --test`, no network):

- `test/auth-helpers.ts`: generate an RSA key pair, expose a local JWKS, and mint
  RS256 tokens with Clerk-shaped claims (`iss`, `sub: 'user_test…'`, `sid`, optional
  `azp`, `email`, `name`). The `TEST_SUPABASE_*` constants go away.
- `test/auth.test.ts`: valid token accepted; wrong issuer, wrong signing key,
  expired, missing `sub`, and disallowed `azp` rejected with the right `reason`;
  token without `azp` accepted; HS256 token rejected.
- `test/api.test.ts`: `/voice/token` returns 401 without a token and 400 without a
  `recipeId`, and on success returns a JWT whose decoded grants name the expected
  room and identity. Favorites work with a non-uuid `user_…` id (DB tests skip
  without a DB, as now).
- `test/api-contract.test.ts` still passes.

App (`lib/**/*.test.ts`):

- `lib/authUser.test.ts`: display-name fallback order, trimming, nulls.
- `lib/clerkErrors.test.ts`: known codes map to keys; unknown codes fall back.

Typecheck: `npm run typecheck` in root, `backend/`, `agent/`.

Manual checks on the iOS dev build (`npm run ios`) and web:

1. Sign up with a `+clerk_test` email and code `424242`, sign out, sign back in.
2. Sign in with Google.
3. Rename in settings; the header updates.
4. Favorite a recipe; it persists across reloads.
5. Start cooking; the agent joins the room.
6. Leave the app idle for more than 60 seconds, then confirm API calls still succeed
   (token refresh).

### Rollout

One branch, since there are no real users. Order of work:

1. Backend: verifier, env, migration, `/voice/token`, tests. Deploy with both the
   Clerk and LiveKit env set.
2. App: Clerk provider, AuthContext, api.ts, livekitToken.ts, Auth.tsx, i18n, tests.
3. Cleanup: delete the edge function, `seed-auth`, `lib/supabase.ts` and the Supabase
   auth env vars.
4. Docs: update root `CLAUDE.md` (App ↔ backend; voice pipeline step 1 now says the
   token comes from `POST /voice/token`), `backend/README.md`, `backend/CLAUDE.md` if
   it covers auth, and the root README (Clerk dashboard setup). The edge function
   README is deleted with it.
