import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { prisma } from '../db.js';
import { calendarTimeZone, getConnection, GoogleApiError, GoogleAuthError, listEvents } from '../google.js';
import { addDays } from '../recurrence.js';
import { wallTime, zonedInstant } from '../zone.js';

/**
 * The Today screen's calendar: everything on the family calendar from the start
 * of today through the next few days. Reminders the app wrote are left out; the
 * screen shows those from the app itself, with a checkbox.
 */
export async function todayRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/today', async (request, reply) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(14).default(7) }).parse(request.query);
    const connection = await getConnection();
    if (!connection?.calendarId || connection.error) {
      return { connected: false, error: connection?.error ?? null, calendarName: null, events: [] };
    }
    try {
      const timeZone = (await calendarTimeZone(connection.calendarId, connection.timeZone)) ?? 'UTC';
      const today = wallTime(new Date(), timeZone).slice(0, 10);
      const from = zonedInstant(`${today}T00:00:00`, timeZone);
      const to = zonedInstant(`${addDays(today, days)}T00:00:00`, timeZone);
      const events = await listEvents(connection.calendarId, from, to);

      const fromApp = [...new Set(events.flatMap((e) => (e.noteId ? [e.noteId] : [])))];
      const reminders = new Set(
        (await prisma.note.findMany({ where: { id: { in: fromApp }, kind: 'REMINDER' }, select: { id: true } })).map((n) => n.id),
      );

      return {
        connected: true,
        error: null,
        calendarName: connection.calendarName,
        events: events
          .filter((e) => !(e.noteId && reminders.has(e.noteId)))
          .map((e) => ({
            title: e.title,
            start: e.start?.toISOString() ?? null,
            end: e.end?.toISOString() ?? null,
            allDayDate: e.allDayDate,
            allDayEnd: e.allDayEnd,
            location: e.location,
            noteId: e.noteId,
          })),
      };
    } catch (err) {
      if (err instanceof GoogleAuthError || err instanceof GoogleApiError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });
}
