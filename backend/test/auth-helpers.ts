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
