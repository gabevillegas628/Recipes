import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { prisma } from '../db.js';
import type { Prisma } from '../generated/prisma/client.js';
import { recipeInput, type RecipeInput } from '../recipeInput.js';

const listQuery = z.object({
  q: z.string().trim().optional(),
  tag: z.string().trim().toLowerCase().optional(),
  favorite: z.enum(['true']).optional(),
});

const idParams = z.object({ id: z.string() });

const tagSelect = { select: { name: true }, orderBy: { name: 'asc' } } as const;

function toData(input: RecipeInput) {
  const { tags: _tags, ...fields } = input;
  return fields;
}

function tagConnect(tags: string[]) {
  return tags.map((name) => ({ where: { name }, create: { name } }));
}

function serialize<T extends { tags: { name: string }[] }>(recipe: T) {
  return { ...recipe, tags: recipe.tags.map((t) => t.name) };
}

export async function recipeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/recipes', async (request) => {
    const { q, tag, favorite } = listQuery.parse(request.query);

    const where: Prisma.RecipeWhereInput = {};
    if (q) {
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { tags: { some: { name: { contains: q.toLowerCase() } } } },
      ];
    }
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
        createdAt: true,
        tags: tagSelect,
      },
    });
    return recipes.map(serialize);
  });

  app.get('/api/recipes/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const recipe = await prisma.recipe.findUnique({ where: { id }, include: { tags: tagSelect } });
    if (!recipe) return reply.code(404).send({ error: 'Recipe not found' });
    return serialize(recipe);
  });

  app.post('/api/recipes', async (request, reply) => {
    const parsed = recipeInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const recipe = await prisma.recipe.create({
      data: {
        ...toData(parsed.data),
        createdById: request.userId,
        tags: { connectOrCreate: tagConnect(parsed.data.tags) },
      },
      include: { tags: tagSelect },
    });
    return reply.code(201).send(serialize(recipe));
  });

  app.put('/api/recipes/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = recipeInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });

    const exists = await prisma.recipe.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'Recipe not found' });

    const recipe = await prisma.recipe.update({
      where: { id },
      data: {
        ...toData(parsed.data),
        tags: { set: [], connectOrCreate: tagConnect(parsed.data.tags) },
      },
      include: { tags: tagSelect },
    });
    return serialize(recipe);
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
    const result = await prisma.recipe.deleteMany({ where: { id } });
    if (result.count === 0) return reply.code(404).send({ error: 'Recipe not found' });
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
