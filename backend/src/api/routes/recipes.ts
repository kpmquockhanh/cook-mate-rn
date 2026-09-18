import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  addFavorite,
  getRecipe,
  listRecipes,
  recordEvent,
  removeFavorite,
} from '../queries/recipes.js';
import { EventBody, IdParam, ListQuery } from '../schema.js';

/** Every route here is authenticated (see api/auth.ts), so this is never null. */
function userId(request: FastifyRequest): string {
  return request.user!.id;
}

export async function recipeRoutes(app: FastifyInstance): Promise<void> {
  // The client reads `json.data` but tolerates a bare array; the wrapper leaves
  // room for pagination metadata later without breaking it.
  app.get('/recipes', async (request) => {
    return { data: await listRecipes(ListQuery.parse(request.query), userId(request)) };
  });

  app.get('/recipes/:id', async (request, reply) => {
    const parsed = IdParam.safeParse(request.params);
    // A non-numeric id is a missing recipe, not a bad request - hooks/useRecipe.ts
    // maps 404 to "Recipe not found" and anything else to a raw status message.
    if (!parsed.success) {
      return reply.code(404).send({ error: 'Recipe not found' });
    }

    const recipe = await getRecipe(parsed.data.id, userId(request));
    if (!recipe) {
      return reply.code(404).send({ error: 'Recipe not found' });
    }
    return { data: recipe };
  });

  /**
   * Favouriting is a PUT/DELETE pair rather than a toggle endpoint: the app
   * flips the heart optimistically, and a toggle would invert the state twice
   * if the request were retried. These two are idempotent, so a retry lands on
   * the state the user asked for.
   */
  app.put('/recipes/:id/favorite', async (request, reply) => {
    const parsed = IdParam.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: 'Recipe not found' });

    await addFavorite(userId(request), parsed.data.id);
    return { data: { is_favorite: true } };
  });

  app.delete('/recipes/:id/favorite', async (request, reply) => {
    const parsed = IdParam.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: 'Recipe not found' });

    await removeFavorite(userId(request), parsed.data.id);
    return { data: { is_favorite: false } };
  });

  /**
   * What the user did with a recipe. Reported as it happens, and answered
   * before anything is derived from it: the app must never wait on telemetry
   * to move to the next step.
   */
  app.post('/recipes/:id/events', async (request, reply) => {
    const parsed = IdParam.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: 'Recipe not found' });

    const body = EventBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Unknown event kind' });

    await recordEvent(userId(request), parsed.data.id, body.data.kind);
    return reply.code(204).send();
  });
}
