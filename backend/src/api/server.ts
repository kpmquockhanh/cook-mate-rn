import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { query } from '../db.js';
import { env } from '../env.js';
import { logger } from '../log.js';
import { registerAuth } from './auth.js';
import { recipeRoutes } from './routes/recipes.js';

const log = logger('api');

/**
 * Builds the app but deliberately does NOT listen - that is what lets the tests
 * drive routes through app.inject() with no port and no network.
 */
export async function buildServer(): Promise<FastifyInstance> {
  // Fastify's own logger is off; this repo already has one (src/log.ts) and two
  // log formats interleaved on stdout helps nobody.
  const app = Fastify({ logger: false });

  // The web build is a cross-origin caller, so this is load-bearing, not
  // boilerplate. Lock the origin down in production via API_CORS_ORIGIN.
  //
  // `methods` is spelled out because @fastify/cors 11 defaults it to
  // GET,HEAD,POST: leave it off and the preflight for the favourite routes
  // answers without PUT/DELETE, so the browser blocks the real request and the
  // app only sees an opaque "NetworkError".
  await app.register(cors, {
    origin: env.apiCorsOrigin,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // These must come BEFORE the routes are registered. `await app.register()`
  // boots the plugin straight away, and the child context captures whichever
  // error handler is in force at that moment - set it after and it silently
  // never applies, leaking Fastify's default body (which includes the message).
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'Invalid query parameters', issues: error.issues });
    }
    const failure = error as { message?: string; stack?: string; statusCode?: number };
    log.error(failure.message ?? 'unknown error', failure.stack);
    // Never echo the message back - it can carry SQL text or connection details.
    return reply.code(failure.statusCode ?? 500).send({ error: 'Internal error' });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'Not found' });
  });

  // Before the routes, not after: this installs a root-level onRequest hook, and
  // only the child contexts registered after it inherit the hook. Registering a
  // route above this line would silently leave it unauthenticated.
  registerAuth(app);

  // Public by design (see PUBLIC_ROUTES in auth.ts) - a load balancer probe has
  // no session to present, and it reveals nothing beyond "the database answers".
  app.get('/health', async () => {
    await query('select 1');
    return { ok: true };
  });

  await app.register(recipeRoutes);

  return app;
}
