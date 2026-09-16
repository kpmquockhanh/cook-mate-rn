import type { FastifyInstance } from 'fastify';
import { getRecipe, listRecipes } from '../queries/recipes.js';
import { IdParam, ListQuery } from '../schema.js';

export async function recipeRoutes(app: FastifyInstance): Promise<void> {
  // The client reads `json.data` but tolerates a bare array; the wrapper leaves
  // room for pagination metadata later without breaking it.
  app.get('/recipes', async (request) => {
    return { data: await listRecipes(ListQuery.parse(request.query)) };
  });

  app.get('/recipes/:id', async (request, reply) => {
    const parsed = IdParam.safeParse(request.params);
    // A non-numeric id is a missing recipe, not a bad request - hooks/useRecipe.ts
    // maps 404 to "Recipe not found" and anything else to a raw status message.
    if (!parsed.success) {
      return reply.code(404).send({ error: 'Recipe not found' });
    }

    const recipe = await getRecipe(parsed.data.id);
    if (!recipe) {
      return reply.code(404).send({ error: 'Recipe not found' });
    }
    return { data: recipe };
  });
}
