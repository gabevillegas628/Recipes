import {
  addDays,
  describeRule,
  firstOccurrence,
  formatRule,
  nextOccurrence,
  parseRule,
  weekdayOf,
  type Freq,
  type Rule,
  type Weekday,
} from '../../server/src/recurrence';
import type { Note, NoteDraft, NoteInput, NoteKind } from './types';

/**
 * Dates for notes, reminders and appointments. The form works in the phone's
 * local date and time; all-day values are stored at 12:00 UTC on their date
 * (matching the server), so they're read back with UTC fields. Repeat rules
 * (recurrence.ts) are shared with the server.
 */

export interface RepeatValues {
  /** '' for no repeat. */
  freq: Freq | '';
  interval: string;
  /** Weekly: which days. */
  days: Weekday[];
  /** Monthly: same date, same weekday position (second Tuesday), or last such weekday. */
  monthly: 'date' | 'nth' | 'last';
  ends: 'never' | 'until' | 'count';
  until: string;
  count: string;
}

export interface NoteValues {
  kind: NoteKind;
  title: string;
  body: string;
  date: string;
  time: string;
  endDate: string;
  endTime: string;
  location: string;
  repeat: RepeatValues;
}

export const NO_REPEAT: RepeatValues = {
  freq: '',
  interval: '1',
  days: [],
  monthly: 'date',
  ends: 'never',
  until: '',
  count: '',
};

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-10-06" for a local date. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The calendar day an instant falls on, as "YYYY-MM-DD". */
export function dayOf(iso: string, allDay: boolean): string {
  return allDay ? iso.slice(0, 10) : localDate(new Date(iso));
}

const daysBetween = (a: string, b: string) =>
  Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000);

// ---------- Repeats ----------

export function ruleOf(n: Pick<Note, 'recurrence'>): Rule | null {
  try {
    return n.recurrence ? parseRule(n.recurrence) : null;
  } catch {
    return null;
  }
}

function repeatFromRule(text: string | null): RepeatValues {
  const rule = ruleOf({ recurrence: text });
  if (!rule) return NO_REPEAT;
  const pos = rule.freq === 'MONTHLY' ? rule.byDay[0] : undefined;
  return {
    freq: rule.freq,
    interval: String(rule.interval),
    days: rule.freq === 'WEEKLY' ? rule.byDay.map((d) => d.day) : [],
    monthly: pos ? (pos.n === -1 ? 'last' : 'nth') : 'date',
    ends: rule.until ? 'until' : rule.count ? 'count' : 'never',
    until: rule.until ?? '',
    count: rule.count ? String(rule.count) : '',
  };
}

/** The form's repeat choices as a rule. Weekly days default to the start's weekday; monthly positions come from the start. */
export function ruleFromRepeat(v: RepeatValues, date: string): Rule | null {
  if (!v.freq || !date) return null;
  const weekday = weekdayOf(date);
  const dom = Number(date.slice(8));
  // Only choices the date allows: "last" needs the month's final week; the 29th-31st can only be "last".
  const positions = monthlyPositions(date);
  const last = (v.monthly === 'last' && positions.last) || !positions.nth;
  const byDay: Rule['byDay'] =
    v.freq === 'WEEKLY'
      ? (v.days.length ? v.days : [weekday]).map((day) => ({ n: null, day }))
      : v.freq === 'MONTHLY' && v.monthly !== 'date'
        ? [{ n: last ? -1 : Math.ceil(dom / 7), day: weekday }]
        : [];
  const count = Math.round(Number(v.count));
  return {
    freq: v.freq,
    interval: Math.min(99, Math.max(1, Math.round(Number(v.interval)) || 1)),
    byDay,
    until: v.ends === 'until' && v.until >= date ? v.until : null,
    count: v.ends === 'count' && count > 0 ? Math.min(999, count) : null,
  };
}

/**
 * "the second Tuesday" / "the last Tuesday" for the monthly options, from the start
 * date. A fifth weekday (the 29th-31st) can only be "the last".
 */
export function monthlyPositions(date: string): { nth: string | null; last: string | null } {
  const dom = Number(date.slice(8));
  const name = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' });
  const daysInMonth = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();
  return {
    nth: dom <= 28 ? `the ${['first', 'second', 'third', 'fourth'][Math.ceil(dom / 7) - 1]} ${name}` : null,
    last: dom + 7 > daysInMonth ? `the last ${name}` : null,
  };
}

/** "Every Tuesday" and so on, or '' for a one-off. */
export function repeatLabel(n: Note): string {
  const rule = ruleOf(n);
  return rule && n.startsAt ? describeRule(rule, dayOf(n.startsAt, n.allDay)) : '';
}

/**
 * The day an appointment or reminder next falls on, on or after `from`: its own
 * date for a one-off, the next occurrence for a repeating one (null once it's over).
 */
export function nextOn(n: Note, from: string): string | null {
  const start = dayOf(n.startsAt!, n.allDay);
  const rule = ruleOf(n);
  return rule ? nextOccurrence(rule, start, from) : start;
}

/** Appointments with no end time count as an hour long, as on Google Calendar. */
const DEFAULT_APPOINTMENT_MS = 60 * 60_000;

/**
 * The day an appointment is next coming up, or null once it's over. Timed ones
 * are over when they end, not at midnight; for a repeating one, today's
 * occurrence counts as over once it ends, so the next date shows. All-day ones
 * last the whole day.
 */
export function comingUpOn(n: Note, now = new Date()): string | null {
  const today = localDate(now);
  const start = new Date(n.startsAt!);
  const firstDay = dayOf(n.startsAt!, n.allDay);
  const length = n.endsAt ? new Date(n.endsAt).getTime() - start.getTime() : DEFAULT_APPOINTMENT_MS;
  const rule = ruleOf(n);
  if (!rule) {
    if (n.allDay) return dayOf(n.endsAt ?? n.startsAt!, true) >= today ? (firstDay < today ? today : firstDay) : null;
    // Already under way from an earlier day: show it under today.
    return start.getTime() + length > now.getTime() ? (firstDay < today ? today : firstDay) : null;
  }
  const next = nextOccurrence(rule, firstDay, today);
  if (next === today && !n.allDay) {
    const todays = new Date(`${today}T${localTime(start)}`).getTime();
    if (todays + length <= now.getTime()) return nextOccurrence(rule, firstDay, addDays(today, 1));
  }
  return next;
}

/** A repeating reminder's current occurrence: the next one after the last tick, and not before today. */
export function reminderDue(n: Note): string | null {
  const today = localDate(new Date());
  const afterTick = n.doneAt ? addDays(localDate(new Date(n.doneAt)), 1) : today;
  return nextOn(n, afterTick > today ? afterTick : today);
}

// ---------- Form values ----------

export function valuesFromDraft(d: NoteDraft): NoteValues {
  return {
    kind: d.kind,
    title: d.title,
    body: d.body ?? '',
    date: d.date ?? '',
    time: d.time ?? '',
    endDate: d.endDate ?? '',
    endTime: d.endTime ?? '',
    location: d.location ?? '',
    repeat: repeatFromRule(d.recurrence),
  };
}

export function valuesFromNote(n: Note): NoteValues {
  const start = n.startsAt;
  const end = n.endsAt;
  const endDay = end ? dayOf(end, n.allDay) : '';
  const startDay = start ? dayOf(start, n.allDay) : '';
  return {
    kind: n.kind,
    title: n.title,
    body: n.body ?? '',
    date: startDay,
    time: start && !n.allDay ? localTime(new Date(start)) : '',
    endDate: endDay && endDay !== startDay ? endDay : '',
    endTime: end && !n.allDay ? localTime(new Date(end)) : '',
    location: n.location ?? '',
    repeat: repeatFromRule(n.recurrence),
  };
}

const allDayIso = (date: string) => `${date}T12:00:00.000Z`;
const localIso = (date: string, time: string) => new Date(`${date}T${time}`).toISOString();

/** A one-off reminder moved to another day, keeping its time of day (and how long its block is). */
export function movedToDay(n: Note, day: string): Pick<NoteInput, 'startsAt' | 'endsAt'> {
  if (n.allDay) return { startsAt: allDayIso(day), endsAt: null };
  const startsAt = localIso(day, localTime(new Date(n.startsAt!)));
  const length = n.endsAt ? new Date(n.endsAt).getTime() - new Date(n.startsAt!).getTime() : null;
  return { startsAt, endsAt: length !== null ? new Date(new Date(startsAt).getTime() + length).toISOString() : null };
}

/** A reminder set to a time block on a day; times are minutes since midnight. */
export function blockOn(day: string, start: number, end: number): Pick<NoteInput, 'startsAt' | 'endsAt' | 'allDay'> {
  const t = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  return { startsAt: localIso(day, t(start)), endsAt: localIso(day, t(Math.min(end, 24 * 60 - 1))), allDay: false };
}

/**
 * No start time means all day. An end needs an end time, or a later end date for
 * all-day ones; a reminder's end is a time later the same day. A repeating item starts on its first occurrence, so "every
 * Thursday" dated a Monday moves to that Thursday (and its end with it).
 */
export function inputFromValues(v: NoteValues): NoteInput {
  const timed = v.kind !== 'NOTE' && Boolean(v.date);
  const rule = timed ? ruleFromRepeat(v.repeat, v.date) : null;
  let date = v.date;
  let endDate = v.endDate;
  const first = rule ? firstOccurrence(rule, date) : null;
  if (first && first !== date) {
    if (endDate) endDate = addDays(endDate, daysBetween(date, first));
    date = first;
  }

  const allDay = timed && !v.time;
  let startsAt: string | null = null;
  let endsAt: string | null = null;
  if (timed) {
    startsAt = allDay ? allDayIso(date) : localIso(date, v.time);
    if (v.kind === 'APPOINTMENT') {
      if (allDay) endsAt = endDate && endDate > date ? allDayIso(endDate) : null;
      else if (v.endTime) endsAt = localIso(endDate || date, v.endTime);
    } else if (!allDay && v.endTime > v.time) {
      // A reminder's end makes it a block of time on its day.
      endsAt = localIso(date, v.endTime);
    }
  }
  return {
    kind: v.kind,
    title: v.title.trim(),
    body: v.body.trim() || null,
    startsAt,
    endsAt,
    allDay,
    location: v.kind === 'APPOINTMENT' ? v.location.trim() || null : null,
    recurrence: rule ? formatRule(rule) : null,
  };
}

// ---------- Labels ----------

/** "Today", "Tomorrow", "Friday" (this week), else "Tue, Oct 6" (with the year if it isn't this one). */
export function dayLabel(day: string): string {
  const today = new Date();
  const todayKey = localDate(today);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (day === todayKey) return 'Today';
  if (day === localDate(tomorrow)) return 'Tomorrow';
  if (day === localDate(yesterday)) return 'Yesterday';

  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const daysAway = Math.round((date.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
  if (daysAway > 1 && daysAway < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(y !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * "3:30 PM – 4:30 PM", "All day", or "until Sat, Oct 10". Without the day when
 * `withDay` is false. `on` is the occurrence to describe, for repeating items.
 */
export function timeLabel(n: Note, withDay = true, on?: string): string {
  if (!n.startsAt) return '';
  const firstDay = dayOf(n.startsAt, n.allDay);
  const startDay = on ?? firstDay;
  const endDay = n.endsAt ? addDays(startDay, daysBetween(firstDay, dayOf(n.endsAt, n.allDay))) : startDay;
  const day = withDay ? `${dayLabel(startDay)} · ` : '';
  if (n.allDay) {
    return endDay !== startDay ? `${day}All day, until ${dayLabel(endDay)}` : withDay ? dayLabel(startDay) : 'All day';
  }
  const start = clock(n.startsAt);
  if (!n.endsAt) return `${day}${start}`;
  return endDay === startDay
    ? `${day}${start} – ${clock(n.endsAt)}`
    : `${day}${start} – ${dayLabel(endDay)} ${clock(n.endsAt)}`;
}

/** Whether a one-off reminder's due date (or time) has passed. Repeating ones just move on. */
export function isOverdue(n: Note): boolean {
  if (!n.startsAt || n.doneAt || n.recurrence) return false;
  return n.allDay ? dayOf(n.startsAt, true) < localDate(new Date()) : new Date(n.startsAt) < new Date();
}

/** The phone's current date and time in words, so the AI can resolve "next Tuesday". */
export function nowInWords(): string {
  return new Date().toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}
