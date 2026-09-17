import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../env.js';
import { logger } from '../log.js';

const log = logger('auth');

/**
 * Every route is authenticated except these. The guard is a root-level hook
 * rather than a per-route preHandler on purpose: a new route is protected the
 * moment it is registered, and opening one up has to be a deliberate edit here.
 */
const PUBLIC_ROUTES = new Set(['/health']);

/** The subset of the Supabase access token the app actually acts on. */
export interface AuthenticatedUser {
  /** auth.users.id - the uuid to key any per-user row on. */
  id: string;
  email: string | null;
  /** 'authenticated' for a signed-in user; 'anon' never reaches here. */
  role: string;
  /** GoTrue session id, useful for correlating logs with a single sign-in. */
  sessionId: string | null;
  claims: JWTPayload;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook. Non-null on every route outside PUBLIC_ROUTES. */
    user: AuthenticatedUser | null;
  }
}

type Reason = 'missing_token' | 'invalid_token' | 'token_expired';

class AuthError extends Error {
  constructor(
    readonly reason: Reason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Supabase signs access tokens one of two ways, and a project can be on either:
 *
 *   - asymmetric (ES256/RS256) with rotating JWT signing keys, published at the
 *     project's JWKS endpoint - this is the current default, and the reason
 *     SUPABASE_URL is enough on its own;
 *   - HS256 with the legacy project JWT secret, which has to be supplied as
 *     SUPABASE_JWT_SECRET.
 *
 * Resolving the key off the token header covers both without a mode switch, so
 * a project that rotates from one to the other keeps verifying through the
 * changeover instead of rejecting every live session.
 */
let jwksRef: ReturnType<typeof createRemoteJWKSet> | null = null;

function jwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwksRef) {
    // The set is cached in-process and only refetched when an unknown `kid`
    // shows up, with a cooldown so a bad token cannot turn into a fetch loop
    // against the auth server.
    jwksRef = createRemoteJWKSet(new URL(`${env.supabaseUrl}/auth/v1/.well-known/jwks.json`), {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
  }
  return jwksRef;
}

let hmacRef: Uint8Array | null = null;

function hmacKey(): Uint8Array {
  if (!hmacRef) hmacRef = new TextEncoder().encode(env.supabaseJwtSecret!);
  return hmacRef;
}

/**
 * Boot-time check so a misconfigured deploy fails on startup rather than 401ing
 * every request once it is already serving traffic.
 */
export function assertAuthConfigured(): void {
  if (!env.supabaseUrl && !env.supabaseJwtSecret) {
    throw new Error(
      'Auth is not configured: set SUPABASE_URL (asymmetric JWT signing keys) ' +
        'or SUPABASE_JWT_SECRET (legacy HS256). See backend/.env.example.',
    );
  }
}

/**
 * Verifies a Supabase access token locally. No call to GoTrue on the request
 * path - signature, issuer, audience and expiry are all checkable here, and a
 * per-request round trip to the auth server would put it in the critical path
 * of every read.
 */
export async function verifyAccessToken(token: string): Promise<AuthenticatedUser> {
  try {
    const { payload } = await jwtVerify(
      token,
      async (header, input) => {
        if (header.alg === 'HS256') {
          if (!env.supabaseJwtSecret) {
            throw new Error('token is HS256 but SUPABASE_JWT_SECRET is not set');
          }
          return hmacKey();
        }
        if (!env.supabaseUrl) {
          throw new Error(`token is ${header.alg} but SUPABASE_URL is not set`);
        }
        return jwks()(header, input);
      },
      {
        // GoTrue stamps `aud: 'authenticated'`. An anon-key JWT carries
        // `aud: 'anon'` and is not a user, so this is what keeps the
        // publishable/anon key from being usable as a login.
        audience: 'authenticated',
        // Only enforceable when we know the project URL; an HS256-only
        // deployment has nothing to compare against.
        ...(env.supabaseUrl ? { issuer: `${env.supabaseUrl}/auth/v1` } : {}),
        // Phones drift. Anything larger starts to matter for revocation.
        clockTolerance: 10,
      },
    );

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new AuthError('invalid_token', 'token has no subject');
    }

    return {
      id: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : null,
      role: typeof payload.role === 'string' ? payload.role : 'authenticated',
      sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
      claims: payload,
    };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    // Expiry is separated out because it is the one failure the client can fix
    // by itself: supabase-js refreshes and retries. Lumping it in with a bad
    // signature would make the app sign the user out instead.
    if (error instanceof joseErrors.JWTExpired) {
      throw new AuthError('token_expired', 'access token has expired');
    }
    throw new AuthError('invalid_token', error instanceof Error ? error.message : 'invalid token');
  }
}

/** `Authorization: Bearer <jwt>`, case-insensitively on the scheme. */
function bearer(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header) throw new AuthError('missing_token', 'no Authorization header');

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) throw new AuthError('missing_token', 'Authorization header is not a Bearer token');
  return match[1]!.trim();
}

function unauthorized(reply: FastifyReply, reason: Reason): FastifyReply {
  // WWW-Authenticate is what makes a 401 a well-formed one, and the app reads
  // `reason` to decide between "refresh and retry" and "sign out".
  return reply
    .code(401)
    .header('WWW-Authenticate', 'Bearer realm="cookmate"')
    .send({ error: 'Unauthorized', reason });
}

/**
 * Registers the guard. Must run before the routes: a root-level `onRequest`
 * hook applies to every child context registered after it, and a route
 * registered earlier would never see it.
 */
export function registerAuth(app: FastifyInstance): void {
  assertAuthConfigured();

  // Declared here so `request.user` exists (as null) on the public routes too,
  // instead of being an undefined property access.
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request, reply) => {
    // CORS preflight carries no Authorization header by definition; @fastify/cors
    // normally answers it before this hook, but never make the guard depend on
    // hook ordering.
    if (request.method === 'OPTIONS') return;

    // routeOptions.url is the route pattern ('/recipes/:id'), which is what the
    // allowlist is written against; the raw path is only a fallback for a
    // request that matched no route at all.
    const route = request.routeOptions?.url ?? request.url.split('?')[0]!;
    if (PUBLIC_ROUTES.has(route)) return;

    try {
      request.user = await verifyAccessToken(bearer(request));
    } catch (error) {
      const reason = error instanceof AuthError ? error.reason : 'invalid_token';
      // Logged at debug: a 401 is a normal event on a public endpoint, and the
      // message can carry token detail that has no business in an info log.
      log.debug(`401 ${request.method} ${request.url}: ${(error as Error).message}`);
      return unauthorized(reply, reason);
    }
  });
}

/**
 * Narrowing helper for route handlers. The hook guarantees a user on every
 * non-public route, but the type cannot know that.
 */
export function requireUser(request: FastifyRequest): AuthenticatedUser {
  if (!request.user) throw new Error('requireUser called on a route with no auth guard');
  return request.user;
}
