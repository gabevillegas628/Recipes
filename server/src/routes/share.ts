import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { newShareToken, renderMealPage, renderRecipePage, type SharedRecipe } from '../share.js';

const idParams = z.object({ id: z.string() });
const tokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });

function baseUrl(request: FastifyRequest) {
  return env.publicUrl ?? `${request.protocol}://${request.host}`;
}

// Notes stay private: they're often household asides, not part of the recipe.
const sharedFields = {
  title: true,
  description: true,
  image: true,
  servings: true,
  prepMinutes: true,
  cookMinutes: true,
  totalMinutes: true,
  ingredients: true,
  instructions: true,
  sourceUrl: true,
  tags: { select: { name: true } },
} as const;

type SharedRow = Omit<SharedRecipe, 'ingredients' | 'instructions' | 'tags'> & {
  ingredients: unknown;
  instructions: unknown;
  tags: { name: string }[];
};

const toShared = (r: SharedRow): SharedRecipe => ({
  ...r,
  ingredients: r.ingredients as SharedRecipe['ingredients'],
  instructions: r.instructions as SharedRecipe['instructions'],
  tags: r.tags.map((t) => t.name),
});

const NOT_AVAILABLE =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Link not available</title><body style="font:17px/1.5 system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px"><h1>This link isn’t available</h1><p>Whoever shared it may have stopped sharing.</p></body>';

/**
 * Share links: a recipe or meal gets an unguessable token, and /s/<token> shows it
 * read-only to anyone, with no login. Turning sharing off clears the token, so old
 * links stop working.
 */
export async function shareRoutes(app: FastifyInstance) {
  /** Returns the recipe's link token, making one the first time. */
  app.post('/api/recipes/:id/share', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const recipe = await prisma.recipe.findUnique({ where: { id }, select: { shareToken: true } });
    if (!recipe) return reply.code(404).send({ error: 'Recipe not found' });
    if (recipe.shareToken) return { shareToken: recipe.shareToken };
    return prisma.recipe.update({ where: { id }, data: { shareToken: newShareToken() }, select: { shareToken: true } });
  });

  app.delete('/api/recipes/:id/share', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const result = await prisma.recipe.updateMany({ where: { id }, data: { shareToken: null } });
    if (result.count === 0) return reply.code(404).send({ error: 'Recipe not found' });
    return reply.code(204).send();
  });

  app.post('/api/meals/:id/share', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const meal = await prisma.meal.findUnique({ where: { id }, select: { shareToken: true } });
    if (!meal) return reply.code(404).send({ error: 'Meal not found' });
    if (meal.shareToken) return { shareToken: meal.shareToken };
    return prisma.meal.update({ where: { id }, data: { shareToken: newShareToken() }, select: { shareToken: true } });
  });

  app.delete('/api/meals/:id/share', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const result = await prisma.meal.updateMany({ where: { id }, data: { shareToken: null } });
    if (result.count === 0) return reply.code(404).send({ error: 'Meal not found' });
    return reply.code(204).send();
  });

  /** Recipe and meal tokens share one address space; each is random, so they can't collide in practice. */
  app.get('/s/:token', async (request, reply) => {
    reply
      .header('X-Robots-Tag', 'noindex')
      // The token is the secret, so don't pass it on to the original recipe's site.
      .header('Referrer-Policy', 'no-referrer')
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'")
      // Re-checked every time, so "Stop sharing" takes effect at once.
      .header('Cache-Control', 'no-cache')
      .type('text/html; charset=utf-8');

    const parsed = tokenParams.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send(NOT_AVAILABLE);
    const { token } = parsed.data;
    const base = baseUrl(request);
    const opts = { baseUrl: base, pageUrl: `${base}/s/${token}` };

    const recipe = await prisma.recipe.findUnique({ where: { shareToken: token }, select: sharedFields });
    if (recipe) return renderRecipePage(toShared(recipe), opts);

    const meal = await prisma.meal.findUnique({
      where: { shareToken: token },
      select: {
        name: true,
        servings: true,
        recipes: { orderBy: { position: 'asc' }, select: { scale: true, recipe: { select: sharedFields } } },
      },
    });
    if (meal) {
      return renderMealPage(
        { ...meal, recipes: meal.recipes.map((r) => ({ scale: r.scale, recipe: toShared(r.recipe) })) },
        opts,
      );
    }

    return reply.code(404).send(NOT_AVAILABLE);
  });
}
