import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { prisma } from '../db.js';
import { calendarTimeZone, getConnection, GoogleApiError, GoogleAuthError, listEvents, type CalendarEvent } from '../google.js';
import { addDays } from '../recurrence.js';
import { wallTime, zonedInstant } from '../zone.js';

/**
 * The family calendar as the app shows it: Today (from the start of a day,
 * today unless another date is picked) and search across Mise and the calendar.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** How far back and ahead search looks in the calendar. */
const SEARCH_YEARS_BACK = 3;
const SEARCH_YEARS_AHEAD = 1;
const MAX_CALENDAR_RESULTS = 60;
const MAX_NOTE_RESULTS = 60;

/**
 * Calendar events ready for the app. Reminders the app wrote are left out (the
 * app shows its own, with a checkbox), and an event only links back to Mise if
 * its appointment is still there.
 */
async function forApp(events: CalendarEvent[], { skipReminders }: { skipReminders: boolean }) {
  const ids = [...new Set(events.flatMap((e) => (e.noteId ? [e.noteId] : [])))];
  const notes = new Map(
    (await prisma.note.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true } })).map((n) => [n.id, n.kind]),
  );
  return events
    .filter((e) => !(skipReminders && e.noteId && notes.get(e.noteId) === 'REMINDER'))
    .map((e) => ({
      title: e.title,
      start: e.start?.toISOString() ?? null,
      end: e.end?.toISOString() ?? null,
      allDayDate: e.allDayDate,
      allDayEnd: e.allDayEnd,
      location: e.location,
      noteId: e.noteId && notes.has(e.noteId) ? e.noteId : null,
    }));
}

export async function todayRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/today', async (request, reply) => {
    const { days, date } = z
      .object({
        days: z.coerce.number().int().min(1).max(14).default(7),
        date: z.string().regex(DATE).optional(),
      })
      .parse(request.query);
    const connection = await getConnection();
    if (!connection?.calendarId || connection.error) {
      return { connected: false, error: connection?.error ?? null, calendarName: null, events: [] };
    }
    try {
      const timeZone = (await calendarTimeZone(connection.calendarId, connection.timeZone)) ?? 'UTC';
      const first = date ?? wallTime(new Date(), timeZone).slice(0, 10);
      const from = zonedInstant(`${first}T00:00:00`, timeZone);
      const to = zonedInstant(`${addDays(first, days)}T00:00:00`, timeZone);
      const events = await listEvents(connection.calendarId, from, to);
      return {
        connected: true,
        error: null,
        calendarName: connection.calendarName,
        // Looking back at another day, the app's reminders show as they were on the calendar.
        events: await forApp(events, { skipReminders: !date }),
      };
    } catch (err) {
      if (err instanceof GoogleAuthError || err instanceof GoogleApiError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });

  /**
   * Finds notes, reminders and appointments in Mise (past ones too) and matching
   * events on the family calendar, a few years back and a year ahead. Mise items
   * come first-class; calendar events Mise already has aren't repeated.
   */
  app.get('/api/search', async (request, reply) => {
    const parsed = z.object({ q: z.string().trim().min(2).max(100) }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Type at least two letters' });
    const { q } = parsed.data;

    const words = q.split(/\s+/).filter(Boolean);
    const notes = await prisma.note.findMany({
      where: {
        AND: words.map((w) => ({
          OR: [
            { title: { contains: w, mode: 'insensitive' as const } },
            { body: { contains: w, mode: 'insensitive' as const } },
            { location: { contains: w, mode: 'insensitive' as const } },
          ],
        })),
      },
      orderBy: { updatedAt: 'desc' },
      take: MAX_NOTE_RESULTS,
      include: { createdBy: { select: { name: true } } },
    });

    let calendar: Awaited<ReturnType<typeof forApp>> = [];
    let calendarError: string | null = null;
    const connection = await getConnection();
    if (connection?.calendarId && !connection.error) {
      try {
        const now = new Date();
        const from = new Date(now);
        from.setFullYear(now.getFullYear() - SEARCH_YEARS_BACK);
        const to = new Date(now);
        to.setFullYear(now.getFullYear() + SEARCH_YEARS_AHEAD);
        const found = await listEvents(connection.calendarId, from, to, q);
        const inMise = new Set(notes.map((n) => n.id));
        // Newest first; repeating events can match hundreds of times, so keep the most recent.
        calendar = (await forApp(found, { skipReminders: false }))
          .filter((e) => !(e.noteId && inMise.has(e.noteId)))
          .sort((a, b) => (b.start ?? b.allDayDate ?? '').localeCompare(a.start ?? a.allDayDate ?? ''))
          .slice(0, MAX_CALENDAR_RESULTS);
      } catch (err) {
        if (!(err instanceof GoogleAuthError || err instanceof GoogleApiError)) throw err;
        calendarError = err.message;
      }
    }
    return { notes, calendar, calendarError, calendarConnected: Boolean(connection?.calendarId && !connection.error) };
  });
}
