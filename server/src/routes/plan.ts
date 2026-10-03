import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { prisma } from '../db.js';
import { addGroceries, addToPlan, clearPlan, getGroceries, getPlan } from '../plan.js';
import { acceptInput, acceptPlan, inventInput, inventPlan, PlannerError, suggestInput, suggestPlan } from '../weekPlanner.js';

const idParams = z.object({ id: z.string() });
const scale = z.number().positive().max(20);

export async function planRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ---------- This week ----------

  app.get('/api/plan', async () => getPlan());

  app.post('/api/plan', async (request, reply) => {
    const parsed = z.object({ recipeId: z.string(), scale: scale.default(1) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'recipeId required' });
    const recipe = await prisma.recipe.findUnique({ where: { id: parsed.data.recipeId }, select: { id: true } });
    if (!recipe) return reply.code(404).send({ error: 'Recipe not found' });
    return addToPlan(parsed.data.recipeId, parsed.data.scale, request.userId);
  });

  app.patch('/api/plan/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = z.object({ cooked: z.boolean().optional(), scale: scale.optional() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid update' });
    const { cooked, scale: newScale } = parsed.data;
    const result = await prisma.planItem.updateMany({
      where: { id, archivedAt: null },
      data: {
        ...(cooked !== undefined ? { cookedAt: cooked ? new Date() : null } : {}),
        ...(newScale !== undefined ? { scale: newScale } : {}),
      },
    });
    if (result.count === 0) return reply.code(404).send({ error: 'Not on this week' });
    return { ok: true };
  });

  app.delete('/api/plan/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const result = await prisma.planItem.updateMany({
      where: { id, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    if (result.count === 0) return reply.code(404).send({ error: 'Not on this week' });
    return reply.code(204).send();
  });

  /** Removes a whole meal from this week. */
  app.delete('/api/plan/meal/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    await prisma.planItem.updateMany({ where: { mealId: id, archivedAt: null }, data: { archivedAt: new Date() } });
    return { ok: true };
  });

  // ---------- Planning several recipes that share ingredients ----------

  app.post('/api/plan/suggest', async (request, reply) => {
    const parsed = suggestInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    try {
      return await suggestPlan(parsed.data);
    } catch (err) {
      if (err instanceof PlannerError) return reply.code(422).send({ error: err.message });
      throw err;
    }
  });

  /** Claude writes new recipes around one from the collection. Slow: up to a minute or so. */
  app.post('/api/plan/invent', async (request, reply) => {
    const parsed = inventInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    try {
      return await inventPlan(parsed.data);
    } catch (err) {
      if (err instanceof PlannerError) return reply.code(422).send({ error: err.message });
      throw err;
    }
  });

  /** Puts the planned recipes on this week, saving any Claude wrote. */
  app.post('/api/plan/accept', async (request, reply) => {
    const parsed = acceptInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    return acceptPlan(parsed.data, request.userId);
  });

  /** "Start new week": clears everything planned. */
  app.delete('/api/plan', async () => {
    await clearPlan();
    return { ok: true };
  });

  // ---------- Grocery list ----------

  app.get('/api/grocery', async () => getGroceries());

  app.post('/api/grocery', async (request, reply) => {
    const parsed = z
      .object({
        items: z
          .array(z.object({ text: z.string().max(300), recipeId: z.string().nullish() }))
          .min(1)
          .max(200),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Nothing to add' });
    return { added: await addGroceries(parsed.data.items, request.userId) };
  });

  app.patch('/api/grocery/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = z
      .object({ checked: z.boolean().optional(), text: z.string().trim().min(1).max(300).optional() })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid update' });
    const { checked, text } = parsed.data;
    const result = await prisma.groceryItem.updateMany({
      where: { id },
      data: {
        ...(checked !== undefined ? { checked, checkedAt: checked ? new Date() : null } : {}),
        ...(text ? { text } : {}),
      },
    });
    if (result.count === 0) return reply.code(404).send({ error: 'Item not found' });
    return { ok: true };
  });

  app.delete('/api/grocery/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.groceryItem.deleteMany({ where: { id } });
    return reply.code(204).send();
  });

  /** Clears checked items (or everything with ?all=true). */
  app.delete('/api/grocery', async (request) => {
    const { all } = z.object({ all: z.enum(['true']).optional() }).parse(request.query);
    const result = await prisma.groceryItem.deleteMany({ where: all ? {} : { checked: true } });
    return { deleted: result.count };
  });
}
