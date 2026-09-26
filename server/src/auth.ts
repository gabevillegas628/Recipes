import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from './env.js';

export const SESSION_COOKIE = 'sid';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

declare module 'fastify' {
  interface FastifyRequest {
    userId: string | null;
  }
}

/** Reads the signed session cookie; sets request.userId or null. */
export async function loadSession(request: FastifyRequest) {
  request.userId = null;
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return;
  const { valid, value } = request.unsignCookie(raw);
  if (valid && value) request.userId = value;
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.userId) return reply.code(401).send({ error: 'Not logged in' });
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
