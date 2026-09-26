import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { prisma } from '../db.js';
import type { Prisma } from '../generated/prisma/client.js';
import { recipeInput } from '../recipeInput.js';
import {
  createRecipe,
  deleteRecipe,
  searchWhere,
  serialize,
  updateRecipe,
  withTags,
} from '../recipes.js';

const listQuery = z.object({
  q: z.string().trim().optional(),
  tag: z.string().trim().toLowerCase().optional(),
  favorite: z.enum(['true']).optional(),
});

const idParams = z.object({ id: z.string() });

export async function recipeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/recipes', async (request) => {
    const { q, tag, favorite } = listQuery.parse(request.query);

    const where: Prisma.RecipeWhereInput = { AND: q ? await searchWhere(q) : [] };
    if (tag) where.tags = { some: { name: tag } };
    if (favorite) where.favorite = true;

    const recipes = await prisma.recipe.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        image: true,
        source: true,
        totalMinutes: true,
        prepMinutes: true,
        cookMinutes: true,
        favorite: true,
        needsReview: true,
        createdAt: true,
        tags: withTags.tags,
      },
    });
    return recipes.map(serialize);
  });

  app.get('/api/recipes/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const recipe = await prisma.recipe.findUnique({ where: { id }, include: withTags });
    if (!recipe) return reply.code(404).send({ error: 'Recipe not found' });
    return serialize(recipe);
  });

  app.post('/api/recipes', async (request, reply) => {
    const parsed = recipeInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const recipe = await createRecipe(parsed.data, { userId: request.userId });
    return reply.code(201).send(recipe);
  });

  app.put('/api/recipes/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = recipeInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const recipe = await updateRecipe(id, parsed.data);
    if (!recipe) return reply.code(404).send({ error: 'Recipe not found' });
    return recipe;
  });

  app.patch('/api/recipes/:id/favorite', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = z.object({ favorite: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'favorite must be a boolean' });

    const result = await prisma.recipe.updateMany({ where: { id }, data: parsed.data });
    if (result.count === 0) return reply.code(404).send({ error: 'Recipe not found' });
    return parsed.data;
  });

  app.delete('/api/recipes/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!(await deleteRecipe(id))) return reply.code(404).send({ error: 'Recipe not found' });
    return reply.code(204).send();
  });

  app.get('/api/tags', async () => {
    const tags = await prisma.tag.findMany({
      where: { recipes: { some: {} } },
      orderBy: { name: 'asc' },
      select: { name: true, _count: { select: { recipes: true } } },
    });
    return tags.map((t) => ({ name: t.name, count: t._count.recipes }));
  });
}
