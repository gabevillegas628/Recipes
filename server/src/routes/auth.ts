import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clearSession, requireAuth, setSession } from '../auth.js';
import { prisma } from '../db.js';

const loginBody = z.object({
  email: z.string().trim().toLowerCase(),
  password: z.string(),
});

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Email and password required' });

    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    const ok = user && (await bcrypt.compare(parsed.data.password, user.passwordHash));
    if (!ok) return reply.code(401).send({ error: 'Wrong email or password' });

    setSession(reply, user.id);
    return { id: user.id, name: user.name, email: user.email };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    clearSession(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.userId! },
      select: { id: true, name: true, email: true },
    });
    if (!user) {
      clearSession(reply);
      return reply.code(401).send({ error: 'Not logged in' });
    }
    return user;
  });
}
