import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { prisma } from '../db.js';
import { Prisma } from '../generated/prisma/client.js';
import { hashPassword, newPassword, publicUser } from '../users.js';

/** Admin-only user management. */

const createBody = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  email: z.email('Enter a valid email').trim().toLowerCase(),
  password: newPassword,
  isAdmin: z.boolean().default(false),
});

const updateBody = z.object({
  name: z.string().trim().min(1, 'Name is required').optional(),
  email: z.email('Enter a valid email').trim().toLowerCase().optional(),
  password: newPassword.optional(),
  isAdmin: z.boolean().optional(),
});

const idParams = z.object({ id: z.string() });

function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: error.issues[0]?.message ?? 'Invalid input' });
}

function isDuplicateEmail(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin);

  app.get('/api/users', async () => {
    const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
    return users.map(publicUser);
  });

  app.post('/api/users', async (request, reply) => {
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { password, ...data } = parsed.data;
    try {
      const user = await prisma.user.create({
        data: { ...data, passwordHash: await hashPassword(password) },
      });
      return reply.code(201).send(publicUser(user));
    } catch (err) {
      if (isDuplicateEmail(err)) return reply.code(409).send({ error: 'That email already has an account' });
      throw err;
    }
  });

  app.patch('/api/users/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = updateBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { password, ...data } = parsed.data;

    // Don't let an admin lock themselves (and everyone) out.
    if (id === request.userId && data.isAdmin === false) {
      return reply.code(400).send({ error: "You can't remove your own admin access" });
    }

    try {
      const user = await prisma.user.update({
        where: { id },
        data: { ...data, ...(password ? { passwordHash: await hashPassword(password) } : {}) },
      });
      return publicUser(user);
    } catch (err) {
      if (isDuplicateEmail(err)) return reply.code(409).send({ error: 'That email already has an account' });
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return reply.code(404).send({ error: 'User not found' });
      }
      throw err;
    }
  });

  /** Their recipes stay (shared recipe box); only the account goes. */
  app.delete('/api/users/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (id === request.userId) {
      return reply.code(400).send({ error: "You can't delete your own account" });
    }
    const result = await prisma.user.deleteMany({ where: { id } });
    if (result.count === 0) return reply.code(404).send({ error: 'User not found' });
    return reply.code(204).send();
  });
}
