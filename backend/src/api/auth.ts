import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { env } from '../env.js';
import { logger } from '../log.js';

const log = logger('auth');

/**
 * Every route is authenticated except these. The guard is a root-level hook
 * rather than a per-route preHandler on purpose: a new route is protected the
 * moment it is registered, and opening one up has to be a deliberate edit here.
 */
const PUBLIC_ROUTES = new Set(['/health']);

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
  if (env.clerkAuthorizedParties.length === 0) {
    log.warn('CLERK_AUTHORIZED_PARTIES is empty: web clients (tokens with azp) will be rejected');
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
      requiredClaims: ['exp', 'sub'],
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
