import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clearSession, requireAuth, setSession } from '../auth.js';
import { prisma } from '../db.js';
import { hashPassword, newPassword, publicUser } from '../users.js';

const loginBody = z.object({
  email: z.string().trim().toLowerCase(),
  password: z.string(),
});

const changePasswordBody = z.object({
  currentPassword: z.string(),
  newPassword,
});

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Email and password required' });

    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    const ok = user && (await bcrypt.compare(parsed.data.password, user.passwordHash));
    if (!ok) return reply.code(401).send({ error: 'Wrong email or password' });

    setSession(reply, user.id);
    return publicUser(user);
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    clearSession(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.userId! } });
    if (!user) {
      clearSession(reply);
      return reply.code(401).send({ error: 'Not logged in' });
    }
    return publicUser(user);
  });

  app.post('/api/auth/password', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = changePasswordBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid password' });
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.userId! } });
    if (!(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) {
      return reply.code(400).send({ error: 'Your current password is wrong' });
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(parsed.data.newPassword) },
    });
    return { ok: true };
  });
}
