import { z } from 'zod';
import { kickCalendarSync, removeFromCalendar } from './calendarSync.js';
import { prisma } from './db.js';
import type { NoteKind, Prisma } from './generated/prisma/client.js';
import { deleteImage, uploadExists } from './images.js';

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
 * appointments have an end or a place. Appointments need a start.
 */
function normalize(fields: Fields) {
  const kind = fields.kind;
  let startsAt = kind === 'NOTE' || !fields.startsAt ? null : new Date(fields.startsAt);
  let endsAt = kind === 'APPOINTMENT' && fields.endsAt ? new Date(fields.endsAt) : null;
  const allDay = Boolean(startsAt && fields.allDay);
  if (allDay && startsAt) startsAt = allDayInstant(startsAt.toISOString().slice(0, 10));
  if (allDay && endsAt) endsAt = allDayInstant(endsAt.toISOString().slice(0, 10));
  if (startsAt && endsAt && endsAt < startsAt) endsAt = null;
  if (kind === 'APPOINTMENT' && !startsAt) throw new NoteError('An appointment needs a date.');
  return {
    kind,
    title: fields.title,
    body: fields.body ?? null,
    startsAt,
    endsAt,
    allDay,
    location: kind === 'APPOINTMENT' ? (fields.location ?? null) : null,
  };
}

export class NoteError extends Error {}

export async function listNotes() {
  // Ticked-off reminders drop off after a month.
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return prisma.note.findMany({
    where: { OR: [{ doneAt: null }, { doneAt: { gte: monthAgo } }] },
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
  };
  const note = await prisma.note.update({
    where: { id },
    data: {
      ...normalize(merged),
      ...(done !== undefined ? { doneAt: done ? (current.doneAt ?? new Date()) : null } : {}),
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
  const note = await prisma.note.findUnique({ where: { id }, select: { image: true, googleEventId: true } });
  if (!note) return false;
  await prisma.note.delete({ where: { id } });
  await deleteImage(note.image);
  void removeFromCalendar(note.googleEventId);
  return true;
}
