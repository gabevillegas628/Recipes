import { prisma } from './db.js';
import type { Note } from './generated/prisma/client.js';
import {
  deleteEvent,
  getConnection,
  GoogleApiError,
  GoogleAuthError,
  insertEvent,
  updateEvent,
  type EventBody,
} from './google.js';

/**
 * Copies appointments and dated reminders to the family Google Calendar. Saving a
 * note marks it syncPending and kicks this worker, so saves never wait on Google.
 * One-way: edits made in Google Calendar don't come back. Temporary failures are
 * retried by the timer in index.ts; a note Google rejects keeps its syncError.
 */

let running = false;
let again = false;

export function kickCalendarSync() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  void drain()
    .catch((err) => console.error('Calendar sync crashed:', err))
    .finally(() => {
      running = false;
      if (again) {
        again = false;
        kickCalendarSync();
      }
    });
}

/** Whether a note belongs on the calendar. */
export function onCalendar(note: Pick<Note, 'kind' | 'startsAt'>): boolean {
  return note.startsAt !== null && (note.kind === 'APPOINTMENT' || note.kind === 'REMINDER');
}

async function drain() {
  const connection = await getConnection();
  if (!connection?.calendarId || connection.error) return;
  const { calendarId, appUrl } = connection;

  const failed = new Set<string>();
  for (;;) {
    const batch = await prisma.note.findMany({
      where: { syncPending: true, id: { notIn: [...failed] } },
      orderBy: { updatedAt: 'asc' },
      take: 20,
    });
    if (batch.length === 0) return;

    for (const note of batch) {
      try {
        await syncNote(note, calendarId, appUrl);
      } catch (err) {
        if (err instanceof GoogleAuthError) return; // Recorded on the connection; stop until reconnected.
        if (err instanceof GoogleApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
          // Google won't take this one as it is; say why and stop retrying it until it's edited.
          await finish(note, { syncError: err.message });
          continue;
        }
        // Network trouble, rate limits, Google having a bad moment: leave it pending for the retry timer.
        console.warn('Calendar sync failed, will retry:', (err as Error).message);
        failed.add(note.id);
      }
    }
  }
}

async function syncNote(note: Note, calendarId: string, appUrl: string) {
  if (!onCalendar(note)) {
    if (note.googleEventId) await deleteEvent(calendarId, note.googleEventId);
    await finish(note, { googleEventId: null, syncError: null });
    return;
  }

  const event = toEvent(note, appUrl);
  let eventId = note.googleEventId;
  if (eventId) {
    try {
      await updateEvent(calendarId, eventId, event);
    } catch (err) {
      // Deleted in Google Calendar, or it lives on a calendar we no longer use: add it again.
      if (!(err instanceof GoogleApiError && [403, 404, 410].includes(err.status))) throw err;
      eventId = null;
    }
  }
  if (!eventId) eventId = await insertEvent(calendarId, event);
  await finish(note, { googleEventId: eventId, syncError: null });
}

/**
 * Records the result without touching updatedAt (the list sorts by it). If the
 * note was edited while syncing, only the event id is kept and it stays pending.
 */
async function finish(note: Note, data: { googleEventId?: string | null; syncError: string | null }) {
  const done = await prisma.note.updateMany({
    where: { id: note.id, updatedAt: note.updatedAt },
    data: { ...data, syncPending: false, updatedAt: note.updatedAt },
  });
  if (done.count === 0 && data.googleEventId !== undefined) {
    const current = await prisma.note.findUnique({ where: { id: note.id }, select: { updatedAt: true } });
    if (current) {
      await prisma.note.update({
        where: { id: note.id },
        data: { googleEventId: data.googleEventId, updatedAt: current.updatedAt },
      });
    }
  }
}

const MINUTE = 60_000;
const day = (d: Date) => d.toISOString().slice(0, 10);
const nextDay = (d: Date) => day(new Date(d.getTime() + 24 * 60 * MINUTE));

export function toEvent(note: Note, appUrl: string): EventBody {
  const title = note.kind === 'REMINDER' ? `Reminder: ${note.title}` : note.title;
  const start = note.startsAt!;
  const end = note.endsAt ?? start;
  return {
    summary: note.doneAt ? `✓ ${title}` : title,
    description: [note.body, `Open in the app: ${appUrl}/n/${note.id}`].filter(Boolean).join('\n\n'),
    location: note.location ?? undefined,
    // All-day dates sit at 12:00 UTC (see notes.ts); Google's all-day end date is exclusive.
    ...(note.allDay
      ? { start: { date: day(start) }, end: { date: nextDay(end) } }
      : {
          start: { dateTime: start.toISOString() },
          end: {
            dateTime: (note.endsAt
              ? note.endsAt
              : new Date(start.getTime() + (note.kind === 'APPOINTMENT' ? 60 : 15) * MINUTE)
            ).toISOString(),
          },
        }),
    // Each person's own default alerts for the calendar.
    reminders: { useDefault: true },
    extendedProperties: { private: { noteId: note.id } },
  };
}

/** Removes a deleted note's event. Best effort: the note itself is already gone. */
export async function removeFromCalendar(googleEventId: string | null) {
  if (!googleEventId) return;
  const connection = await getConnection();
  if (!connection?.calendarId || connection.error) return;
  try {
    await deleteEvent(connection.calendarId, googleEventId);
  } catch (err) {
    console.warn('Could not remove calendar event:', (err as Error).message);
  }
}

/**
 * After choosing a (different) calendar: take events off the old one, then queue
 * everything current for the new one. Past appointments stay off the calendar.
 */
export async function moveToCalendar(oldCalendarId: string | null) {
  if (oldCalendarId) {
    const onOld = await prisma.note.findMany({ where: { googleEventId: { not: null } } });
    for (const note of onOld) {
      try {
        await deleteEvent(oldCalendarId, note.googleEventId!);
      } catch (err) {
        console.warn('Could not remove event from the old calendar:', (err as Error).message);
      }
      await prisma.note.update({ where: { id: note.id }, data: { googleEventId: null, updatedAt: note.updatedAt } });
    }
  }
  const yesterday = new Date(Date.now() - 24 * 60 * MINUTE);
  await prisma.note.updateMany({
    where: {
      kind: { in: ['APPOINTMENT', 'REMINDER'] },
      OR: [
        { endsAt: { gte: yesterday } },
        { endsAt: null, startsAt: { gte: yesterday } },
        // Open reminders, even overdue ones.
        { kind: 'REMINDER', doneAt: null, startsAt: { not: null } },
      ],
    },
    data: { syncPending: true },
  });
  kickCalendarSync();
}
