import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { setTag } from '../eventTags.js';
import { findTimeInput, FindTimeError, runFindTime } from '../findTimeService.js';
import { GoogleApiError, GoogleAuthError } from '../google.js';
import { getHousehold, householdBody, saveHousehold } from '../household.js';

/** Settings → Household, and "find a time" (re-run from the options screen after a correction). */
export async function householdRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/household', async () => getHousehold());

  app.put('/api/household', async (request, reply) => {
    const parsed = householdBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    return saveHousehold(parsed.data);
  });

  app.post('/api/find-time', async (request, reply) => {
    const parsed = findTimeInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    try {
      return await runFindTime(parsed.data);
    } catch (err) {
      if (err instanceof FindTimeError) return reply.code(422).send({ error: err.message });
      if (err instanceof GoogleAuthError || err instanceof GoogleApiError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });

  /** Whose an event is, by its title, corrected by hand. No people and not everyone: it takes no one's time. */
  app.put('/api/event-tags', async (request, reply) => {
    const parsed = z
      .object({ title: z.string().min(1).max(300), people: z.array(z.string()).max(20), everyone: z.boolean() })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid tag' });
    await setTag(parsed.data.title, parsed.data.people, parsed.data.everyone);
    return { ok: true };
  });
}
