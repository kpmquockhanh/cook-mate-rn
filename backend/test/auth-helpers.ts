import { SignJWT } from 'jose';

/**
 * Fixed test config, applied by every suite that builds the server.
 *
 * These deliberately OVERRIDE whatever backend/.env holds: the auth tests must
 * behave the same on a laptop with a real project configured and in CI with
 * nothing configured, and HS256 means they never reach the network for a key.
 */
export const TEST_SUPABASE_URL = 'https://test-project.supabase.co';
export const TEST_JWT_SECRET = 'test-only-jwt-secret-not-used-anywhere-real';
export const TEST_ISSUER = `${TEST_SUPABASE_URL}/auth/v1`;
export const TEST_USER_ID = '11111111-2222-3333-4444-555555555555';

/** Call before the first `import('../src/...')` - src/env.ts reads process.env at load. */
export function applyTestAuthEnv(): void {
  process.env.SUPABASE_URL = TEST_SUPABASE_URL;
  process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
}

export interface TokenOverrides {
  sub?: string;
  email?: string;
  audience?: string;
  issuer?: string;
  secret?: string;
  /** Seconds from now. Negative mints an already-expired token. */
  expiresInSeconds?: number;
}

/**
 * Mints a token shaped like a Supabase access token. HS256 is one of the two
 * schemes the API accepts, so this exercises the real verification path rather
 * than a stub.
 */
export async function mintToken(overrides: TokenOverrides = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = overrides.expiresInSeconds ?? 3600;

  return new SignJWT({
    email: overrides.email ?? 'cook@example.com',
    role: 'authenticated',
    session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(overrides.sub ?? TEST_USER_ID)
    .setIssuer(overrides.issuer ?? TEST_ISSUER)
    .setAudience(overrides.audience ?? 'authenticated')
    .setIssuedAt(now)
    // setExpirationTime takes an absolute value here so a negative offset can
    // produce a token that is already expired, which is otherwise awkward to
    // build without sleeping.
    .setExpirationTime(now + expiresIn)
    .sign(new TextEncoder().encode(overrides.secret ?? TEST_JWT_SECRET));
}

/** `Authorization` header for a freshly minted valid token. */
export async function authHeaders(overrides: TokenOverrides = {}): Promise<{ authorization: string }> {
  return { authorization: `Bearer ${await mintToken(overrides)}` };
}
