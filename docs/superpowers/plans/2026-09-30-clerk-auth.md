# Replace Supabase Auth with Clerk — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap Supabase Auth for Clerk (Google + email/password) across the Expo app and the Fastify API, and move LiveKit token minting from the Supabase edge function into the API.

**Architecture:** The API keeps its own `jose` verifier, now pointed at Clerk's JWKS. The app wraps Clerk's hooks behind our existing `useAuth()` shape, and gives `apiFetch` its tokens through a tiny pure module (`lib/authToken.ts`). `POST /voice/token` is a one-for-one port of the edge function. Per-user tables switch `user_id` from `uuid` to `text`.

**Tech Stack:** Expo 57 / React Native, `@clerk/expo` v4 (Clerk Core 3), Fastify 5, `jose` 6, `livekit-server-sdk` 2, zod 3, Postgres, `node:test` via `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-09-30-clerk-auth-design.md`

## Global Constraints

- Branch: `clerk-auth`. Commit after each task; never commit the user's pre-existing uncommitted changes in `README.md`, `CLAUDE.md`, `backend/CLAUDE.md` (see Task 9).
- Tests use Node's built-in runner (`node:test`) via `tsx --test`, not Jest. App tests must be pure — anything importing `react-native` cannot run under Node.
- App package: `@clerk/expo` (NOT the deprecated `@clerk/clerk-expo`). Install with `npx expo install @clerk/expo`.
- API 401 reasons stay exactly `missing_token` | `invalid_token` | `token_expired`.
- `PUBLIC_ROUTES` stays `new Set(['/health'])`; `/voice/token` is authenticated.
- Env: backend `CLERK_ISSUER` (required), `CLERK_AUTHORIZED_PARTIES` (optional, comma-separated), `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`; app `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`. Remove `SUPABASE_JWT_SECRET`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Keep `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (storage).
- Each `EXPO_PUBLIC_*` must be read as a literal `process.env.EXPO_PUBLIC_X` (no computed access).
- Agent name `cookmate` must equal `AGENT_NAME` in `agent/src/constants.ts`.
- LiveKit token TTL 2 hours; room `cooking-<slug(uid)>-<slug(recipeId)>`; identity `user-<slug(uid)>`; `slug = v.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64)`.
- User-facing strings go through i18n (`lib/i18n/en.ts` + `vi.ts`).
- `.env.example` files: the edits below are given as exact lines; `npm run env:check` must pass at the end of every task that touches env.

## Review Focus

1. **Signed in, but Clerk's user object not loaded yet** → the app must show the spinner, never flash the sign-in screen. Pinned by `authGateState` tests in Task 5.
2. **Clerk `getToken` throws (offline, cache expired)** → `apiFetch` sends without a token and lets the normal connection/401 handling run, instead of surfacing a raw Clerk error. Pinned in Task 5 (`authToken.test.ts`).
3. **A second 401 after the fresh-token retry** → exactly two sends, no loop; and a signed-out user (fresh token `null`) gets no retry. Pinned in Task 5.
4. **`CLERK_AUTHORIZED_PARTIES` written with spaces or trailing slashes** (`http://localhost:8081/, https://app.example.com`) → still matches the browser's `azp` (`http://localhost:8081`). Pinned in Task 1.
5. **`recipeId` sent as a number, or as whitespace** → a number is accepted (the app sends route params that may be numeric), whitespace-only is a 400. Pinned in Task 3.

---

## File Structure

Backend:
- Modify `backend/src/api/auth.ts` — Clerk JWKS verification, `setJwksForTesting`.
- Modify `backend/src/env.ts` — Clerk + LiveKit vars, drop JWT secret.
- Modify `backend/test/auth-helpers.ts` — RS256 key pair, Clerk-shaped tokens.
- Modify `backend/test/auth.test.ts`, `backend/test/api.test.ts` — new helpers.
- Create `backend/migrations/0017_clerk_user_ids.sql`.
- Modify `backend/src/api/queries/recipes.ts` — drop `::uuid` casts.
- Create `backend/src/api/routes/voice.ts`, `backend/test/voice.test.ts`.
- Modify `backend/src/api/server.ts` — register voice routes.
- Delete `backend/src/auth/seed.ts`; modify `backend/src/cli.ts`, `backend/package.json`.

App:
- Create `lib/authUser.ts` (+ test) — Clerk user → `AppUser`, gate state.
- Create `lib/clerkErrors.ts` (+ test) — Clerk error → i18n key or text.
- Create `lib/authToken.ts` (+ test) — token getter registry, 401 retry.
- Modify `lib/i18n/en.ts`, `lib/i18n/vi.ts`.
- Modify `lib/env.ts`, `app/_layout.tsx`, `lib/AuthContext.tsx`, `lib/api.ts`, `lib/livekitToken.ts`, `app/(tabs)/settings.tsx`, `components/HeaderSection.tsx`, `components/Auth.tsx`.
- Create `app/sso-callback.tsx`.
- Delete `lib/supabase.ts`, `supabase/functions/`.

---

### Task 1: Backend verifies Clerk session tokens

**Files:**
- Modify: `backend/src/env.ts` (the `// ---- Auth (src/api/auth.ts) ----` block, ~lines 151-159)
- Modify: `backend/src/api/auth.ts` (whole verification section, lines ~1-160)
- Modify: `backend/test/auth-helpers.ts` (rewrite)
- Modify: `backend/test/auth.test.ts` (rewrite)
- Modify: `backend/test/api.test.ts` (top-of-file setup only)
- Modify: `backend/.env.example`

**Interfaces:**
- Produces: `verifyAccessToken(token: string): Promise<AuthenticatedUser>`; `AuthenticatedUser = { id: string; email: string | null; name: string | null; sessionId: string | null; claims: JWTPayload }`; `setJwksForTesting(keySet: JWTVerifyGetKey | null): void`; `env.clerkIssuer: string | undefined`; `env.clerkAuthorizedParties: string[]`.
- Test helpers produced: `applyTestAuthEnv()`, `installTestJwks(setter)`, `mintToken(overrides)`, `mintHs256Token()`, `authHeaders(overrides)`, `TEST_ISSUER`, `TEST_USER_ID`, `TEST_AUTHORIZED_PARTY`, `testJwks`.

- [ ] **Step 1: Rewrite the test helpers**

Replace `backend/test/auth-helpers.ts` entirely:

```ts
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';

/**
 * Fixed test config, applied by every suite that builds the server.
 *
 * These deliberately OVERRIDE whatever backend/.env holds: the auth tests must
 * behave the same on a laptop with a real Clerk instance configured and in CI
 * with nothing configured. Tokens are signed with a key pair generated here and
 * verified against a local JWKS, so nothing reaches the network.
 */
export const TEST_ISSUER = 'https://test-instance.clerk.accounts.dev';
export const TEST_AUTHORIZED_PARTY = 'http://localhost:8081';
// Clerk ids are opaque strings, not uuids - the point of migration 0017.
export const TEST_USER_ID = 'user_2testTESTtest00000000000';
const KID = 'test-signing-key';

const signing = await generateKeyPair('RS256', { extractable: true });
const stranger = await generateKeyPair('RS256');

export const testJwks: JWTVerifyGetKey = createLocalJWKSet({
  keys: [{ ...(await exportJWK(signing.publicKey)), kid: KID, alg: 'RS256', use: 'sig' }],
});

/**
 * Call before the first `import('../src/...')` - src/env.ts reads process.env at load.
 * The spaces and trailing slash are deliberate: they are how a human writes the
 * list, and env parsing has to normalise them.
 */
export function applyTestAuthEnv(): void {
  process.env.CLERK_ISSUER = TEST_ISSUER;
  process.env.CLERK_AUTHORIZED_PARTIES = `${TEST_AUTHORIZED_PARTY}/ , https://app.example.com`;
}

/** Point the verifier at the local key set. Pass `setJwksForTesting` from src/api/auth.ts. */
export function installTestJwks(setter: (keySet: JWTVerifyGetKey | null) => void): void {
  setter(testJwks);
}

export interface TokenOverrides {
  /** `null` mints a token with no subject at all. */
  sub?: string | null;
  email?: string;
  name?: string;
  issuer?: string;
  /** `null` (the default) omits `azp`, like a native client's token. */
  azp?: string | null;
  /** Seconds from now. Negative mints an already-expired token. */
  expiresInSeconds?: number;
  /** Sign with a key that is not in the JWKS (same `kid`, so the lookup succeeds and the signature fails). */
  wrongKey?: boolean;
}

/** Mints a token shaped like a Clerk session token with our `email`/`name` template claims. */
export async function mintToken(overrides: TokenOverrides = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    email: overrides.email ?? 'cook@example.com',
    name: overrides.name ?? 'Test Cook',
    sid: 'sess_test',
  };
  if (overrides.azp) claims.azp = overrides.azp;

  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
    .setIssuer(overrides.issuer ?? TEST_ISSUER)
    .setIssuedAt(now)
    // Absolute value so a negative offset produces an already-expired token.
    .setExpirationTime(now + (overrides.expiresInSeconds ?? 3600));
  if (overrides.sub !== null) jwt = jwt.setSubject(overrides.sub ?? TEST_USER_ID);

  return jwt.sign(overrides.wrongKey ? stranger.privateKey : signing.privateKey);
}

/** An HS256 token with otherwise valid claims - the verifier must refuse the algorithm. */
export async function mintHs256Token(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: 'sess_test' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(TEST_USER_ID)
    .setIssuer(TEST_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode('an-hs256-secret-the-api-must-not-accept'));
}

/** `Authorization` header for a freshly minted valid token. */
export async function authHeaders(overrides: TokenOverrides = {}): Promise<{ authorization: string }> {
  return { authorization: `Bearer ${await mintToken(overrides)}` };
}
```

- [ ] **Step 2: Rewrite the auth tests**

Replace `backend/test/auth.test.ts` entirely:

```ts
import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTestAuthEnv,
  authHeaders,
  installTestJwks,
  mintHs256Token,
  mintToken,
  TEST_AUTHORIZED_PARTY,
  TEST_ISSUER,
  TEST_USER_ID,
} from './auth-helpers.js';

// Must run before src/env.ts is loaded, hence the dynamic imports below.
applyTestAuthEnv();

const { buildServer } = await import('../src/api/server.js');
const { setJwksForTesting, verifyAccessToken } = await import('../src/api/auth.js');
const { close } = await import('../src/db.js');
installTestJwks(setJwksForTesting);

/**
 * No database needed: the guard rejects before any handler runs, and the one
 * authorised case only asserts that the request got *past* the guard. That
 * keeps the security tests running everywhere, which is the point of them.
 */
test('API authentication', async (t) => {
  const app = await buildServer();

  t.after(async () => {
    await app.close();
    await close();
  });

  const get = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/recipes?limit=1', headers });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  await t.test('rejects a request with no Authorization header', async () => {
    const response = await get();
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'missing_token');
    assert.match(String(response.headers['www-authenticate']), /^Bearer/);
  });

  await t.test('rejects a non-Bearer Authorization header', async () => {
    const response = await get({ authorization: 'Basic dXNlcjpwYXNz' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'missing_token');
  });

  await t.test('rejects a token that is not a JWT', async () => {
    const response = await get(bearer('not-a-jwt'));
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'invalid_token');
  });

  await t.test('rejects a token signed with a key outside the JWKS', async () => {
    const response = await get(bearer(await mintToken({ wrongKey: true })));
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'invalid_token');
  });

  await t.test('rejects a token from another Clerk instance', async () => {
    const response = await get(bearer(await mintToken({ issuer: 'https://someone-else.clerk.accounts.dev' })));
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'invalid_token');
  });

  // The legacy Supabase path accepted HS256. Clerk never issues it, so a token
  // using it is forged or stale, whatever its claims say.
  await t.test('rejects an HS256 token', async () => {
    const response = await get(bearer(await mintHs256Token()));
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'invalid_token');
  });

  await t.test('rejects a token with no subject', async () => {
    const response = await get(bearer(await mintToken({ sub: null })));
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'invalid_token');
  });

  await t.test('rejects a web token from an origin that is not an authorized party', async () => {
    const response = await get(bearer(await mintToken({ azp: 'https://evil.example.com' })));
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'invalid_token');
  });

  // CLERK_AUTHORIZED_PARTIES is set with a trailing slash and spaces in
  // applyTestAuthEnv; the browser's azp has neither.
  await t.test('accepts a web token from an authorized party, however the list was written', async () => {
    const first = await get(bearer(await mintToken({ azp: TEST_AUTHORIZED_PARTY })));
    assert.notEqual(first.statusCode, 401);
    const second = await get(bearer(await mintToken({ azp: 'https://app.example.com' })));
    assert.notEqual(second.statusCode, 401);
  });

  await t.test('accepts a native token, which carries no azp', async () => {
    const response = await get(await authHeaders());
    // 200 with a database behind it, 500 without - either way it is not the
    // guard turning it away.
    assert.notEqual(response.statusCode, 401);
  });

  await t.test('reports an expired token distinctly so the app can refresh', async () => {
    const response = await get(bearer(await mintToken({ expiresInSeconds: -60 })));
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().reason, 'token_expired');
  });

  await t.test('/health stays public - probes carry no session', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.notEqual(response.statusCode, 401);
  });

  await t.test('an unauthenticated request never reaches an unknown route either', async () => {
    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });
    assert.equal(response.statusCode, 401);
  });

  await t.test('verifyAccessToken exposes the claims routes key off', async () => {
    const user = await verifyAccessToken(await mintToken({ email: 'chef@example.com', name: 'Chef' }));
    assert.equal(user.id, TEST_USER_ID);
    assert.equal(user.email, 'chef@example.com');
    assert.equal(user.name, 'Chef');
    assert.equal(user.sessionId, 'sess_test');
    assert.equal(user.claims.iss, TEST_ISSUER);
  });
});
```

- [ ] **Step 3: Update `api.test.ts` setup**

In `backend/test/api.test.ts`, change the helper import and install the local JWKS after `buildServer` is imported:

```ts
import { applyTestAuthEnv, authHeaders, installTestJwks } from './auth-helpers.js';

// Every route but /health needs a token now. Override the auth env before
// anything under src/ loads, then mint tokens locally - these tests need a
// database, not a Clerk instance.
applyTestAuthEnv();
```

and inside `test('recipes API', ...)`, right after the two dynamic imports:

```ts
  const { setJwksForTesting } = await import('../src/api/auth.js');
  installTestJwks(setJwksForTesting);
```

Also search the file for any other `authHeaders({ sub: ... })` calls using a uuid and leave them — a uuid string is still a valid `text` id.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd backend && npx tsx --test test/auth.test.ts`
Expected: FAIL — `setJwksForTesting` is not exported / `Auth is not configured: set SUPABASE_URL ...` thrown from `buildServer`.

- [ ] **Step 5: Replace the auth env block**

In `backend/src/env.ts`, replace the `// ---- Auth (src/api/auth.ts) ----` block (the `supabaseUrl` and `supabaseJwtSecret` entries) with:

```ts
  // ---- Auth (src/api/auth.ts) ----
  // The Clerk instance's Frontend API URL, e.g. https://<slug>.clerk.accounts.dev
  // in development. It is both the expected `iss` and the base of the JWKS
  // endpoint. The API refuses to boot without it (see assertAuthConfigured).
  clerkIssuer: process.env.CLERK_ISSUER?.trim().replace(/\/$/, '') || undefined,
  // Origins allowed to present a web session token (its `azp` claim). Native
  // tokens carry no `azp` and are unaffected. Empty means no web client is
  // allowed, which is the safe default for a deployment that forgot to set it.
  clerkAuthorizedParties: (process.env.CLERK_AUTHORIZED_PARTIES ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean),
```

Then, in the `// ---- Raw page storage (src/storage/pages.ts) ----` block, add the storage-only `supabaseUrl` right above `supabaseServiceRoleKey`:

```ts
  // Project URL, e.g. https://PROJECT.supabase.co. Storage only now - auth
  // moved to Clerk. Goes away with the move to MinIO.
  supabaseUrl: process.env.SUPABASE_URL?.replace(/\/$/, ''),
```

Run `cd backend && grep -rn "supabaseJwtSecret" src` — expected: matches only in `src/api/auth.ts` (removed next step).

- [ ] **Step 6: Rewrite the verification section of `auth.ts`**

In `backend/src/api/auth.ts`:

1. Change the jose import to:

```ts
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
```

2. Replace the `AuthenticatedUser` interface with:

```ts
/** The subset of the Clerk session token the app actually acts on. */
export interface AuthenticatedUser {
  /** Clerk user id (`user_…`) - the string to key any per-user row on. */
  id: string;
  /** From the session-token template (`{{user.primary_email_address}}`). */
  email: string | null;
  /** From the session-token template (`{{user.full_name}}`). */
  name: string | null;
  /** Clerk session id (`sid`), useful for correlating logs with a single sign-in. */
  sessionId: string | null;
  claims: JWTPayload;
}
```

3. Replace everything from the `/** Supabase signs access tokens one of two ways ...` comment down to the end of `verifyAccessToken` with:

```ts
/**
 * Clerk signs session tokens with RS256 keys published at the instance's JWKS
 * endpoint. The set is cached in-process and only refetched when an unknown
 * `kid` shows up, with a cooldown so a bad token cannot turn into a fetch loop
 * against Clerk.
 */
let jwksRef: JWTVerifyGetKey | null = null;
let testJwksRef: JWTVerifyGetKey | null = null;

function jwks(): JWTVerifyGetKey {
  if (testJwksRef) return testJwksRef;
  if (!jwksRef) {
    jwksRef = createRemoteJWKSet(new URL(`${env.clerkIssuer}/.well-known/jwks.json`), {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
  }
  return jwksRef;
}

/** Test-only: verify against a local key set instead of fetching Clerk's. `null` restores the default. */
export function setJwksForTesting(keySet: JWTVerifyGetKey | null): void {
  testJwksRef = keySet;
}

/**
 * Boot-time check so a misconfigured deploy fails on startup rather than 401ing
 * every request once it is already serving traffic.
 */
export function assertAuthConfigured(): void {
  if (!env.clerkIssuer) {
    throw new Error(
      'Auth is not configured: set CLERK_ISSUER to the Clerk Frontend API URL. See backend/.env.example.',
    );
  }
}

/**
 * Verifies a Clerk session token locally. No call to Clerk on the request path -
 * signature, issuer, authorized party and expiry are all checkable here, and a
 * per-request round trip would put Clerk in the critical path of every read.
 */
export async function verifyAccessToken(token: string): Promise<AuthenticatedUser> {
  try {
    const { payload } = await jwtVerify(token, jwks(), {
      issuer: env.clerkIssuer,
      // Clerk only issues RS256; accepting anything else (HS256 in particular)
      // would let a leaked shared secret or an alg-confusion trick mint users.
      algorithms: ['RS256'],
      // Phones drift. Anything larger starts to matter for revocation - Clerk
      // tokens only live for about a minute.
      clockTolerance: 10,
    });

    // `azp` is the origin that requested a web token. Native tokens have none.
    if (typeof payload.azp === 'string' && !env.clerkAuthorizedParties.includes(payload.azp)) {
      throw new AuthError('invalid_token', `azp ${payload.azp} is not an authorized party`);
    }

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new AuthError('invalid_token', 'token has no subject');
    }

    return {
      id: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : null,
      name: typeof payload.name === 'string' && payload.name.trim() ? payload.name : null,
      sessionId: typeof payload.sid === 'string' ? payload.sid : null,
      claims: payload,
    };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    // Expiry is separated out because it is the one failure the client can fix
    // by itself: it fetches a fresh token and retries. Lumping it in with a bad
    // signature would make the app treat a normal expiry as a broken session.
    if (error instanceof joseErrors.JWTExpired) {
      throw new AuthError('token_expired', 'access token has expired');
    }
    throw new AuthError('invalid_token', error instanceof Error ? error.message : 'invalid token');
  }
}
```

Leave `bearer`, `unauthorized`, `registerAuth` and `requireUser` unchanged. Run `grep -n "hmac\|supabase" backend/src/api/auth.ts` — expected: no output.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && npx tsx --test test/auth.test.ts && npm run typecheck`
Expected: all `API authentication` subtests PASS; typecheck clean. (If `typecheck` reports another reader of `user.role`, remove that read — nothing in the app uses it.)

- [ ] **Step 8: Update `backend/.env.example`**

Remove the `SUPABASE_JWT_SECRET=...` line and its comment. Add:

```bash
# Clerk (src/api/auth.ts). Frontend API URL from the Clerk dashboard (API keys page).
CLERK_ISSUER=https://your-instance.clerk.accounts.dev
# Web origins allowed to call the API with a Clerk session (comma-separated). Native apps need nothing here.
CLERK_AUTHORIZED_PARTIES=http://localhost:8081
```

Change the comment on `SUPABASE_URL` so it says storage only. Run `npm run env:check` from the repo root — expected: no backend drift reported for these variables.

- [ ] **Step 9: Run the full backend suite and commit**

Run: `cd backend && npm test`
Expected: PASS (DB-backed suites skip without `DATABASE_URL`).

```bash
git add backend/src/env.ts backend/src/api/auth.ts backend/test/auth-helpers.ts backend/test/auth.test.ts backend/test/api.test.ts backend/.env.example
git commit -m "Verify Clerk session tokens in the API instead of Supabase's

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Per-user tables key on Clerk's string ids

**Files:**
- Create: `backend/migrations/0017_clerk_user_ids.sql`
- Modify: `backend/src/api/queries/recipes.ts` (lines ~184, 209, 250, 323, 331, 347)

**Interfaces:**
- Consumes: `TEST_USER_ID = 'user_2testTESTtest00000000000'` from Task 1 (the existing favourite tests in `api.test.ts` now exercise a non-uuid id).
- Produces: `public.user_favorites.user_id` and `public.user_recipe_events.user_id` are `text not null`, non-empty.

- [ ] **Step 1: Confirm the existing favourite tests fail against a migrated-before DB**

Only if you have a database: `cd backend && npm run setup && npx tsx --test test/api.test.ts`
Expected: FAIL in "favouriting is idempotent and visible on the recipe" with `invalid input syntax for type uuid: "user_2testTESTtest00000000000"`. Without `DATABASE_URL` the suite skips; continue anyway.

- [ ] **Step 2: Write the migration**

Create `backend/migrations/0017_clerk_user_ids.sql`:

```sql
-- Per-user rows key on Clerk user ids now.
--
-- Auth moved from Supabase (auth.users.id, a uuid) to Clerk, whose ids are
-- opaque strings like `user_2abc...`. There were no real users to carry over,
-- so the rows are dropped rather than remapped: a favourite keyed on a Supabase
-- uuid would never match a Clerk id again anyway.
--
-- The "own rows" policies compared user_id to auth.uid(). They go: auth.uid()
-- is a Supabase Auth concept that no longer means anything here. RLS stays
-- enabled with no policy, which denies everything through PostgREST and changes
-- nothing for the API, which connects as the table owner.

truncate public.user_favorites, public.user_recipe_events;

drop policy if exists "own rows" on public.user_favorites;
drop policy if exists "own rows" on public.user_recipe_events;

-- `type text` rebuilds the primary key and the user_id indexes in place.
alter table public.user_favorites alter column user_id type text;
alter table public.user_recipe_events alter column user_id type text;

alter table public.user_favorites drop constraint if exists user_favorites_user_id_nonempty;
alter table public.user_favorites
  add constraint user_favorites_user_id_nonempty check (user_id <> '');

alter table public.user_recipe_events drop constraint if exists user_recipe_events_user_id_nonempty;
alter table public.user_recipe_events
  add constraint user_recipe_events_user_id_nonempty check (user_id <> '');
```

- [ ] **Step 3: Drop the uuid casts**

In `backend/src/api/queries/recipes.ts`, replace every `::uuid` on a user id with `::text`:

Run: `cd backend && sed -i '' 's/::uuid/::text/g' src/api/queries/recipes.ts && grep -n "::uuid\|::text" src/api/queries/recipes.ts`
Expected: the six former `::uuid` sites now read `::text` (e.g. `f.user_id = ${user}::text`, `values ($1::text, $2)`); no `::uuid` left. Check that no other `::text` lines changed meaning (the grep shows them all).

Also update the doc comment on `user_id` in `backend/migrations/0013_user_signals.sql`? **No** — applied migrations are immutable; 0017 documents the change.

- [ ] **Step 4: Verify**

Run: `cd backend && npm run typecheck && npm test`
Expected: PASS. With a database: `npm run setup` logs `applied 0017_clerk_user_ids.sql`, and `npx tsx --test test/api.test.ts` passes including the favourite and "one user cannot see another user's favourites" subtests.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/0017_clerk_user_ids.sql backend/src/api/queries/recipes.ts
git commit -m "Key per-user rows on Clerk's string user ids

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `POST /voice/token` replaces the edge function

**Files:**
- Create: `backend/src/api/routes/voice.ts`
- Create: `backend/test/voice.test.ts`
- Modify: `backend/src/api/server.ts` (register after `recipeRoutes`)
- Modify: `backend/src/env.ts` (new LiveKit block)
- Modify: `backend/package.json` (dependency)
- Modify: `backend/.env.example`

**Interfaces:**
- Consumes: `requireUser(request): AuthenticatedUser` (`id`, `name`, `email`) from `backend/src/api/auth.ts`; test helpers from Task 1.
- Produces: `POST /voice/token` body `{ recipeId: string | number }` → `200 { data: { token: string; serverUrl: string; roomName: string; identity: string; expiresAt: number } }`; `400 { error: 'recipeId is required' }`; `500 { error: 'Voice service is not configured' }`. Exports `voiceRoutes`, `AGENT_NAME`, `TOKEN_TTL_SECONDS`, `slug`. `env.livekitUrl`, `env.livekitApiKey`, `env.livekitApiSecret: string | undefined`.

- [ ] **Step 1: Add the dependency**

Run: `cd backend && npm install livekit-server-sdk@^2.15.0`
Expected: `backend/package.json` lists `"livekit-server-sdk": "^2.15.x"` (same major as `agent/`).

- [ ] **Step 2: Write the failing test**

Create `backend/test/voice.test.ts`:

```ts
import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeJwt } from 'jose';
import { applyTestAuthEnv, authHeaders, installTestJwks, TEST_USER_ID } from './auth-helpers.js';

applyTestAuthEnv();
process.env.LIVEKIT_URL = 'wss://test.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'test-api-key';
process.env.LIVEKIT_API_SECRET = 'test-api-secret-that-is-long-enough-for-hs256';

const { buildServer } = await import('../src/api/server.js');
const { setJwksForTesting } = await import('../src/api/auth.js');
const { close } = await import('../src/db.js');
installTestJwks(setJwksForTesting);

// No database: the route only signs a token.
test('POST /voice/token', async (t) => {
  const app = await buildServer();
  t.after(async () => {
    await app.close();
    await close();
  });

  const post = async (payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/voice/token', payload: payload as object, headers });

  await t.test('401s without a token', async () => {
    const response = await post({ recipeId: '42' });
    assert.equal(response.statusCode, 401);
  });

  await t.test('400s without a recipeId', async () => {
    const response = await post({}, await authHeaders());
    assert.equal(response.statusCode, 400);
  });

  await t.test('400s for a whitespace-only recipeId', async () => {
    const response = await post({ recipeId: '   ' }, await authHeaders());
    assert.equal(response.statusCode, 400);
  });

  await t.test('mints a token for the caller\'s own room, with the agent dispatched', async () => {
    const response = await post({ recipeId: 42 }, await authHeaders({ name: 'Chef Test' }));
    assert.equal(response.statusCode, 200);
    const { data } = response.json();

    assert.equal(data.serverUrl, 'wss://test.livekit.cloud');
    assert.equal(data.roomName, `cooking-${TEST_USER_ID}-42`);
    assert.equal(data.identity, `user-${TEST_USER_ID}`);
    const ttlMs = data.expiresAt - Date.now();
    assert.ok(ttlMs > 110 * 60_000 && ttlMs <= 120 * 60_000, `expiresAt is ${ttlMs}ms away`);

    const claims = decodeJwt(data.token) as Record<string, unknown> & {
      video?: Record<string, unknown>;
    };
    assert.equal(claims.sub, `user-${TEST_USER_ID}`);
    assert.equal(claims.name, 'Chef Test');
    assert.equal(claims.video?.room, `cooking-${TEST_USER_ID}-42`);
    assert.equal(claims.video?.roomJoin, true);
    assert.equal(claims.video?.canPublishData, true);
    assert.equal(claims.video?.canUpdateOwnMetadata, true);
    // Without the explicit dispatch the room connects and no agent ever joins.
    assert.match(JSON.stringify(claims), /"cookmate"/);
  });

  await t.test('the room is derived from the verified user, never the body', async () => {
    const response = await post(
      { recipeId: '7', roomName: 'cooking-someone-else-7', identity: 'user-someone-else' },
      await authHeaders(),
    );
    assert.equal(response.json().data.roomName, `cooking-${TEST_USER_ID}-7`);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd backend && npx tsx --test test/voice.test.ts`
Expected: FAIL — the authorised requests get 404 (`Not found`) because the route does not exist.

- [ ] **Step 4: Add the LiveKit env block**

In `backend/src/env.ts`, after the `// ---- Auth (src/api/auth.ts) ----` block, add:

```ts
  // ---- Voice (src/api/routes/voice.ts) ----
  // Used to mint per-user LiveKit room tokens. Optional so the API still serves
  // recipes without them; /voice/token answers 500 until they are set.
  livekitUrl: process.env.LIVEKIT_URL,
  livekitApiKey: process.env.LIVEKIT_API_KEY,
  livekitApiSecret: process.env.LIVEKIT_API_SECRET,
```

- [ ] **Step 5: Write the route**

Create `backend/src/api/routes/voice.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';
import { z } from 'zod';
import { env } from '../../env.js';
import { logger } from '../../log.js';
import { requireUser } from '../auth.js';

const log = logger('voice');

/** Cooking sessions run long; keep it bounded but not annoying. */
export const TOKEN_TTL_SECONDS = 2 * 60 * 60;

/**
 * Must match AGENT_NAME in agent/src/constants.ts. The worker uses explicit
 * dispatch, so without this the room connects and no agent ever joins. The
 * packages build separately, so this is duplicated on purpose - change both.
 */
export const AGENT_NAME = 'cookmate';

/** Keep identifiers to characters LiveKit and our logs handle predictably. */
export function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
}

// Route params reach the app as strings, but a numeric id is just as valid.
const TokenBody = z.object({
  recipeId: z.union([z.string(), z.number()]).transform(String).pipe(z.string().trim().min(1)),
});

/**
 * Mints a short-lived LiveKit token for the calling user. The room name and
 * participant identity come from the *verified* user, never from the request
 * body, so a caller cannot join another user's cooking session by asking for it.
 */
export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  app.post('/voice/token', async (request, reply) => {
    const body = TokenBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'recipeId is required' });

    if (!env.livekitUrl || !env.livekitApiKey || !env.livekitApiSecret) {
      log.error('LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET not configured');
      return reply.code(500).send({ error: 'Voice service is not configured' });
    }

    const user = requireUser(request);
    // One room per user per recipe: stable across reconnects, never shared.
    const roomName = `cooking-${slug(user.id)}-${slug(body.data.recipeId)}`;
    const identity = `user-${slug(user.id)}`;

    const token = new AccessToken(env.livekitApiKey, env.livekitApiSecret, {
      identity,
      name: user.name ?? user.email ?? 'CookMate User',
      ttl: TOKEN_TTL_SECONDS,
    });
    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      // The agent drives the app over RPC, which rides the data channel.
      canPublishData: true,
      // The app publishes the live recipe/step state as participant attributes.
      canUpdateOwnMetadata: true,
    });
    // Ask for our named worker; it does not auto-join rooms.
    token.roomConfig = new RoomConfiguration({
      agents: [new RoomAgentDispatch({ agentName: AGENT_NAME })],
    });

    return {
      data: {
        token: await token.toJwt(),
        serverUrl: env.livekitUrl,
        roomName,
        identity,
        expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000,
      },
    };
  });
}
```

- [ ] **Step 6: Register it**

In `backend/src/api/server.ts`, add `import { voiceRoutes } from './routes/voice.js';` next to the `recipeRoutes` import, and after `await app.register(recipeRoutes);` add:

```ts
  await app.register(voiceRoutes);
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && npx tsx --test test/voice.test.ts && npm run typecheck && npm test`
Expected: all PASS.

- [ ] **Step 8: Update `backend/.env.example` and commit**

Add to `backend/.env.example`:

```bash
# LiveKit (src/api/routes/voice.ts) - same project the agent uses. Mints per-user room tokens.
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
```

Run `npm run env:check` from the repo root — expected: no backend drift.

```bash
git add backend/src/api/routes/voice.ts backend/test/voice.test.ts backend/src/api/server.ts backend/src/env.ts backend/package.json backend/package-lock.json backend/.env.example
git commit -m "Mint LiveKit tokens from the API instead of a Supabase edge function

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Remove the Supabase test-user seeding

**Files:**
- Delete: `backend/src/auth/seed.ts`
- Modify: `backend/src/cli.ts` (import on line 2, help line ~50, `case 'seed-auth'` ~lines 130-135)
- Modify: `backend/package.json` (`"seed:auth"` script)

**Interfaces:**
- Consumes: nothing. Produces: nothing (removal).

- [ ] **Step 1: Delete and unhook**

```bash
git rm backend/src/auth/seed.ts
```

In `backend/src/cli.ts`: delete `import { clearTestUsers, seedTestUsers } from './auth/seed.js';`, delete the help line `  seed-auth [--clear]          Create/refresh the test auth users (dev only)`, and delete the whole block:

```ts
    // Deliberately not part of `setup`: these are real, signed-in-able accounts
    // and they have no business existing in a production project.
    case 'seed-auth':
      if (flag(args, 'clear')) await clearTestUsers();
      else await seedTestUsers();
      break;
```

In `backend/package.json`, delete the `"seed:auth": "tsx src/cli.ts seed-auth",` line.

- [ ] **Step 2: Verify nothing else references it**

Run: `cd backend && grep -rn "seed-auth\|seed:auth\|seedTestUsers\|clearTestUsers\|auth/seed" src test package.json`
Expected: no output. (If `flag` is now unused in `cli.ts`, typecheck will not complain because it is used by other commands; check with the next step.)

Run: `cd backend && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/src/cli.ts backend/package.json
git commit -m "Drop seed-auth; Clerk dev instances provide test users

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Pure auth helpers for the app (user mapping, errors, token retry)

**Files:**
- Create: `lib/authUser.ts`, `lib/authUser.test.ts`
- Create: `lib/clerkErrors.ts`, `lib/clerkErrors.test.ts`
- Create: `lib/authToken.ts`, `lib/authToken.test.ts`
- Modify: `lib/i18n/en.ts` (auth block, ~lines 344-368), `lib/i18n/vi.ts` (same keys)

**Interfaces:**
- Produces (used by Tasks 6 and 7):
  - `interface AppUser { id: string; email: string | null; displayName: string | null }`
  - `interface ClerkUserLike { id: string; firstName?: string | null; primaryEmailAddress?: { emailAddress: string } | null; unsafeMetadata?: Record<string, unknown> }`
  - `toAppUser(user: ClerkUserLike | null | undefined): AppUser | null`
  - `type AuthGate = 'loading' | 'signedIn' | 'signedOut'`; `authGateState(s: { isLoaded: boolean; isSignedIn: boolean | undefined; hasUser: boolean }): AuthGate`
  - `type AuthErrorMessage = { key: TranslationKey } | { text: string }`; `describeClerkError(error: unknown): AuthErrorMessage`
  - `type TokenGetter = (options?: { skipCache?: boolean }) => Promise<string | null>`; `registerTokenGetter(fn: TokenGetter | null): void`; `currentToken(options?: { skipCache?: boolean }): Promise<string | null>`; `sendWithAuthRetry<R extends { status: number }>(send: (token: string | null) => Promise<R>): Promise<R>`
  - i18n keys: `auth.continueWithGoogle`, `auth.or`, `auth.verifyTitle`, `auth.verifyHint`, `auth.verifyButton`, `auth.verifying`, `auth.codeLabel`, `auth.codePlaceholder`, `auth.resendCode`, `auth.codeResent`, `auth.backToForm`, `auth.errorPasswordIncorrect`, `auth.errorAccountNotFound`, `auth.errorPasswordPwned`, `auth.errorCodeIncorrect`, `auth.errorCodeExpired`, `auth.errorTooManyAttempts`, `auth.errorGeneric`.

- [ ] **Step 1: Write the failing tests**

Create `lib/authUser.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { authGateState, toAppUser } from './authUser';

test('toAppUser', async (t) => {
  await t.test('null in, null out', () => {
    assert.equal(toAppUser(null), null);
    assert.equal(toAppUser(undefined), null);
  });

  await t.test('the name set in Settings wins over the Google first name', () => {
    const user = toAppUser({
      id: 'user_1',
      firstName: 'Khanh',
      primaryEmailAddress: { emailAddress: 'k@example.com' },
      unsafeMetadata: { display_name: '  Chef K  ' },
    });
    assert.deepEqual(user, { id: 'user_1', email: 'k@example.com', displayName: 'Chef K' });
  });

  await t.test('a blank display name falls back to the first name', () => {
    const user = toAppUser({ id: 'user_1', firstName: ' Khanh ', unsafeMetadata: { display_name: '   ' } });
    assert.equal(user?.displayName, 'Khanh');
  });

  await t.test('a non-string display name is ignored', () => {
    const user = toAppUser({ id: 'user_1', firstName: null, unsafeMetadata: { display_name: 42 } });
    assert.equal(user?.displayName, null);
  });

  await t.test('no email and no names gives nulls, not empty strings', () => {
    assert.deepEqual(toAppUser({ id: 'user_1' }), { id: 'user_1', email: null, displayName: null });
  });
});

test('authGateState', async (t) => {
  await t.test('loading until Clerk has loaded', () => {
    assert.equal(authGateState({ isLoaded: false, isSignedIn: undefined, hasUser: false }), 'loading');
  });

  // The session can resolve a beat before the user object. Showing the sign-in
  // screen in that gap flashes it at every signed-in launch.
  await t.test('signed in but no user object yet is still loading', () => {
    assert.equal(authGateState({ isLoaded: true, isSignedIn: true, hasUser: false }), 'loading');
  });

  await t.test('signed in with a user', () => {
    assert.equal(authGateState({ isLoaded: true, isSignedIn: true, hasUser: true }), 'signedIn');
  });

  await t.test('signed out', () => {
    assert.equal(authGateState({ isLoaded: true, isSignedIn: false, hasUser: false }), 'signedOut');
  });
});
```

Create `lib/clerkErrors.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { describeClerkError } from './clerkErrors';

test('describeClerkError', async (t) => {
  await t.test('an API response error maps its first error code to a key', () => {
    const error = {
      code: 'api_response_error',
      errors: [{ code: 'form_password_incorrect', message: 'Password is incorrect.' }],
    };
    assert.deepEqual(describeClerkError(error), { key: 'auth.errorPasswordIncorrect' });
  });

  await t.test('a top-level code maps too', () => {
    assert.deepEqual(describeClerkError({ code: 'form_identifier_exists' }), { key: 'auth.errorEmailTaken' });
  });

  await t.test('an unknown code falls back to Clerk\'s long message', () => {
    const error = { errors: [{ code: 'something_new', message: 'Short', longMessage: 'The long one.' }] };
    assert.deepEqual(describeClerkError(error), { text: 'The long one.' });
  });

  await t.test('then to the short message', () => {
    assert.deepEqual(describeClerkError({ errors: [{ code: 'x', message: 'Short' }] }), { text: 'Short' });
  });

  await t.test('a thrown Error uses its message', () => {
    assert.deepEqual(describeClerkError(new Error('boom')), { text: 'boom' });
  });

  await t.test('nothing usable gives the generic key', () => {
    assert.deepEqual(describeClerkError(null), { key: 'auth.errorGeneric' });
    assert.deepEqual(describeClerkError({}), { key: 'auth.errorGeneric' });
  });
});
```

Create `lib/authToken.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { currentToken, registerTokenGetter, sendWithAuthRetry, type TokenGetter } from './authToken';

function recordingGetter(tokens: { cached: string | null; fresh: string | null }) {
  const calls: (boolean | undefined)[] = [];
  const getter: TokenGetter = async (options) => {
    calls.push(options?.skipCache);
    return options?.skipCache ? tokens.fresh : tokens.cached;
  };
  return { getter, calls };
}

function recordingSend(statuses: number[]) {
  const tokens: (string | null)[] = [];
  const send = async (token: string | null) => {
    tokens.push(token);
    return { status: statuses[tokens.length - 1] ?? 200 };
  };
  return { send, tokens };
}

test('authToken', async (t) => {
  t.afterEach(() => registerTokenGetter(null));

  await t.test('no getter registered means no token', async () => {
    assert.equal(await currentToken(), null);
  });

  await t.test('a getter that throws yields null instead of an error', async () => {
    registerTokenGetter(async () => {
      throw new Error('clerk offline');
    });
    assert.equal(await currentToken(), null);
  });

  await t.test('a success is sent once with the cached token', async () => {
    const { getter, calls } = recordingGetter({ cached: 'cached', fresh: 'fresh' });
    registerTokenGetter(getter);
    const { send, tokens } = recordingSend([200]);
    const response = await sendWithAuthRetry(send);
    assert.equal(response.status, 200);
    assert.deepEqual(tokens, ['cached']);
    assert.deepEqual(calls, [undefined]);
  });

  await t.test('a 401 retries exactly once with a fresh token', async () => {
    const { getter, calls } = recordingGetter({ cached: 'stale', fresh: 'fresh' });
    registerTokenGetter(getter);
    const { send, tokens } = recordingSend([401, 200]);
    const response = await sendWithAuthRetry(send);
    assert.equal(response.status, 200);
    assert.deepEqual(tokens, ['stale', 'fresh']);
    assert.deepEqual(calls, [undefined, true]);
  });

  await t.test('a second 401 is returned, not retried again', async () => {
    registerTokenGetter(recordingGetter({ cached: 'stale', fresh: 'fresh' }).getter);
    const { send, tokens } = recordingSend([401, 401, 200]);
    const response = await sendWithAuthRetry(send);
    assert.equal(response.status, 401);
    assert.equal(tokens.length, 2);
  });

  await t.test('signed out (no fresh token) returns the first 401 without resending', async () => {
    registerTokenGetter(recordingGetter({ cached: null, fresh: null }).getter);
    const { send, tokens } = recordingSend([401]);
    const response = await sendWithAuthRetry(send);
    assert.equal(response.status, 401);
    assert.deepEqual(tokens, [null]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --test lib/authUser.test.ts lib/clerkErrors.test.ts lib/authToken.test.ts`
Expected: FAIL — `Cannot find module './authUser'` (and the other two).

- [ ] **Step 3: Add the i18n keys**

In `lib/i18n/en.ts`, change `'auth.errorPasswordTooShort'` to `'Password must be at least 8 characters.'` (Clerk's default minimum) and add after `'auth.errorEmailTaken'`:

```ts
  'auth.continueWithGoogle': 'Continue with Google',
  'auth.or': 'or',
  'auth.verifyTitle': 'Check your email',
  'auth.verifyHint': 'We sent a 6-digit code to {email}.',
  'auth.codeLabel': 'Verification code',
  'auth.codePlaceholder': 'Enter the code',
  'auth.verifyButton': 'Verify',
  'auth.verifying': 'Verifying...',
  'auth.resendCode': 'Resend code',
  'auth.codeResent': 'A new code is on its way.',
  'auth.backToForm': 'Back',
  'auth.errorPasswordIncorrect': 'That password is incorrect. Try again.',
  'auth.errorAccountNotFound': 'No account found with this email.',
  'auth.errorPasswordPwned': 'This password has appeared in a data breach. Please choose another.',
  'auth.errorCodeIncorrect': 'That code is incorrect.',
  'auth.errorCodeExpired': 'That code has expired. Request a new one.',
  'auth.errorTooManyAttempts': 'Too many attempts. Please wait a moment and try again.',
  'auth.errorGeneric': 'Something went wrong. Please try again.',
```

In `lib/i18n/vi.ts`, change `'auth.errorPasswordTooShort'` to `'Mật khẩu phải có ít nhất 8 ký tự.'` and add:

```ts
  'auth.continueWithGoogle': 'Tiếp tục với Google',
  'auth.or': 'hoặc',
  'auth.verifyTitle': 'Kiểm tra email của bạn',
  'auth.verifyHint': 'Chúng tôi đã gửi mã 6 chữ số tới {email}.',
  'auth.codeLabel': 'Mã xác minh',
  'auth.codePlaceholder': 'Nhập mã',
  'auth.verifyButton': 'Xác minh',
  'auth.verifying': 'Đang xác minh...',
  'auth.resendCode': 'Gửi lại mã',
  'auth.codeResent': 'Mã mới đang được gửi tới bạn.',
  'auth.backToForm': 'Quay lại',
  'auth.errorPasswordIncorrect': 'Mật khẩu không đúng. Vui lòng thử lại.',
  'auth.errorAccountNotFound': 'Không tìm thấy tài khoản với email này.',
  'auth.errorPasswordPwned': 'Mật khẩu này đã bị lộ trong một vụ rò rỉ dữ liệu. Vui lòng chọn mật khẩu khác.',
  'auth.errorCodeIncorrect': 'Mã không đúng.',
  'auth.errorCodeExpired': 'Mã đã hết hạn. Vui lòng yêu cầu mã mới.',
  'auth.errorTooManyAttempts': 'Bạn đã thử quá nhiều lần. Vui lòng đợi một lát rồi thử lại.',
  'auth.errorGeneric': 'Đã có lỗi xảy ra. Vui lòng thử lại.',
```

Check how `{email}` placeholders are written in existing keys (e.g. `'voice.detailHttp': 'Voice service returned HTTP {status}'`) — this matches.

- [ ] **Step 4: Implement the three modules**

Create `lib/authUser.ts`:

```ts
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
```

Create `lib/clerkErrors.ts`:

```ts
import type { TranslationKey } from './i18n/en';

/**
 * Clerk error codes the sign-in screen can say something useful about, in the
 * user's language. Anything else falls back to Clerk's own (English) message.
 */
const KEY_FOR_CODE: Record<string, TranslationKey> = {
  form_password_incorrect: 'auth.errorPasswordIncorrect',
  form_identifier_not_found: 'auth.errorAccountNotFound',
  form_identifier_exists: 'auth.errorEmailTaken',
  form_password_pwned: 'auth.errorPasswordPwned',
  form_password_length_too_short: 'auth.errorPasswordTooShort',
  form_code_incorrect: 'auth.errorCodeIncorrect',
  verification_failed: 'auth.errorCodeIncorrect',
  verification_expired: 'auth.errorCodeExpired',
  too_many_requests: 'auth.errorTooManyAttempts',
};

export type AuthErrorMessage = { key: TranslationKey } | { text: string };

interface ApiErrorLike {
  code?: unknown;
  message?: unknown;
  longMessage?: unknown;
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

/**
 * Turns whatever a Clerk call returned or threw into something to show. Duck-typed
 * on purpose: Clerk's error classes differ between a ClerkAPIResponseError (the
 * detail is in `errors[0]`) and a ClerkError (the detail is on the object).
 */
export function describeClerkError(error: unknown): AuthErrorMessage {
  if (!error || typeof error !== 'object') return { key: 'auth.errorGeneric' };

  const outer = error as ApiErrorLike & { errors?: unknown };
  const first = Array.isArray(outer.errors) ? (outer.errors[0] as ApiErrorLike | undefined) : undefined;

  for (const code of [str(first?.code), str(outer.code)]) {
    if (code && KEY_FOR_CODE[code]) return { key: KEY_FOR_CODE[code] };
  }

  const text =
    str(first?.longMessage) ?? str(first?.message) ?? str(outer.longMessage) ?? str(outer.message);
  return text ? { text } : { key: 'auth.errorGeneric' };
}
```

Create `lib/authToken.ts`:

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS (existing suites plus the three new ones). Typecheck may still report `vi.ts` missing keys if `vi` is typed against `TranslationKey` — fix by adding any key you missed.

- [ ] **Step 6: Commit**

```bash
git add lib/authUser.ts lib/authUser.test.ts lib/clerkErrors.ts lib/clerkErrors.test.ts lib/authToken.ts lib/authToken.test.ts lib/i18n/en.ts lib/i18n/vi.ts
git commit -m "Add provider-neutral auth helpers for the Clerk switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Wire Clerk into the app (provider, context, API client, voice token)

**Files:**
- Modify: `package.json` / `package-lock.json` (add `@clerk/expo`)
- Modify: `lib/env.ts`, `.env.example`
- Modify: `app/_layout.tsx`
- Modify: `lib/AuthContext.tsx` (rewrite)
- Modify: `lib/api.ts` (imports, `accessToken`, `attemptFetch`, header comment)
- Modify: `lib/livekitToken.ts`
- Modify: `app/(tabs)/settings.tsx` (~lines 25, 48-90)
- Modify: `components/HeaderSection.tsx` (~line 14)

**Interfaces:**
- Consumes: `toAppUser`, `authGateState`, `AppUser` (Task 5); `registerTokenGetter`, `sendWithAuthRetry` (Task 5); `POST /voice/token` response shape (Task 3).
- Produces: `useAuth(): { user: AppUser | null; loading: boolean; signOut(): Promise<void>; updateDisplayName(name: string): Promise<void> }`; `env.clerkPublishableKey: string`.

At the end of this task `components/Auth.tsx` still uses `lib/supabase.ts`; that is replaced in Task 7, so keep the Supabase env vars and `lib/supabase.ts` for now.

- [ ] **Step 1: Install Clerk**

Run: `npx expo install @clerk/expo`
Expected: `package.json` gains `"@clerk/expo": "^4.x"`. Its peers `expo-secure-store`, `expo-web-browser`, `expo-auth-session`, `expo-crypto`, `expo-constants` are already installed; the optional ones (passkeys, Google native sign-in, Apple) are not needed.

- [ ] **Step 2: Add the publishable key to `lib/env.ts`**

In `raw`, add `clerkPublishableKey: process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,`. In `REQUIRED`, add `clerkPublishableKey: 'EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY',`. In `env`, add `clerkPublishableKey: raw.clerkPublishableKey as string,`. Update the header comment's last paragraph to: "Nothing secret belongs here: EXPO_PUBLIC_* values ship inside the JS bundle and are readable by anyone with the app. The API's token check is what guards the data."

Add to `.env.example` (root):

```bash
# Clerk publishable key (Clerk dashboard > API keys). Public by design.
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
```

Set a real value in your local `.env`, then restart the dev server.

- [ ] **Step 3: Rewrite `lib/AuthContext.tsx`**

```tsx
import React, { createContext, useContext, useEffect } from 'react';
import { useAuth as useClerkAuth, useClerk, useUser } from '@clerk/expo';
import { registerTokenGetter } from './authToken';
import { authGateState, toAppUser, type AppUser } from './authUser';

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
    updateDisplayName: async (name: string) => {
      if (!clerkUser) return;
      await clerkUser.update({
        unsafeMetadata: { ...clerkUser.unsafeMetadata, display_name: name },
      });
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
```

Note: the previous default context value is replaced by `null` + the throw, which is what the old `useAuth` already claimed to do.

- [ ] **Step 4: Add `ClerkProvider` to `app/_layout.tsx`**

Add imports:

```tsx
import { ClerkProvider } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import { env } from '../lib/env';
```

Wrap `<AuthProvider>` (keep everything inside unchanged):

```tsx
        <SafeAreaProvider>
          {/* Outermost auth layer: AuthProvider reads Clerk's hooks. The token
              cache keeps the session in expo-secure-store across launches. */}
          <ClerkProvider publishableKey={env.clerkPublishableKey} tokenCache={tokenCache}>
            <AuthProvider>
              {/* …unchanged… */}
            </AuthProvider>
          </ClerkProvider>
        </SafeAreaProvider>
```

- [ ] **Step 5: Switch `lib/api.ts` to the token bridge**

1. Replace `import { supabase } from './supabase';` with `import { sendWithAuthRetry } from './authToken';`.
2. In the file header comment, replace "behind a Supabase access token" with "behind a Clerk session token".
3. Delete the `accessToken()` function and its comment.
4. Replace the start of `attemptFetch` — from `let response = await request(path, init, await accessToken());` through the closing brace of the `if (response.status === 401) { … }` block — with:

```ts
  // One retry on a 401 with a freshly minted token (see authToken.ts). A second
  // 401 surfaces as an error; AuthContext is what routes a signed-out user back
  // to the sign-in screen.
  const response = await sendWithAuthRetry((token) => request(path, init, token));
```

5. Update the `apiFetch` doc comment sentence "A 401 is retried exactly once against a force-refreshed session" to "A 401 is retried exactly once with a freshly minted Clerk token".

Run: `grep -n "supabase" lib/api.ts` — expected: no output.

- [ ] **Step 6: Point `lib/livekitToken.ts` at the API**

1. Replace the two Supabase imports with `import { apiFetch, ApiError } from './api';`.
2. Replace `describeFunctionError` with:

```ts
/** The API's error text plus the status, which is what a bug report needs. */
function describeTokenError(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (HTTP ${error.status})`;
  return errorMessage(error, t('voice.detailTokenFailed'));
}
```

3. In `fetchToken`, replace the `supabase.functions.invoke` call and the `if (fnError) throw fnError;` line with:

```ts
      const data = await apiFetch<LiveKitCredentials>('/voice/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipeId }),
      });
```

4. In the `catch`, change `await describeFunctionError(e)` to `describeTokenError(e)`.
5. Update the hook's doc comment: "Fetches a per-user, per-recipe LiveKit token from the API (`POST /voice/token`). The room and identity are decided server-side from the caller's Clerk session, so two users never land in the same room."

Run: `grep -n "supabase\|FunctionsHttpError" lib/livekitToken.ts` — expected: no output.

- [ ] **Step 7: Update the two display-name consumers**

In `app/(tabs)/settings.tsx`:
- Delete `import { supabase } from '../../lib/supabase';`.
- Change `const { signOut, user } = useAuth();` to `const { signOut, user, updateDisplayName } = useAuth();`.
- Change `const storedName = (user?.user_metadata?.display_name as string | undefined) ?? '';` to `const storedName = user?.displayName ?? '';`.
- In `handleSaveName`, replace the comment and the two lines calling `supabase.auth.updateUser` / `if (error) throw error;` with:

```ts
      // Clerk re-renders AuthContext with the updated user, so nothing here
      // has to write it back into state.
      await updateDisplayName(next);
```

In `components/HeaderSection.tsx`, change `const displayName = (user?.user_metadata?.display_name as string | undefined)?.trim();` to `const displayName = user?.displayName;`.

Run: `grep -rn "user_metadata\|supabase" app components lib --include='*.ts' --include='*.tsx' | grep -v "lib/supabase.ts\|components/Auth.tsx"` — expected: no output (only `Auth.tsx` and `lib/supabase.ts` still mention Supabase).

- [ ] **Step 8: Verify**

Run: `npm run typecheck && npm test && npm run env:check`
Expected: all clean.

Smoke check: `npm run web`, confirm the app boots to the sign-in screen with no red error (sign-in itself is Task 7). Stop the server.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json lib/env.ts .env.example app/_layout.tsx lib/AuthContext.tsx lib/api.ts lib/livekitToken.ts "app/(tabs)/settings.tsx" components/HeaderSection.tsx
git commit -m "Run the app's session on Clerk and fetch voice tokens from the API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Sign-in screen on Clerk (email + password, code step, Google)

**Files:**
- Modify: `components/Auth.tsx` (imports, state, handlers ~lines 1-120; JSX ~lines 125-335; new styles)
- Create: `app/sso-callback.tsx`

**Interfaces:**
- Consumes: `describeClerkError` (Task 5); i18n keys (Task 5); `ClerkProvider` in the tree (Task 6).
- Clerk Core 3 API used (from `@clerk/expo`): `useSignIn()` → `{ signIn }` with `signIn.password({ identifier, password })`, `signIn.status`, `signIn.mfa.sendEmailCode()`, `signIn.mfa.verifyEmailCode({ code })`, `signIn.finalize()`; `useSignUp()` → `{ signUp }` with `signUp.password({ emailAddress, password })`, `signUp.verifications.sendEmailCode()`, `signUp.verifications.verifyEmailCode({ code })`, `signUp.status`, `signUp.finalize()`; `useSSO()` → `{ startSSOFlow({ strategy, redirectUrl }) }` returning `{ createdSessionId, setActive }`. Every Core 3 method resolves to `{ error: ClerkError | null }` rather than throwing.

- [ ] **Step 1: Add the SSO callback route**

Create `app/sso-callback.tsx`:

```tsx
import { Redirect } from 'expo-router';

/**
 * Google sign-in returns to cookmate://sso-callback. The browser session hands
 * the result to Clerk before this renders; the route only exists so the deep
 * link lands somewhere instead of on Expo Router's unmatched-route screen.
 */
export default function SsoCallback() {
  return <Redirect href="/" />;
}
```

- [ ] **Step 2: Replace imports, state and handlers in `components/Auth.tsx`**

Replace the import `import { supabase } from '../lib/supabase';` with:

```tsx
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { useSignIn, useSignUp, useSSO } from '@clerk/expo';
import { describeClerkError } from '../lib/clerkErrors';
```

Add `useEffect` to the React import: `import React, { useEffect, useState } from 'react';`.

Right below the `devEmail`/`devPassword` constants add:

```tsx
// Lets the OAuth browser session hand its result back on web; a no-op on native.
WebBrowser.maybeCompleteAuthSession();
```

Inside `Auth()`, after the existing `useState` declarations, add:

```tsx
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const { startSSOFlow } = useSSO();
  // The code step serves both a new account's email verification and a
  // new-device check on sign-in; `codeFor` says which one to finish.
  const [step, setStep] = useState<'form' | 'code'>('form');
  const [codeFor, setCodeFor] = useState<'signIn' | 'signUp'>('signUp');
  const [code, setCode] = useState('');

  // Android opens Custom Tabs noticeably faster when warmed up first.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);

  function showError(error: unknown) {
    const described = describeClerkError(error);
    setMessage({ kind: 'error', text: 'key' in described ? t(described.key) : described.text });
  }

  function openCodeStep(target: 'signIn' | 'signUp') {
    setCodeFor(target);
    setCode('');
    setStep('code');
  }
```

In `validate()`, change the sign-up length check and its comment to:

```tsx
      // Clerk's default minimum; checked here so the user gets it in their language.
      if (password.length < 8) return t('auth.errorPasswordTooShort');
```

Replace `signInWithEmail` and `signUpWithEmail` entirely with:

```tsx
  async function signInWithEmail() {
    Keyboard.dismiss();
    setLoading(true);
    setMessage(null);
    try {
      const { error } = await signIn.password({ identifier: email.trim(), password });
      if (error) return showError(error);
      await continueSignIn();
    } finally {
      setLoading(false);
    }
  }

  /** Finishes a sign-in whose password (or code) was accepted, or asks for a code. */
  async function continueSignIn() {
    if (signIn.status === 'complete') {
      const { error } = await signIn.finalize();
      if (error) showError(error);
      return;
    }
    // A new device (Clerk "client trust") or an email second factor.
    if (signIn.status === 'needs_client_trust' || signIn.status === 'needs_second_factor') {
      const { error } = await signIn.mfa.sendEmailCode();
      if (error) return showError(error);
      openCodeStep('signIn');
      return;
    }
    showError(null);
  }

  async function signUpWithEmail() {
    Keyboard.dismiss();
    setLoading(true);
    setMessage(null);
    try {
      const { error } = await signUp.password({ emailAddress: email.trim(), password });
      if (error) return showError(error);
      const { error: sendError } = await signUp.verifications.sendEmailCode();
      if (sendError) return showError(sendError);
      openCodeStep('signUp');
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode() {
    if (loading) return;
    if (!code.trim()) {
      setMessage({ kind: 'error', text: t('auth.errorCodeIncorrect') });
      return;
    }
    Keyboard.dismiss();
    setLoading(true);
    setMessage(null);
    try {
      if (codeFor === 'signUp') {
        const { error } = await signUp.verifications.verifyEmailCode({ code: code.trim() });
        if (error) return showError(error);
        if (signUp.status !== 'complete') return showError(null);
        const { error: finalizeError } = await signUp.finalize();
        if (finalizeError) showError(finalizeError);
      } else {
        const { error } = await signIn.mfa.verifyEmailCode({ code: code.trim() });
        if (error) return showError(error);
        await continueSignIn();
      }
    } finally {
      setLoading(false);
    }
  }

  async function resendCode() {
    if (loading) return;
    setMessage(null);
    const { error } =
      codeFor === 'signUp' ? await signUp.verifications.sendEmailCode() : await signIn.mfa.sendEmailCode();
    if (error) showError(error);
    else setMessage({ kind: 'info', text: t('auth.codeResent') });
  }

  function backToForm() {
    setStep('form');
    setCode('');
    setMessage(null);
  }

  async function signInWithGoogle() {
    if (loading) return;
    setLoading(true);
    setMessage(null);
    try {
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy: 'oauth_google',
        redirectUrl: AuthSession.makeRedirectUri({ scheme: 'cookmate', path: 'sso-callback' }),
      });
      // No session means the user closed the browser: stay put, say nothing.
      if (createdSessionId && setActive) await setActive({ session: createdSessionId });
    } catch (error) {
      showError(error);
    } finally {
      setLoading(false);
    }
  }
```

Also in `switchMode()`, add `setStep('form');` so switching between sign-in and sign-up always shows the form.

- [ ] **Step 3: Add the code step and Google button to the JSX**

In the content section, the title/subtitle/message block stays. Directly after the `{message && (...)}` block, wrap the existing form (from `{/* Email Input */}` down to and including the `{/* Sign Up Link */}` `TouchableOpacity`) in `{step === 'form' ? ( <> …existing form… </> ) : ( …code step… )}`, where the code step is:

```tsx
              <>
                <Text style={styles.welcomeTitle}>{t('auth.verifyTitle')}</Text>
                <Text style={styles.welcomeSubtitle}>
                  {t('auth.verifyHint', { email: email.trim() })}
                </Text>

                <View style={styles.inputSection}>
                  <Text style={styles.inputLabel}>{t('auth.codeLabel')}</Text>
                  <View style={[styles.inputContainer, styles.inputContainerFocused]}>
                    <Ionicons name="key-outline" size={18} color="#9CA3AF" style={styles.inputIcon} />
                    <TextInput
                      style={styles.textInput}
                      value={code}
                      onChangeText={setCode}
                      placeholder={t('auth.codePlaceholder')}
                      placeholderTextColor="#9CA3AF"
                      keyboardType="number-pad"
                      autoComplete="one-time-code"
                      textContentType="oneTimeCode"
                      maxLength={6}
                      autoFocus
                      onSubmitEditing={verifyCode}
                      returnKeyType="go"
                    />
                  </View>
                </View>

                <TouchableOpacity
                  style={[styles.signInButton, loading && styles.buttonDisabled]}
                  disabled={loading}
                  onPress={verifyCode}>
                  <LinearGradient
                    colors={['#FF8A65', '#FF7043']}
                    style={styles.signInButtonGradient}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}>
                    <Text style={styles.signInButtonText}>
                      {loading ? t('auth.verifying') : t('auth.verifyButton')}
                    </Text>
                  </LinearGradient>
                </TouchableOpacity>

                <View style={styles.codeActionsRow}>
                  <TouchableOpacity disabled={loading} onPress={backToForm}>
                    <Text style={styles.signUpText}>{t('auth.backToForm')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity disabled={loading} onPress={resendCode}>
                    <Text style={styles.signUpLink}>{t('auth.resendCode')}</Text>
                  </TouchableOpacity>
                </View>
              </>
```

Hide the top title/subtitle while on the code step so it is not shown twice: wrap the existing `welcomeTitle` and `welcomeSubtitle` `<Text>`s in `{step === 'form' && ( <> … </> )}`.

Inside the form branch, directly before `{/* Email Input */}`, add the Google button and divider:

```tsx
                <TouchableOpacity
                  style={[styles.googleButton, loading && styles.buttonDisabled]}
                  disabled={loading}
                  onPress={signInWithGoogle}>
                  <Ionicons name="logo-google" size={18} color="#1F2937" />
                  <Text style={styles.googleButtonText}>{t('auth.continueWithGoogle')}</Text>
                </TouchableOpacity>

                <View style={styles.dividerRow}>
                  <View style={styles.dividerLine} />
                  <Text style={styles.dividerText}>{t('auth.or')}</Text>
                  <View style={styles.dividerLine} />
                </View>
```

Add to the `StyleSheet.create({ … })` object:

```tsx
  googleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    height: 52,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
    marginBottom: 20,
  },
  googleButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1F2937',
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 20,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#E5E7EB',
  },
  dividerText: {
    fontSize: 13,
    color: '#9CA3AF',
  },
  codeActionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 20,
  },
```

(Match `height`/`borderRadius` to the existing `inputContainer` style if they differ, so the button lines up with the inputs.)

- [ ] **Step 4: Verify types and remaining Supabase use**

Run: `npm run typecheck && grep -n "supabase" components/Auth.tsx`
Expected: typecheck clean; grep prints nothing. If typecheck flags `t('auth.verifyHint', { email })`, check the translator's values type in `lib/i18n/phrase.ts` and pass `{ email: email.trim() }` in whatever shape it expects.

- [ ] **Step 5: Configure the Clerk dev instance (one-time, manual)**

In the Clerk dashboard for the development instance:
1. **User & authentication → Email, phone, username**: email address on, "Verify at sign-up" with email code; password on.
2. **SSO connections**: add Google (dev instances can use Clerk's shared credentials).
3. **Native applications**: add iOS and Android `com.kpmquockhanh.cookmate`; add `cookmate://sso-callback` to the allowlisted redirect URLs.
4. **Sessions → Customize session token**: `{ "email": "{{user.primary_email_address}}", "name": "{{user.full_name}}" }`.
5. Copy the publishable key into root `.env` and the Frontend API URL into `backend/.env` as `CLERK_ISSUER`; set `CLERK_AUTHORIZED_PARTIES=http://localhost:8081` for web.

- [ ] **Step 6: Manual check on web**

Run the API (`cd backend && npm run api:dev`) and the app (`npm run web`). Check:
1. Sign up with `yourname+clerk_test@example.com`, password of 8+ characters; the code step appears; code `424242` signs you in.
2. Sign out from Settings; sign back in with the same password (a code step may appear for the new device — `424242` again).
3. Wrong password shows the translated "That password is incorrect" message; switch the app to Vietnamese and see it in Vietnamese.
4. "Continue with Google" completes and lands on the home screen. **If Google does not work on web**, note it and continue; report it in the final summary rather than changing the flow (the spec's manual checklist covers it).

- [ ] **Step 7: Commit**

```bash
git add components/Auth.tsx app/sso-callback.tsx
git commit -m "Move the sign-in screen onto Clerk and add Google sign-in

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Remove Supabase from the app and delete the edge function

**Files:**
- Delete: `lib/supabase.ts`, `supabase/functions/` (whole folder)
- Modify: `lib/env.ts`, `.env.example`, `package.json` / `package-lock.json`
- Modify: comments mentioning Supabase in `lib/log.ts`, `lib/voiceSession.ts`, `lib/connectivity.ts`, `hooks/useRecipe.ts`, `hooks/useRecipes.ts`

**Interfaces:**
- Consumes: Tasks 6 and 7 (nothing imports `lib/supabase.ts` any more). Produces: nothing new.

- [ ] **Step 1: Confirm nothing imports the Supabase client**

Run: `grep -rn "lib/supabase\|from './supabase'\|from '../lib/supabase'\|@supabase/supabase-js" app components hooks lib`
Expected: only `lib/supabase.ts` itself. If anything else shows up, it was missed in Task 6/7 — fix it there first.

- [ ] **Step 2: Delete and uninstall**

```bash
git rm lib/supabase.ts
git rm -r supabase/functions
npm uninstall @supabase/supabase-js
```

Then check the URL polyfill: `grep -rn "react-native-url-polyfill" app components hooks lib`. If there is no output, run `npm uninstall react-native-url-polyfill`; otherwise keep it. Leave `@react-native-async-storage/async-storage` installed — settings, shopping, timers and recent-cooking use it.

- [ ] **Step 3: Drop the Supabase env vars from the app**

In `lib/env.ts`, remove `supabaseUrl` and `supabasePublishableKey` from `raw`, `REQUIRED` and `env`. In the header comment, change "a non-null assertion in lib/supabase.ts" to "a non-null assertion in the old Supabase client". In root `.env.example`, delete the `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` lines and their comments. Remove them from your local `.env` too.

- [ ] **Step 4: Fix stale comments**

Run: `grep -rn -i "supabase" app components hooks lib`
For each hit in a comment (e.g. `hooks/useRecipes.ts:2` "attaches the caller's Supabase access token"), change "Supabase access token" / "Supabase session" to "Clerk session token" / "Clerk session". Leave `EXPO_PUBLIC_STORAGE_URL`-related comments that describe the Supabase *storage* bucket — storage still lives there until sub-project 2.
Expected after edits: remaining hits refer only to storage.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test && npm run env:check && (cd backend && npm run typecheck && npm test) && (cd agent && npm run typecheck && npm test)`
Expected: all clean. Also `npm run web` still boots and signs in.

- [ ] **Step 6: Commit**

```bash
git add -A lib app components hooks package.json package-lock.json .env.example
git status --short   # confirm README.md, CLAUDE.md, backend/CLAUDE.md are NOT staged
git commit -m "Remove Supabase Auth from the app and delete the livekit-token edge function

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If `git status` shows any of `README.md`, `CLAUDE.md`, `backend/CLAUDE.md` staged, unstage them with `git restore --staged <file>` before committing.

---

### Task 9: Docs and end-to-end verification

**Files:**
- Modify: `backend/README.md` (auth / env / seed-auth sections)
- Modify (leave uncommitted, see below): `CLAUDE.md`, `backend/CLAUDE.md`, `README.md`

**Interfaces:** none.

- [ ] **Step 1: Update `backend/README.md`**

Search it: `grep -n -i "supabase_jwt\|seed-auth\|seed:auth\|access token\|auth" backend/README.md`. For each hit:
- Auth section: the API verifies Clerk session tokens against `${CLERK_ISSUER}/.well-known/jwks.json` (RS256 only), checks `iss`, and checks `azp` against `CLERK_AUTHORIZED_PARTIES` for web tokens. 401 reasons unchanged.
- Env table: add `CLERK_ISSUER`, `CLERK_AUTHORIZED_PARTIES`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`; remove `SUPABASE_JWT_SECRET`; mark `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` as storage-only.
- Add a `POST /voice/token` entry to the route list (body `{ recipeId }`, response `{ data: { token, serverUrl, roomName, identity, expiresAt } }`).
- Remove the `seed-auth` instructions; replace with: "Test users: in a Clerk development instance, any `+clerk_test` email address signs in with verification code `424242`."

```bash
git add backend/README.md
git commit -m "Document Clerk auth and the voice token route in the backend README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Update the files that hold the user's uncommitted work**

`CLAUDE.md` and `backend/CLAUDE.md` are untracked and `README.md` has uncommitted edits by the user. Edit them, but **do not commit them** — report the edits so the user can commit them with their own changes.

- `CLAUDE.md`:
  - Repository layout: remove the `supabase/functions/livekit-token/` bullet; in the Root bullet, change "Supabase auth" to "Clerk auth".
  - The "…READMEs are authoritative" sentence: drop `supabase/functions/livekit-token/README.md`.
  - App ↔ backend, first bullet: "attaches the Clerk session token (via `lib/authToken.ts`, which `AuthContext` feeds), retries once on 401 with a freshly minted token, …".
  - `lib/env.ts` bullet: unchanged except nothing else.
  - Provider tree: `ClerkProvider → AuthProvider → SettingsProvider → ShoppingProvider → FavoritesProvider → TimerProvider`.
  - Voice pipeline step 1: "The cooking screen gets a token from the API's `POST /voice/token` (`lib/livekitToken.ts`, route in `backend/src/api/routes/voice.ts`). … That name must match `agent/src/constants.ts` **and** `AGENT_NAME` in `backend/src/api/routes/voice.ts` or no agent ever joins."
- `backend/CLAUDE.md`: if it mentions Supabase auth, `SUPABASE_JWT_SECRET`, `seed-auth` or `auth.uid()`, update them to match the above.
- `README.md`: add a short "Clerk setup" section containing the five dashboard steps from Task 7 Step 5, plus: "Production: create a production instance with its own Google OAuth credentials and put its Frontend API URL in `CLERK_ISSUER`. Sign in with Apple is a planned follow-up (App Store guideline 4.8)."

- [ ] **Step 3: Full verification**

Run:

```bash
npm run typecheck && npm test && npm run env:check
(cd backend && npm run typecheck && npm test)
(cd agent && npm run typecheck && npm test)
```

Expected: all pass. With a database, also `cd backend && npm run setup && npx tsx --test test/api.test.ts`.

Manual, on the iOS dev build (`npm run ios` — needed because a native dependency was added) and on web (`npm run web`), with the API running and `LIVEKIT_*` set in `backend/.env`:
1. Sign up with a `+clerk_test` email and code `424242`; sign out; sign back in.
2. Sign in with Google.
3. Rename in Settings; the home header greets you by the new name.
4. Favourite a recipe; it is still favourited after a reload.
5. Open a recipe, start cooking; the agent joins (the agent worker must be running: `cd agent && npm run dev`).
6. Leave the app idle for more than 60 seconds, then open another recipe — it loads (token refresh works).

Report each check's result. For any failure, include what happened; do not mark the task done.
