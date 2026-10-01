import { z } from 'zod';
import { kickCalendarSync, removeFromCalendar } from './calendarSync.js';
import { prisma } from './db.js';
import type { NoteKind, Prisma } from './generated/prisma/client.js';
import { deleteImage, uploadExists } from './images.js';
import { formatRule, nextOccurrence, parseRule, RuleError } from './recurrence.js';

/**
 * Notes, reminders and appointments. Everyone sees all of them.
 *
 * Times are stored as instants. An all-day date is stored at 12:00 UTC on that
 * date, so it reads as the same calendar day anywhere in the US without knowing
 * anyone's time zone.
 */

export const NOTE_KINDS = ['NOTE', 'REMINDER', 'APPOINTMENT'] as const satisfies readonly NoteKind[];

const include = { createdBy: { select: { name: true } } } satisfies Prisma.NoteInclude;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((s) => s || null);

const instant = z.iso.datetime({ offset: true }).nullish();

export const noteFields = z.object({
  kind: z.enum(NOTE_KINDS),
  title: z.string().trim().min(1, 'Give it a title').max(300),
  body: optionalText(20000),
  startsAt: instant,
  endsAt: instant,
  allDay: z.boolean().optional(),
  location: optionalText(500),
  /** An RRULE (see recurrence.ts), or null for a one-off. */
  recurrence: z.string().trim().max(300).nullish(),
});

export const createNoteBody = noteFields.extend({
  /** A photo stored by capture (the flyer this came from). */
  uploadedImage: z.string().nullish(),
});

export const updateNoteBody = noteFields.partial().extend({
  done: z.boolean().optional(),
  /** null removes the photo. */
  image: z.null().optional(),
});

type Fields = z.infer<typeof noteFields>;

/** All-day values are pinned to 12:00 UTC; see the note at the top. */
export function allDayInstant(date: string): Date {
  return new Date(`${date}T12:00:00.000Z`);
}

/**
 * Drops fields that don't apply to the kind: notes have no time, only
 * appointments have a place, and a reminder's end is a time on its day (a
 * block of time for the task, shown busy). Appointments need a start. Only
 * something with a date can repeat.
 */
function normalize(fields: Fields) {
  const kind = fields.kind;
  let startsAt = kind === 'NOTE' || !fields.startsAt ? null : new Date(fields.startsAt);
  const allDay = Boolean(startsAt && fields.allDay);
  let endsAt = fields.endsAt && (kind === 'APPOINTMENT' || (kind === 'REMINDER' && !allDay)) ? new Date(fields.endsAt) : null;
  if (allDay && startsAt) startsAt = allDayInstant(startsAt.toISOString().slice(0, 10));
  if (allDay && endsAt) endsAt = allDayInstant(endsAt.toISOString().slice(0, 10));
  if (startsAt && endsAt && endsAt < startsAt) endsAt = null;
  if (kind === 'APPOINTMENT' && !startsAt) throw new NoteError('An appointment needs a date.');
  let recurrence: string | null = null;
  if (startsAt && fields.recurrence) {
    try {
      recurrence = formatRule(parseRule(fields.recurrence));
    } catch (err) {
      if (err instanceof RuleError) throw new NoteError(err.message);
      throw err;
    }
  }
  return {
    kind,
    title: fields.title,
    body: fields.body ?? null,
    startsAt,
    endsAt,
    allDay,
    location: kind === 'APPOINTMENT' ? (fields.location ?? null) : null,
    recurrence,
  };
}

export class NoteError extends Error {}

export async function listNotes() {
  // Ticked-off reminders drop off after a month; repeating ones only tick off one occurrence.
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return prisma.note.findMany({
    where: { OR: [{ doneAt: null }, { doneAt: { gte: monthAgo } }, { recurrence: { not: null } }] },
    orderBy: { updatedAt: 'desc' },
    include,
  });
}

export async function getNote(id: string) {
  return prisma.note.findUnique({ where: { id }, include });
}

export async function createNote(input: z.infer<typeof createNoteBody>, userId: string | null) {
  const image = input.uploadedImage ? await uploadExists(input.uploadedImage) : null;
  const note = await prisma.note.create({
    data: { ...normalize(input), image, createdById: userId, syncPending: true },
    include,
  });
  kickCalendarSync();
  return note;
}

/** Returns null when there's no such note. */
export async function updateNote(id: string, input: z.infer<typeof updateNoteBody>) {
  const current = await prisma.note.findUnique({ where: { id } });
  if (!current) return null;

  const { done, image, ...changes } = input;
  const merged: Fields = {
    kind: changes.kind ?? current.kind,
    title: changes.title ?? current.title,
    body: changes.body !== undefined ? changes.body : current.body,
    startsAt: changes.startsAt !== undefined ? changes.startsAt : current.startsAt?.toISOString(),
    endsAt: changes.endsAt !== undefined ? changes.endsAt : current.endsAt?.toISOString(),
    allDay: changes.allDay ?? current.allDay,
    location: changes.location !== undefined ? changes.location : current.location,
    recurrence: changes.recurrence !== undefined ? changes.recurrence : current.recurrence,
  };
  const note = await prisma.note.update({
    where: { id },
    data: {
      ...normalize(merged),
      // A repeating reminder is ticked off one occurrence at a time, so each tick is dated now.
      ...(done !== undefined
        ? { doneAt: done ? (current.recurrence ? new Date() : (current.doneAt ?? new Date())) : null }
        : {}),
      ...(image === null ? { image: null } : {}),
      syncPending: true,
    },
    include,
  });
  if (image === null) await deleteImage(current.image);
  kickCalendarSync();
  return note;
}

export async function deleteNote(id: string) {
  const note = await prisma.note.findUnique({ where: { id }, select: { image: true, googleEventId: true, googleCalendarId: true } });
  if (!note) return false;
  await prisma.note.delete({ where: { id } });
  await deleteImage(note.image);
  void removeFromCalendar(note.googleEventId, note.googleCalendarId);
  return true;
}

/**
 * Removes appointments that are completely over from Mise, leaving their Google
 * Calendar events in place as history. Only past ones are removed, whatever ids
 * are sent: one-offs whose end has passed, and repeating series with no dates left.
 */
export async function forgetPastAppointments(ids: string[]) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const candidates = await prisma.note.findMany({
    where: { id: { in: ids }, kind: 'APPOINTMENT' },
    select: { id: true, startsAt: true, endsAt: true, allDay: true, recurrence: true, image: true },
  });
  const past = candidates.filter((n) => {
    if (!n.startsAt) return false;
    if (n.recurrence) {
      // Close enough at the edges: a series ending today is kept until tomorrow.
      try {
        return nextOccurrence(parseRule(n.recurrence), n.startsAt.toISOString().slice(0, 10), today) === null;
      } catch {
        return false;
      }
    }
    const end = n.endsAt ?? n.startsAt;
    // All-day items are pinned to noon UTC; count them as over once that day is.
    return n.allDay ? end.toISOString().slice(0, 10) < today : end < now;
  });
  await prisma.note.deleteMany({ where: { id: { in: past.map((n) => n.id) } } });
  await Promise.all(past.map((n) => deleteImage(n.image)));
  return past.length;
}
