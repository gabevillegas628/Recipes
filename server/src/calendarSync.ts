import { prisma } from './db.js';
import type { Note } from './generated/prisma/client.js';
import {
  calendarTimeZone,
  deleteEvent,
  getConnection,
  GoogleApiError,
  GoogleAuthError,
  insertEvent,
  updateEvent,
  type EventBody,
} from './google.js';
import { parseRule } from './recurrence.js';
import { wallTime, zonedInstant } from './zone.js';

/**
 * Copies appointments and dated reminders to Google Calendar: appointments to the
 * family calendar, reminders to their own calendar when one is set (else the
 * family one). Saving a note marks it syncPending and kicks this worker, so saves
 * never wait on Google. One-way: edits made in Google Calendar don't come back.
 * Temporary failures are retried by the timer in index.ts; a note Google rejects
 * keeps its syncError.
 */

interface Target {
  calendarId: string;
  remindersCalendarId: string | null;
  remindersColor: string | null;
  appUrl: string;
  timeZone: string;
}

const calendarFor = (note: Pick<Note, 'kind'>, t: Pick<Target, 'calendarId' | 'remindersCalendarId'>) =>
  note.kind === 'REMINDER' && t.remindersCalendarId ? t.remindersCalendarId : t.calendarId;

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
  const { calendarId, remindersCalendarId, remindersColor, appUrl } = connection;
  let target: Target;
  try {
    // Google expands repeating events in this zone, so "every Tuesday at 3" stays at 3 across DST.
    const timeZone = (await calendarTimeZone(calendarId, connection.timeZone)) ?? 'UTC';
    target = { calendarId, remindersCalendarId, remindersColor, appUrl, timeZone };
  } catch (err) {
    if (!(err instanceof GoogleAuthError)) console.warn('Calendar sync: no time zone yet:', (err as Error).message);
    return;
  }

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
        await syncNote(note, target);
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

/** Takes an event off a calendar we're moving away from. Best effort: it may already be gone. */
async function deleteQuietly(calendarId: string, eventId: string) {
  try {
    await deleteEvent(calendarId, eventId);
  } catch (err) {
    if (err instanceof GoogleAuthError) throw err;
    console.warn('Could not remove event from the old calendar:', (err as Error).message);
  }
}

async function syncNote(note: Note, t: Target) {
  // Events written before the calendar was recorded are on the family calendar.
  const current = note.googleEventId ? (note.googleCalendarId ?? t.calendarId) : null;
  if (!onCalendar(note)) {
    if (note.googleEventId) await deleteEvent(current!, note.googleEventId);
    await finish(note, { googleEventId: null, googleCalendarId: null, syncError: null });
    return;
  }

  const calendarId = calendarFor(note, t);
  const event = toEvent(note, t);
  let eventId = note.googleEventId;
  if (eventId && current !== calendarId) {
    // Now belongs on another calendar (reminders calendar changed, or a reminder became an appointment).
    await deleteQuietly(current!, eventId);
    eventId = null;
  }
  if (eventId) {
    try {
      await updateEvent(calendarId, eventId, event);
    } catch (err) {
      // Deleted in Google Calendar: add it again.
      if (!(err instanceof GoogleApiError && [403, 404, 410].includes(err.status))) throw err;
      eventId = null;
    }
  }
  if (!eventId) eventId = await insertEvent(calendarId, event);
  await finish(note, { googleEventId: eventId, googleCalendarId: calendarId, syncError: null });
}

/**
 * Records the result without touching updatedAt (the list sorts by it). If the
 * note was edited while syncing, only the event's whereabouts are kept and it stays pending.
 */
async function finish(
  note: Note,
  data: { googleEventId?: string | null; googleCalendarId?: string | null; syncError: string | null },
) {
  const done = await prisma.note.updateMany({
    where: { id: note.id, updatedAt: note.updatedAt },
    data: { ...data, syncPending: false, updatedAt: note.updatedAt },
  });
  if (done.count === 0 && data.googleEventId !== undefined) {
    const current = await prisma.note.findUnique({ where: { id: note.id }, select: { updatedAt: true } });
    if (current) {
      await prisma.note.update({
        where: { id: note.id },
        data: { googleEventId: data.googleEventId, googleCalendarId: data.googleCalendarId, updatedAt: current.updatedAt },
      });
    }
  }
}

const MINUTE = 60_000;
const day = (d: Date) => d.toISOString().slice(0, 10);
const nextDay = (d: Date) => day(new Date(d.getTime() + 24 * 60 * MINUTE));

/**
 * The repeat rule as Google wants it. UNTIL stays a date for all-day events; for
 * timed ones it must be an instant, so it becomes the end of that day in the calendar's zone.
 */
function googleRecurrence(note: Note, timeZone: string, timed: boolean): string[] {
  if (!note.recurrence) return [];
  const until = parseRule(note.recurrence).until;
  let rule = note.recurrence;
  if (until && timed) {
    const instant = zonedInstant(`${until}T23:59:59`, timeZone)
      .toISOString()
      .replace(/\.\d{3}/, '')
      .replace(/[-:]/g, '');
    rule = rule.replace(/UNTIL=\d{8}/, `UNTIL=${instant}`);
  }
  return [`RRULE:${rule}`];
}

/** When a reminder with no time alerts, since Google can't alert "on the day" of an all-day event through the API. */
const REMINDER_TIME = '09:00';
/** How long a reminder shows on the calendar: long enough to read in the Google Calendar app's day view. */
const REMINDER_MINUTES = 30;
/** Appointments with no end time. */
const APPOINTMENT_MINUTES = 60;

export function toEvent(note: Note, t: Pick<Target, 'appUrl' | 'timeZone' | 'remindersColor'>): EventBody {
  const { timeZone } = t;
  const reminder = note.kind === 'REMINDER';
  const title = reminder ? `Reminder: ${note.title}` : note.title;
  const start = note.startsAt!;
  const end = note.endsAt ?? start;
  // Local wall time plus the zone: Google needs the zone to repeat "every Tuesday at 3" correctly across DST.
  const timed = (d: Date) => ({ dateTime: wallTime(d, timeZone), timeZone });
  let when: EventBody;
  if (reminder && note.allDay) {
    // A short item at 9 AM on the due day, so it can alert then.
    when = {
      start: { dateTime: `${day(start)}T${REMINDER_TIME}:00`, timeZone },
      end: { dateTime: wallTime(new Date(new Date(`${day(start)}T${REMINDER_TIME}:00Z`).getTime() + REMINDER_MINUTES * MINUTE), 'UTC'), timeZone },
    };
  } else if (note.allDay) {
    // All-day dates sit at 12:00 UTC (see notes.ts); Google's all-day end date is exclusive.
    when = { start: { date: day(start) }, end: { date: nextDay(end) } };
  } else {
    when = {
      start: timed(start),
      end: timed(note.endsAt ?? new Date(start.getTime() + (reminder ? REMINDER_MINUTES : APPOINTMENT_MINUTES) * MINUTE)),
    };
  }
  return {
    // A repeating reminder is ticked off one occurrence at a time, so the series never gets a check mark.
    summary: note.doneAt && !note.recurrence ? `✓ ${title}` : title,
    description: [note.body, `Open in the app: ${t.appUrl}/n/${note.id}`].filter(Boolean).join('\n\n'),
    location: note.location ?? undefined,
    ...when,
    // Updates replace the whole event, so an empty list also removes a repeat that was turned off.
    recurrence: googleRecurrence(note, timeZone, !(note.allDay && !reminder)),
    // Reminders alert when they're due (for the connected account; Google keeps alerts per person).
    // Appointments use each person's own defaults for the calendar.
    reminders: reminder ? { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] } : { useDefault: true },
    // Reminders show as free time, in their own color if one is set; one with an end is a
    // block of time set aside for the task, so it shows busy.
    ...(reminder && !note.endsAt ? { transparency: 'transparent' } : {}),
    ...(reminder && t.remindersColor ? { colorId: t.remindersColor } : {}),
    extendedProperties: { private: { noteId: note.id } },
  };
}

/** Removes a deleted note's event. Best effort: the note itself is already gone. */
export async function removeFromCalendar(googleEventId: string | null, googleCalendarId: string | null) {
  if (!googleEventId) return;
  const connection = await getConnection();
  const calendarId = googleCalendarId ?? connection?.calendarId;
  if (!calendarId || connection?.error) return;
  try {
    await deleteEvent(calendarId, googleEventId);
  } catch (err) {
    console.warn('Could not remove calendar event:', (err as Error).message);
  }
}

/**
 * After changing where events go (or how reminders look): queue everything that's
 * on a calendar, plus everything current, and the sync moves or restyles each one.
 * `kind` limits it to reminders when only their settings changed.
 */
export async function resync(kind?: 'REMINDER') {
  const yesterday = new Date(Date.now() - 24 * 60 * MINUTE);
  await prisma.note.updateMany({
    where: {
      kind: kind ?? { in: ['APPOINTMENT', 'REMINDER'] },
      OR: [
        { googleEventId: { not: null } },
        { endsAt: { gte: yesterday } },
        { endsAt: null, startsAt: { gte: yesterday } },
        // Open and repeating reminders, even overdue ones.
        { kind: 'REMINDER', doneAt: null, startsAt: { not: null } },
        { recurrence: { not: null } },
      ],
    },
    data: { syncPending: true },
  });
  kickCalendarSync();
}
