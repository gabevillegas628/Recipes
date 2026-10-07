import { dayOf, localDate, nextOn } from './notes';
import type { EventOwner, Note, TodayCalendar } from './types';

/**
 * Whose time is whose on a day, for whoever's looking: which calendar events are
 * someone else's, what keeps you busy, and the free time in between. Times are
 * minutes since local midnight, like blockOn in notes.ts.
 */

type CalendarEvent = TodayCalendar['events'][number];

export type Household = { people: NonNullable<TodayCalendar['people']>; me: string | null };

/** A stretch of a day, in minutes since midnight. */
export interface Span {
  start: number;
  end: number;
}

/** Free time shorter than this isn't worth showing. */
export const MIN_FREE_MINUTES = 30;

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

/** Minutes since `day`'s local midnight; before it is 0 and after it is the whole day. */
function minutesInto(day: string, at: Date) {
  const [y, m, d] = day.split('-').map(Number);
  const minutes = (at.getTime() - new Date(y, m - 1, d).getTime()) / 60_000;
  return Math.min(24 * 60, Math.max(0, Math.round(minutes)));
}

/** Whether a reminder with a time block falls on `day` and hasn't been ticked off there. */
function blockOn(n: Note, day: string): boolean {
  if (n.kind !== 'REMINDER' || !n.startsAt || !n.endsAt || n.allDay) return false;
  if (!n.recurrence) return !n.doneAt && dayOf(n.startsAt, false) === day;
  // A repeating one is ticked off up to the day of its last tick.
  return nextOn(n, day) === day && !(n.doneAt && localDate(new Date(n.doneAt)) >= day);
}

/**
 * Your busy time on `day`: timed calendar events that are yours, the family's or
 * unclear (not someone else's, and not marked free), and the time blocks of your
 * own reminders. All-day events and plain reminders (no end) don't take time.
 */
export function busyOn(
  day: string,
  events: CalendarEvent[],
  notes: Note[],
  household: Household,
  userName: string,
): Span[] {
  const spans: Span[] = [];
  for (const e of events) {
    if (!e.start || !e.end || e.free || ownership(e.owner, household).theirs) continue;
    spans.push({ start: minutesInto(day, new Date(e.start)), end: minutesInto(day, new Date(e.end)) });
  }
  for (const n of notes) {
    // Reminders are only the family's to share when they're yours.
    if (n.createdBy && n.createdBy.name !== userName) continue;
    if (!blockOn(n, day)) continue;
    const at = new Date(n.startsAt!);
    const start = minutesInto(localDate(at), at);
    const length = Math.round((new Date(n.endsAt!).getTime() - at.getTime()) / 60_000);
    spans.push({ start, end: Math.min(24 * 60, start + length) });
  }
  return spans.filter((s) => s.end > s.start);
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
