import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { newShareToken, renderSharePage, type SharedRecipe } from '../share.js';

const idParams = z.object({ id: z.string() });
const tokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });

function baseUrl(request: FastifyRequest) {
  return env.publicUrl ?? `${request.protocol}://${request.host}`;
}

/**
 * Share links: a recipe gets an unguessable token, and /s/<token> shows it read-only
 * to anyone, with no login. Turning sharing off clears the token, so old links stop working.
 */
export async function shareRoutes(app: FastifyInstance) {
  /** Returns the recipe's link, making one the first time. */
  app.post('/api/recipes/:id/share', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const recipe = await prisma.recipe.findUnique({ where: { id }, select: { shareToken: true } });
    if (!recipe) return reply.code(404).send({ error: 'Recipe not found' });

    const shareToken =
      recipe.shareToken ??
      (await prisma.recipe.update({ where: { id }, data: { shareToken: newShareToken() }, select: { shareToken: true } }))
        .shareToken!;
    return { shareToken };
  });

  app.delete('/api/recipes/:id/share', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const result = await prisma.recipe.updateMany({ where: { id }, data: { shareToken: null } });
    if (result.count === 0) return reply.code(404).send({ error: 'Recipe not found' });
    return reply.code(204).send();
  });

  app.get('/s/:token', async (request, reply) => {
    const parsed = tokenParams.safeParse(request.params);
    const recipe = parsed.success
      ? await prisma.recipe.findUnique({
          where: { shareToken: parsed.data.token },
          // Notes stay private: they're often household asides, not part of the recipe.
          select: {
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
          },
        })
      : null;

    reply
      .header('X-Robots-Tag', 'noindex')
      // The token is the secret, so don't pass it on to the original recipe's site.
      .header('Referrer-Policy', 'no-referrer')
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'")
      // Re-checked every time, so "Stop sharing" takes effect at once.
      .header('Cache-Control', 'no-cache')
      .type('text/html; charset=utf-8');

    if (!recipe) {
      return reply
        .code(404)
        .send(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Link not available</title><body style="font:17px/1.5 system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px"><h1>This link isn’t available</h1><p>Whoever shared this recipe may have stopped sharing it.</p></body>',
        );
    }

    const shared: SharedRecipe = {
      ...recipe,
      ingredients: recipe.ingredients as SharedRecipe['ingredients'],
      instructions: recipe.instructions as SharedRecipe['instructions'],
      tags: recipe.tags.map((t) => t.name),
    };
    const base = baseUrl(request);
    return renderSharePage(shared, { baseUrl: base, pageUrl: `${base}/s/${parsed.data!.token}` });
  });
}
