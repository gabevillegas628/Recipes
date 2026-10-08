import { dayOf, localDate, nextOn } from './notes';
import type { EventOwner, Note, TodayCalendar } from './types';

/**
 * Whose time is whose on a day, for whoever's looking: which calendar events are
 * someone else's, what keeps you busy, the free time in between, and where a
 * reminder that clashes could go instead. Times are minutes since local
 * midnight, like blockOn in notes.ts.
 */

type CalendarEvent = TodayCalendar['events'][number];

export type Household = { people: NonNullable<TodayCalendar['people']>; me: string | null };

/** A stretch of a day, in minutes since midnight. A plain reminder is a moment: start === end. */
export interface Span {
  start: number;
  end: number;
}

/** Something that takes your time: a calendar event, or one of your reminders (noteId set). */
export interface Busy extends Span {
  title: string;
  noteId: string | null;
}

/** One of your reminders on a day, as a span. */
export interface ReminderOn extends Span {
  note: Note;
}

/** Free time shorter than this isn't worth showing. */
export const MIN_FREE_MINUTES = 30;
/** Times offered are on the five minutes, and a plain reminder needs this much room. */
const STEP = 5;

/**
 * How an event shows for whoever's looking. Another adult's (or no one's) is
 * theirs; a child's isn't, since it usually needs a grown-up. Events that aren't
 * yours are named with whose they are. Everyone's and unsure ones count as yours.
 */
export function ownership(owner: EventOwner | null | undefined, { people, me }: Household): { theirs: boolean; names: string[] } {
  if (!owner || owner.everyone || owner.unsure) return { theirs: false, names: [] };
  if (owner.people.length === 0) return { theirs: true, names: [] };
  if (me && owner.people.includes(me)) return { theirs: false, names: [] };
  const named = owner.people.flatMap((id) => people.find((p) => p.id === id) ?? []);
  // Not in the household by name: nothing is anyone else's, but whose it is still shows.
  return { theirs: Boolean(me) && named.every((p) => p.adult), names: named.map((p) => p.name) };
}

/** "14:30" as minutes since midnight. */
export const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Minutes since midnight as "14:30". */
export const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Minutes since `day`'s local midnight; before it is 0 and after it is the whole day. */
export function minutesInto(day: string, at: Date) {
  const [y, m, d] = day.split('-').map(Number);
  const minutes = (at.getTime() - new Date(y, m - 1, d).getTime()) / 60_000;
  return Math.min(24 * 60, Math.max(0, Math.round(minutes)));
}

/** Whether a timed reminder falls on `day` and hasn't been ticked off there. */
function remindsOn(n: Note, day: string): boolean {
  if (n.kind !== 'REMINDER' || !n.startsAt || n.allDay) return false;
  if (!n.recurrence) return !n.doneAt && dayOf(n.startsAt, false) === day;
  // A repeating one is ticked off up to the day of its last tick.
  return nextOn(n, day) === day && !(n.doneAt && localDate(new Date(n.doneAt)) >= day);
}

/** Your timed reminders on `day` that aren't ticked off. Reminders are only yours when you made them. */
export function remindersOn(day: string, notes: Note[], userName: string): ReminderOn[] {
  return notes
    .filter((n) => (!n.createdBy || n.createdBy.name === userName) && remindsOn(n, day))
    .map((note) => {
      const at = new Date(note.startsAt!);
      const start = minutesInto(localDate(at), at);
      const length = note.endsAt ? Math.round((new Date(note.endsAt).getTime() - at.getTime()) / 60_000) : 0;
      return { note, start, end: Math.min(24 * 60, start + Math.max(0, length)) };
    });
}

/**
 * Your busy time on `day`: timed calendar events that are yours, the family's or
 * unclear (not someone else's, and not marked free), and the time blocks of your
 * own reminders. All-day events and plain reminders (no end) don't take time.
 * `skip` leaves out a reminder (the one being moved or edited).
 */
export function busyOn(
  day: string,
  events: CalendarEvent[],
  notes: Note[],
  household: Household,
  userName: string,
  skip?: string,
): Busy[] {
  // Reminders' own calendar copies are counted from the reminders themselves.
  const reminders = new Set(notes.filter((n) => n.kind === 'REMINDER').map((n) => n.id));
  const busy: Busy[] = [];
  for (const e of events) {
    if (!e.start || !e.end || e.free || (e.noteId && reminders.has(e.noteId))) continue;
    if (ownership(e.owner, household).theirs) continue;
    busy.push({ title: e.title, noteId: null, start: minutesInto(day, new Date(e.start)), end: minutesInto(day, new Date(e.end)) });
  }
  for (const r of remindersOn(day, notes, userName)) {
    if (r.note.id !== skip && r.end > r.start) busy.push({ title: r.note.title, noteId: r.note.id, start: r.start, end: r.end });
  }
  return busy.filter((b) => b.end > b.start);
}

/** Whether a span runs into a busy one. A moment clashes when it falls inside (a reminder at 2:00 during 2:00–3:00). */
export function overlaps(a: Span, b: Span): boolean {
  if (a.start === a.end) return b.start <= a.start && a.start < b.end;
  if (b.start === b.end) return a.start <= b.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

/** The gaps between busy spans within [from, to], at least `min` minutes long. */
export function freeBetween(busy: Span[], from: number, to: number, min = MIN_FREE_MINUTES): Span[] {
  const free: Span[] = [];
  let cursor = from;
  for (const s of [...busy].sort((a, b) => a.start - b.start)) {
    if (s.start > cursor) free.push({ start: cursor, end: Math.min(s.start, to) });
    cursor = Math.max(cursor, s.end);
    if (cursor >= to) break;
  }
  if (cursor < to) free.push({ start: cursor, end: to });
  return free.filter((f) => f.end - f.start >= min);
}

/**
 * The free time nearest `want` that fits it, as the same length, within
 * [from, to], on the five minutes. Null when nothing that long is free.
 */
export function nearestFree(busy: Span[], want: Span, from: number, to: number): Span | null {
  const length = want.end - want.start;
  const room = Math.max(length, STEP);
  let best: Span | null = null;
  for (const gap of freeBetween(busy, from, to, room)) {
    const latest = gap.end - room;
    const clamped = Math.min(latest, Math.max(gap.start, want.start));
    // Round onto the five minutes, staying inside the gap.
    const up = Math.ceil(clamped / STEP) * STEP;
    const start = up <= latest ? up : Math.floor(clamped / STEP) * STEP;
    if (start < gap.start) continue;
    if (!best || Math.abs(start - want.start) < Math.abs(best.start - want.start)) best = { start, end: start + length };
  }
  return best;
}

/** A reminder's move, as Sort out my day plans it: to a new time that day, to the next day, or nowhere it fits. */
export interface Move {
  note: Note;
  from: Span;
  to: Span | null;
  /** The day it moves to; the next one when its own is full. */
  day: string;
}

/** The reminders on a day that run into a calendar event or another reminder. */
export function clashingReminders(reminders: ReminderOn[], events: Busy[]): Set<string> {
  return new Set(
    reminders
      .filter((r) => events.some((e) => overlaps(r, e)) || reminders.some((o) => o.note.id !== r.note.id && overlaps(r, o)))
      .map((r) => r.note.id),
  );
}

/** Room a span takes once placed: a plain reminder keeps its five minutes. */
const room = (s: Span): Span => ({ start: s.start, end: Math.max(s.end, s.start + STEP) });

/**
 * Untangles clashes on `day`. Calendar events and locked reminders stay put, as
 * do reminders that don't clash. The rest, earliest first: one that no longer
 * clashes with what's settled stays (of two that overlap, the earlier keeps its
 * time); otherwise it goes to the nearest free time that day within the window,
 * or the nearest the day after (`next`) when it's full.
 */
export function planMoves(
  reminders: ReminderOn[],
  events: Busy[],
  locked: Set<string>,
  window: { from: number; to: number },
  next: { day: string; busy: Busy[]; from: number; to: number } | null,
  day: string,
): Move[] {
  const clashing = clashingReminders(reminders, events);
  const unsettled = reminders.filter((r) => clashing.has(r.note.id) && !locked.has(r.note.id)).sort((a, b) => a.start - b.start);
  const taken: Span[] = [...events, ...reminders.filter((r) => !unsettled.includes(r)).map(room)];
  const takenNext: Span[] = next ? [...next.busy] : [];
  const moves: Move[] = [];
  for (const r of unsettled) {
    const span = { start: r.start, end: r.end };
    if (!taken.some((t) => overlaps(span, t))) {
      taken.push(room(span));
      continue;
    }
    const here = nearestFree(taken, span, window.from, window.to);
    if (here) {
      taken.push(room(here));
      moves.push({ note: r.note, from: span, to: here, day });
      continue;
    }
    const there = next ? nearestFree(takenNext, span, next.from, next.to) : null;
    if (there) takenNext.push(room(there));
    moves.push({ note: r.note, from: span, to: there, day: there && next ? next.day : day });
  }
  return moves;
}

/**
 * Where a reminder `length` minutes long starts when dropped among a day's rows:
 * as the nearest row above it ends, or, with nothing above, so it ends as the
 * first row below starts. Rows are spans of your time, or null for ones that
 * don't take it (all-day events, someone else's); a free row counts as its start.
 * Null when no row has a time.
 */
export function dropStart(above: (Span | null)[], below: (Span | null)[], length: number): number | null {
  const before = above.filter((s): s is Span => s !== null).at(-1);
  const after = below.find((s): s is Span => s !== null);
  const start = before ? before.end : after ? after.start - length : null;
  return start === null ? null : Math.min(24 * 60 - length, Math.max(0, start));
}
