import { z } from 'zod';
import { tagKey, tagTitles, type Tag } from './eventTags.js';
import { findTimes, type BusyEvent, type TimeOption } from './findTime.js';
import { calendarTimeZone, getConnection, listEvents, type CalendarEvent } from './google.js';
import { getHousehold, type Household } from './household.js';
import { addDays, weekdayOf, WEEKDAYS } from './recurrence.js';
import { wallTime, zonedInstant } from './zone.js';

/**
 * "Find a time": reads the family calendar for the dates asked about, works out
 * whose each event is (eventTags.ts), runs the finder (findTime.ts), and words
 * the options. Capture fills in the request from what was typed; the options
 * screen re-runs it after a tag or the travel time is changed. Also finds a slot
 * for one person's task (capture.ts), with the reminders calendar counted as
 * that calendar's owner's busy time.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const findTimeInput = z.object({
  /** For the appointment it becomes. */
  title: z.string().trim().min(1).max(300),
  location: z.string().trim().max(500).nullable(),
  details: z.string().trim().max(5000).nullable(),
  /** Household person ids who have to be there. */
  people: z.array(z.string()).min(1, 'Say who it’s for').max(20),
  from: z.string().regex(DATE),
  to: z.string().regex(DATE),
  durationMinutes: z.number().int().min(5).max(12 * 60),
  /** Overrides of the household's usual hours and weekdays, when the request says ("mornings", "Saturday's fine"). */
  hoursStart: z.string().regex(HHMM).nullable(),
  hoursEnd: z.string().regex(HHMM).nullable(),
  days: z.array(z.enum(WEEKDAYS)).min(1).nullable(),
  /** Each way. 0 for a call or something at home; null for the household's usual travel time. */
  travelMinutes: z.number().int().min(0).max(240).nullable().optional(),
});

export type FindTimeInput = z.infer<typeof findTimeInput>;

export class FindTimeError extends Error {}

const MAX_DAYS = 31;
const WEEKDAYS_ONLY = WEEKDAYS.slice(0, 5);
/** Nothing is offered sooner than this from now. */
const LEAD_MINUTES = 15;

/** The household person a user is, by name or alias. */
export function personFor(household: Household, name: string | null | undefined) {
  const n = name?.trim().toLowerCase();
  if (!n) return null;
  return household.people.find((p) => p.name.toLowerCase() === n || p.aliases.some((a) => a.toLowerCase() === n)) ?? null;
}

export async function runFindTime(input: FindTimeInput) {
  if (input.to < input.from) [input.from, input.to] = [input.to, input.from];
  if (addDays(input.from, MAX_DAYS) < input.to) throw new FindTimeError('Look at a month or less at a time.');

  const household = await getHousehold();
  if (!household.people.length) throw new FindTimeError('Add your household in Settings first, so the app knows whose events are whose.');
  const connection = await getConnection();
  if (!connection?.calendarId || connection.error) {
    throw new FindTimeError('Connect Google Calendar in Settings first, so the app can see when everyone is busy.');
  }
  const timeZone = (await calendarTimeZone(connection.calendarId, connection.timeZone)) ?? 'UTC';
  const people = input.people.filter((id) => household.people.some((p) => p.id === id));
  if (!people.length) throw new FindTimeError('Say who it’s for, by a name in your household.');

  // A day either side, so travel time around the edges sees what's there.
  const from = zonedInstant(`${addDays(input.from, -1)}T00:00:00`, timeZone);
  const to = zonedInstant(`${addDays(input.to, 2)}T00:00:00`, timeZone);
  // The reminders calendar is its owner's (whoever connected Google): busy blocks there,
  // like a task slot already booked, are their busy time. Free ones (plain reminders) aren't.
  const owner = connection.remindersCalendarId && connection.remindersCalendarId !== connection.calendarId ? personFor(household, connection.connectedBy?.name) : null;
  const [all, ownerEvents] = await Promise.all([
    listEvents(connection.calendarId, from, to),
    owner ? listEvents(connection.remindersCalendarId!, from, to) : Promise.resolve([]),
  ]);
  const timed = all.filter((e) => e.start && e.end && !e.free);
  const tags = await tagTitles(timed.map((e) => e.title), household);
  const tagOf = (title: string) => tags.get(tagKey(title))!;

  // Every timed, busy event with whose it is. A tag with no one on it (set by hand) takes no one's time.
  const shown: BusyEvent[] = [
    ...timed.map((e) => {
      const tag = tagOf(e.title);
      return { title: e.title, start: e.start!, end: e.end!, people: tag.people, everyone: tag.everyone || tag.unsure };
    }),
    ...ownerEvents.filter((e) => e.start && e.end && !e.free).map((e) => ({ title: e.title, start: e.start!, end: e.end!, people: [owner!.id], everyone: false })),
  ];
  const busy = shown.filter((e) => e.everyone || e.people.length);
  const travelMinutes = input.travelMinutes ?? household.travelMinutes;

  // "After 6" moves only the start; past the usual end, the evening runs to 10 (and "before 7 AM" from 6).
  const hoursStart = input.hoursStart ?? (input.hoursEnd && input.hoursEnd <= household.hoursStart ? '06:00' : household.hoursStart);
  const hoursEnd = input.hoursEnd ?? (input.hoursStart && input.hoursStart >= household.hoursEnd ? '22:00' : household.hoursEnd);
  const options = findTimes(
    household.people,
    busy,
    {
      from: input.from,
      to: input.to,
      durationMinutes: input.durationMinutes,
      people,
      hoursStart,
      hoursEnd,
      days: input.days ?? WEEKDAYS_ONLY,
      notBefore: Date.now() + LEAD_MINUTES * 60_000,
    },
    {
      travelMinutes,
      schoolStart: household.schoolStart,
      schoolEnd: household.schoolEnd,
      timeZone,
    },
  );

  const inRange = (d: Date) => d >= zonedInstant(`${input.from}T00:00:00`, timeZone) && d < zonedInstant(`${addDays(input.to, 1)}T00:00:00`, timeZone);
  const notes: string[] = [];
  for (const e of all) {
    if (e.allDayDate && e.allDayDate >= input.from && e.allDayDate <= input.to) notes.push(`${dayLabel(e.allDayDate)}: ${e.title} (all day)`);
  }
  const unsure = [...new Set(timed.filter((e) => inRange(e.start!) && tagOf(e.title).unsure).map((e) => e.title))];
  if (unsure.length) {
    notes.push(
      `Counted ${unsure.map((t) => `“${t}”`).join(', ')} as busy for everyone, since ${unsure.length === 1 ? 'it doesn’t' : 'they don’t'} say who ${unsure.length === 1 ? 'it’s' : 'they’re'} for. Fix it below if that’s wrong.`,
    );
  }

  // Each title seen in the range once, with whose it is, for correcting.
  const seen = new Map<string, { title: string; tag: Tag; firstAt: Date }>();
  for (const e of timed) {
    if (!inRange(e.start!) || seen.has(tagKey(e.title))) continue;
    seen.set(tagKey(e.title), { title: e.title, tag: tagOf(e.title), firstAt: e.start! });
  }

  return {
    input: { ...input, people, travelMinutes: input.travelMinutes ?? null },
    summary: summarize(input, people, household, travelMinutes),
    /** Each way, as used: the request's, or the household's usual. */
    travelMinutes,
    options: options.map((o) => ({
      ...describe(o, input, people, household),
      dayView: dayView(o, all, shown, { hoursStart, hoursEnd, timeZone, travelMinutes, durationMinutes: input.durationMinutes, household }),
    })),
    notes,
    calendar: [...seen.values()].map(({ title, tag }) => ({ title, ...tag })),
    people: household.people.map(({ id, name, adult }) => ({ id, name, adult })),
  };
}

export type FindTimeResult = Awaited<ReturnType<typeof runFindTime>>;

// ---------- The day, for a glance ----------

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/**
 * One option's day, for the little timeline under it: the hours to draw, each
 * timed event as minutes since midnight with whose lanes it fills, the trip
 * (travel, then the visit, then travel) at the earliest start, and school.
 */
function dayView(
  o: TimeOption,
  all: CalendarEvent[],
  shown: BusyEvent[],
  s: { hoursStart: string; hoursEnd: string; timeZone: string; travelMinutes: number; durationMinutes: number; household: Household },
) {
  const dayStart = zonedInstant(`${o.day}T00:00:00`, s.timeZone);
  const dayEnd = zonedInstant(`${addDays(o.day, 1)}T00:00:00`, s.timeZone);
  const minutesInto = (d: Date) => (d <= dayStart ? 0 : d >= dayEnd ? 24 * 60 : minutesOf(wallTime(d, s.timeZone).slice(11, 16)));

  const events = shown
    .filter((e) => e.start < dayEnd && e.end > dayStart)
    .map((e) => ({ title: e.title, start: minutesInto(e.start), end: minutesInto(e.end), everyone: e.everyone, people: e.people }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const trip = {
    start: minutesOf(o.firstStart) - s.travelMinutes,
    visitStart: minutesOf(o.firstStart),
    visitEnd: minutesOf(o.firstStart) + s.durationMinutes,
    end: minutesOf(o.firstStart) + s.durationMinutes + s.travelMinutes,
    /** Latest start in the window, when there's a range. */
    lastStart: minutesOf(o.lastStart),
  };
  const school =
    s.household.schoolStart && s.household.schoolEnd && WEEKDAYS_ONLY.includes(weekdayOf(o.day))
      ? { start: minutesOf(s.household.schoolStart), end: minutesOf(s.household.schoolEnd) }
      : null;

  // The usual hours, widened to whole hours that take in the trip.
  const from = Math.max(0, Math.floor(Math.min(minutesOf(s.hoursStart), trip.start) / 60) * 60);
  const to = Math.min(24 * 60, Math.ceil(Math.max(minutesOf(s.hoursEnd), trip.end + trip.lastStart - trip.visitStart) / 60) * 60);

  return {
    from,
    to,
    events,
    allDay: all.filter((e) => e.allDayDate && e.allDayDate <= o.day && o.day < (e.allDayEnd ?? addDays(e.allDayDate, 1))).map((e) => e.title),
    trip,
    school,
  };
}

// ---------- Words ----------

function dayLabel(day: string) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}

function clock(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function plusMinutes(hhmm: string, minutes: number) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = Math.min(23 * 60 + 59, h * 60 + m + minutes);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function duration(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const h = minutes / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} hr`;
}

const names = (list: string[]) => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

function summarize(input: FindTimeInput, people: string[], household: Household, travelMinutes: number) {
  const who = names(people.map((id) => household.people.find((p) => p.id === id)!.name));
  const when = input.from === input.to ? dayLabel(input.from) : `${dayLabel(input.from)} – ${dayLabel(input.to)}`;
  const travel = travelMinutes ? ` · ${travelMinutes} min travel each way` : ' · no travel';
  return `${who} · ${when} · about ${duration(input.durationMinutes)}${travel}`;
}

function describe(o: TimeOption, input: FindTimeInput, people: string[], household: Household) {
  const nameOf = (id: string) => household.people.find((p) => p.id === id)!.name;
  const kids = people.filter((id) => !household.people.find((p) => p.id === id)!.adult).map(nameOf);
  const needsDriver = kids.length > 0 && people.every((id) => !household.people.find((p) => p.id === id)!.adult);
  const reasons: string[] = [];
  let driver: string | null = null;

  if (needsDriver) {
    const free = o.freeAdults.map(nameOf);
    const who = names(kids);
    if (o.otherKidEvents.length) {
      reasons.push(`${names(free)} are free; one takes ${who}, the other ${names(o.otherKidEvents)}`);
      driver = `${names(free)} (the other has ${names(o.otherKidEvents)})`;
    } else if (free.length > 1) {
      reasons.push(`${free.join(' or ')} can take ${who}`);
      driver = free.join(' or ');
    } else {
      const busy = o.busyAdults.map((b) => `${nameOf(b.id)} has ${b.title}`);
      reasons.push(`${free[0]} can take ${who}${busy.length ? ` (${busy.join('; ')})` : ''}`);
      driver = free[0];
    }
  } else {
    reasons.push(people.length > 1 ? 'Everyone who needs to be there is free' : `${nameOf(people[0])} is free`);
  }
  if (kids.length && household.schoolStart) {
    reasons.push(o.missesSchool ? `${names(kids)} would miss some school` : 'No school missed');
  }

  const window = o.firstStart === o.lastStart ? `Start at ${clock(o.firstStart)}` : `Start any time ${clock(o.firstStart)}–${clock(o.lastStart)}`;
  return {
    day: dayLabel(o.day),
    window,
    reasons,
    missesSchool: o.missesSchool,
    /** The appointment it becomes, at the earliest start. */
    draft: {
      date: o.day,
      time: o.firstStart,
      endTime: plusMinutes(o.firstStart, input.durationMinutes),
      body: [driver ? `Driving: ${driver}` : null, input.details].filter(Boolean).join('\n\n') || null,
    },
  };
}
