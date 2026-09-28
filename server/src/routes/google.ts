import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { moveToCalendar } from '../calendarSync.js';
import { prisma } from '../db.js';
import { env } from '../env.js';
import {
  authUrl,
  connect,
  disconnect,
  getConnection,
  GoogleApiError,
  GoogleAuthError,
  googleConfigured,
  listCalendars,
  setCalendar,
} from '../google.js';

/**
 * Settings → Google Calendar. Connecting is a normal OAuth round trip:
 * /api/google/connect sends the browser to Google, which comes back to
 * /api/google/callback with a code. A short-lived signed cookie carries the
 * state so the callback only accepts the sign-in this browser started.
 */

const STATE_COOKIE = 'google_state';

function baseUrl(request: FastifyRequest) {
  return env.publicUrl ?? `${request.protocol}://${request.host}`;
}

const redirectUri = (request: FastifyRequest) => `${baseUrl(request)}/api/google/callback`;

async function status() {
  const c = await getConnection();
  return {
    configured: googleConfigured,
    connected: Boolean(c),
    email: c?.email ?? null,
    calendarId: c?.calendarId ?? null,
    calendarName: c?.calendarName ?? null,
    error: c?.error ?? null,
    connectedBy: c?.connectedBy?.name ?? null,
    pending: c ? await prisma.note.count({ where: { syncPending: true } }) : 0,
    failed: c ? await prisma.note.count({ where: { syncError: { not: null } } }) : 0,
  };
}

function googleError(err: unknown) {
  if (err instanceof GoogleAuthError || err instanceof GoogleApiError) return err.message;
  return null;
}

export async function googleRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/google', async () => status());

  app.get('/api/google/connect', async (request, reply) => {
    if (!googleConfigured) return reply.redirect('/settings?google=unconfigured');
    const state = randomBytes(16).toString('base64url');
    reply.setCookie(STATE_COOKIE, state, {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure: env.isProd,
      path: '/api/google',
      maxAge: 10 * 60,
    });
    return reply.redirect(authUrl(redirectUri(request), state));
  });

  app.get('/api/google/callback', async (request, reply) => {
    const query = z
      .object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() })
      .parse(request.query);
    const raw = request.cookies[STATE_COOKIE];
    const expected = raw ? request.unsignCookie(raw) : null;
    reply.clearCookie(STATE_COOKIE, { path: '/api/google' });

    if (query.error) return reply.redirect('/settings?google=cancelled');
    if (!query.code || !expected?.valid || expected.value !== query.state) {
      return reply.redirect('/settings?google=expired');
    }
    try {
      await connect(query.code, redirectUri(request), baseUrl(request), request.userId);
    } catch (err) {
      const message = googleError(err);
      if (!message) throw err;
      return reply.redirect(`/settings?google=failed&reason=${encodeURIComponent(message)}`);
    }
    return reply.redirect('/settings?google=connected');
  });

  app.get('/api/google/calendars', async (_request, reply) => {
    try {
      return await listCalendars();
    } catch (err) {
      const message = googleError(err);
      if (!message) throw err;
      return reply.code(502).send({ error: message });
    }
  });

  /** Picks the calendar to write to, then moves everything current onto it. */
  app.put('/api/google/calendar', async (request, reply) => {
    const parsed = z.object({ calendarId: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Pick a calendar' });
    const connection = await getConnection();
    if (!connection) return reply.code(409).send({ error: 'Connect Google first' });
    try {
      const calendar = (await listCalendars()).find((c) => c.id === parsed.data.calendarId);
      if (!calendar) return reply.code(400).send({ error: "That calendar isn't one this account can add events to." });
      const previous = connection.calendarId;
      await setCalendar(calendar);
      if (previous !== calendar.id) await moveToCalendar(previous);
      return status();
    } catch (err) {
      const message = googleError(err);
      if (!message) throw err;
      return reply.code(502).send({ error: message });
    }
  });

  /** Stops syncing. Events already on the calendar stay there. */
  app.delete('/api/google', async () => {
    await disconnect();
    return status();
  });
}
