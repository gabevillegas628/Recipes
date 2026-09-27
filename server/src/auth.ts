import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from './db.js';
import { env } from './env.js';

export const SESSION_COOKIE = 'sid';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

declare module 'fastify' {
  interface FastifyRequest {
    userId: string | null;
    isAdmin: boolean;
  }
}

/**
 * Reads the signed session cookie and confirms the user still exists (so deleting
 * a user logs them out everywhere). Sets request.userId / request.isAdmin.
 */
export async function loadSession(request: FastifyRequest) {
  request.userId = null;
  request.isAdmin = false;
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return;
  const { valid, value } = request.unsignCookie(raw);
  if (!valid || !value) return;

  const user = await prisma.user.findUnique({ where: { id: value }, select: { isAdmin: true } });
  if (!user) return;
  request.userId = value;
  request.isAdmin = user.isAdmin;
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.userId) return reply.code(401).send({ error: 'Not logged in' });
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.userId) return reply.code(401).send({ error: 'Not logged in' });
  if (!request.isAdmin) return reply.code(403).send({ error: 'Only admins can do that' });
}

export function setSession(reply: FastifyReply, userId: string) {
  reply.setCookie(SESSION_COOKIE, userId, {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProd,
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
  });
}

export function clearSession(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
