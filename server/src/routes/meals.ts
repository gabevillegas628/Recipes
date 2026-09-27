import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { prisma } from '../db.js';
import { Prisma } from '../generated/prisma/client.js';
import { addMealToPlan, addRecipeToMeal, createMeal, getMeal, listMeals, updateMeal } from '../meals.js';

const idParams = z.object({ id: z.string() });
const servings = z.number().int().positive().max(500).nullish();
const notes = z.string().trim().max(5000).nullish().transform((s) => s || null);

const createBody = z.object({
  name: z.string().trim().min(1, 'Name the meal'),
  notes,
  servings,
  recipeIds: z.array(z.string()).max(50).optional(),
});

const updateBody = z.object({
  name: z.string().trim().min(1, 'Name the meal').optional(),
  notes: notes.optional(),
  servings: servings.optional(),
  recipes: z
    .array(z.object({ recipeId: z.string(), scale: z.number().positive().max(20).optional() }))
    .max(50)
    .optional(),
});

function notFound(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && ['P2025', 'P2003'].includes(err.code);
}

export async function mealRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/meals', async () => listMeals());

  app.get('/api/meals/:id', async (request, reply) => {
    const meal = await getMeal(idParams.parse(request.params).id);
    return meal ?? reply.code(404).send({ error: 'Meal not found' });
  });

  app.post('/api/meals', async (request, reply) => {
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    return reply.code(201).send(await createMeal(parsed.data, request.userId));
  });

  app.patch('/api/meals/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = updateBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    try {
      return await updateMeal(id, parsed.data);
    } catch (err) {
      if (notFound(err)) return reply.code(404).send({ error: 'Meal or recipe not found' });
      throw err;
    }
  });

  app.delete('/api/meals/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.meal.deleteMany({ where: { id } });
    return reply.code(204).send();
  });

  /** "Add to meal" from a recipe page. */
  app.post('/api/meals/:id/recipes', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = z.object({ recipeId: z.string() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'recipeId required' });
    try {
      await addRecipeToMeal(id, parsed.data.recipeId);
      return { ok: true };
    } catch (err) {
      if (notFound(err)) return reply.code(404).send({ error: 'Meal or recipe not found' });
      throw err;
    }
  });

  /** Puts the whole meal on this week, scaled by `factor` (the meal's servings stepper). */
  app.post('/api/meals/:id/plan', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = z.object({ factor: z.number().positive().max(20).default(1) }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid servings' });
    const meal = await addMealToPlan(id, parsed.data.factor, request.userId);
    return meal ? { ok: true } : reply.code(404).send({ error: 'Meal not found' });
  });
}
