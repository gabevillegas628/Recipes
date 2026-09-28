import type { Note, NoteDraft, NoteInput, NoteKind } from './types';

/**
 * Dates for notes, reminders and appointments. The form works in the phone's
 * local date and time; all-day values are stored at 12:00 UTC on their date
 * (matching the server), so they're read back with UTC fields.
 */

export interface NoteValues {
  kind: NoteKind;
  title: string;
  body: string;
  date: string;
  time: string;
  endDate: string;
  endTime: string;
  location: string;
}

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
  };
}

const allDayIso = (date: string) => `${date}T12:00:00.000Z`;
const localIso = (date: string, time: string) => new Date(`${date}T${time}`).toISOString();

/** No start time means all day. An end needs an end time, or a later end date for all-day ones. */
export function inputFromValues(v: NoteValues): NoteInput {
  const timed = v.kind !== 'NOTE' && Boolean(v.date);
  const allDay = timed && !v.time;
  let startsAt: string | null = null;
  let endsAt: string | null = null;
  if (timed) {
    startsAt = allDay ? allDayIso(v.date) : localIso(v.date, v.time);
    if (v.kind === 'APPOINTMENT') {
      const endDate = v.endDate || v.date;
      if (allDay) endsAt = v.endDate && v.endDate > v.date ? allDayIso(v.endDate) : null;
      else if (v.endTime) endsAt = localIso(endDate, v.endTime);
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
  };
}

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

/** "3:30 PM – 4:30 PM", "All day", or "until Sat, Oct 10". Without the day when `withDay` is false. */
export function timeLabel(n: Note, withDay = true): string {
  if (!n.startsAt) return '';
  const startDay = dayOf(n.startsAt, n.allDay);
  const endDay = n.endsAt ? dayOf(n.endsAt, n.allDay) : startDay;
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

/** Whether a reminder's due date (or time) has passed. */
export function isOverdue(n: Note): boolean {
  if (!n.startsAt || n.doneAt) return false;
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
