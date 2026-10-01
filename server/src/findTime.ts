import { addDays, weekdayOf, type Weekday } from './recurrence.js';
import { wallTime, zonedInstant } from './zone.js';

/**
 * Finding a time: which windows in a date range work for the people who have to
 * be there, given who's busy when. Pure arithmetic, no AI and no I/O, so it's
 * easy to test; findTimeService.ts gathers the calendar and names the results.
 *
 * - The trip is the appointment plus travel before and after; everyone who has
 *   to go must be free for all of it.
 * - A child needs an adult along, and so does any other child's event in that
 *   time ("JJ speech"): there must be enough free adults to cover all of them.
 * - Time in school is allowed but ranked last ("better to avoid").
 * - Start times are tried every 15 minutes and joined into windows ("start any
 *   time from 3:30 to 4:00"), then ranked and trimmed to a short list.
 */

export interface Person {
  id: string;
  name: string;
  adult: boolean;
}

export interface BusyEvent {
  title: string;
  start: Date;
  end: Date;
  /** HouseholdPerson ids. */
  people: string[];
  /** The whole family, or unknown (treated the same). */
  everyone: boolean;
}

export interface FindRequest {
  /** "YYYY-MM-DD", inclusive. */
  from: string;
  to: string;
  durationMinutes: number;
  /** Who has to be there (ids). A child brings along one free adult automatically. */
  people: string[];
  /** Usual hours, "HH:MM", and the weekdays they apply to. */
  hoursStart: string;
  hoursEnd: string;
  days: Weekday[];
  /** No trip may start before this instant (ms): now, so nothing is offered in the past. */
  notBefore?: number;
}

export interface FindSettings {
  travelMinutes: number;
  /** Weekdays only; null for no school. */
  schoolStart: string | null;
  schoolEnd: string | null;
  timeZone: string;
}

export interface TimeOption {
  day: string;
  /** "HH:MM": the window of start times that work. */
  firstStart: string;
  lastStart: string;
  /** Adults free for the whole trip (ids), when an adult has to come along. */
  freeAdults: string[];
  /** Adults who aren't, with what they're doing. */
  busyAdults: { id: string; title: string }[];
  /** Other kids' events in that time that also need an adult. */
  otherKidEvents: string[];
  /** A child going would leave school early or arrive late. */
  missesSchool: boolean;
}

const STEP_MINUTES = 15;
const MAX_OPTIONS = 5;
const MAX_PER_DAY = 2;
const SCHOOL_DAYS: Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR'];
const MINUTE = 60_000;

const overlaps = (e: { start: Date; end: Date }, a: number, b: number) => e.start.getTime() < b && e.end.getTime() > a;
const involves = (e: BusyEvent, id: string) => e.everyone || e.people.includes(id);

export function findTimes(people: Person[], events: BusyEvent[], req: FindRequest, s: FindSettings): TimeOption[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const required = req.people.filter((id) => byId.has(id));
  const requiredKids = required.filter((id) => !byId.get(id)!.adult);
  const requiredAdults = required.filter((id) => byId.get(id)!.adult);
  const adults = people.filter((p) => p.adult).map((p) => p.id);
  const kidIds = new Set(people.filter((p) => !p.adult).map((p) => p.id));
  // Kids' events (with no adult named) need an adult to take them.
  const kidEvents = events.filter(
    (e) => !e.everyone && e.people.length > 0 && e.people.every((id) => kidIds.has(id)) && !e.people.some((id) => requiredKids.includes(id)),
  );
  const needsDriver = requiredKids.length > 0 && requiredAdults.length === 0;

  const duration = req.durationMinutes * MINUTE;
  const travel = s.travelMinutes * MINUTE;
  const found: (TimeOption & { startMs: number })[] = [];

  for (let day = req.from; day <= req.to; day = addDays(day, 1)) {
    const weekday = weekdayOf(day);
    if (!req.days.includes(weekday)) continue;
    const at = (hhmm: string) => zonedInstant(`${day}T${hhmm}:00`, s.timeZone).getTime();
    const open = at(req.hoursStart);
    const close = at(req.hoursEnd);
    const school =
      requiredKids.length && s.schoolStart && s.schoolEnd && SCHOOL_DAYS.includes(weekday)
        ? { start: at(s.schoolStart), end: at(s.schoolEnd) }
        : null;

    let current: (TimeOption & { startMs: number; lastMs: number; key: string }) | null = null;
    for (let start = open; start + duration <= close; start += STEP_MINUTES * MINUTE) {
      const tripStart = start - travel;
      const tripEnd = start + duration + travel;
      if (req.notBefore !== undefined && tripStart < req.notBefore) continue;
      const inTrip = events.filter((e) => overlaps(e, tripStart, tripEnd));
      const busy = (id: string) => inTrip.find((e) => involves(e, id));

      let option: Omit<TimeOption, 'day' | 'firstStart' | 'lastStart'> | null = null;
      if (!required.some(busy)) {
        const freeAdults = adults.filter((id) => !busy(id));
        const others = kidEvents.filter((e) => inTrip.includes(e)).map((e) => e.title);
        const adultsNeeded = requiredAdults.length + (needsDriver ? 1 : 0) + others.length;
        if (freeAdults.length >= adultsNeeded) {
          option = {
            freeAdults,
            busyAdults: adults.filter((id) => busy(id)).map((id) => ({ id, title: busy(id)!.title })),
            otherKidEvents: [...new Set(others)],
            missesSchool: Boolean(school && tripStart < school.end && tripEnd > school.start),
          };
        }
      }

      const key = option ? JSON.stringify(option) : '';
      if (current && (!option || key !== current.key || start !== current.lastMs + STEP_MINUTES * MINUTE)) {
        found.push(current);
        current = null;
      }
      if (option) {
        if (current) {
          current.lastMs = start;
          current.lastStart = clock(start, s.timeZone);
        } else {
          const t = clock(start, s.timeZone);
          current = { ...option, day, firstStart: t, lastStart: t, startMs: start, lastMs: start, key };
        }
      }
    }
    if (current) found.push(current);
  }

  return rank(found, needsDriver).map(({ day, firstStart, lastStart, freeAdults, busyAdults, otherKidEvents, missesSchool }) => ({
    day,
    firstStart,
    lastStart,
    freeAdults,
    busyAdults,
    otherKidEvents,
    missesSchool,
  }));
}

const clock = (ms: number, timeZone: string) => wallTime(new Date(ms), timeZone).slice(11, 16);

/**
 * Best first: no school missed, then (when someone has to drive) more adults free,
 * then earliest. At most two a day, so the list offers a spread of days.
 */
function rank<T extends TimeOption & { startMs: number }>(options: T[], needsDriver: boolean): T[] {
  const sorted = [...options].sort(
    (a, b) =>
      Number(a.missesSchool) - Number(b.missesSchool) ||
      (needsDriver ? b.freeAdults.length - a.freeAdults.length : 0) ||
      a.startMs - b.startMs,
  );
  const perDay = new Map<string, number>();
  const picked: T[] = [];
  for (const option of sorted) {
    const n = perDay.get(option.day) ?? 0;
    if (n >= MAX_PER_DAY) continue;
    perDay.set(option.day, n + 1);
    picked.push(option);
    if (picked.length === MAX_OPTIONS) break;
  }
  return picked;
}
