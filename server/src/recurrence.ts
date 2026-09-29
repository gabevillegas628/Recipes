/**
 * Repeating appointments and reminders, stored as an iCalendar RRULE (the format
 * Google Calendar takes), limited to what the app can edit and show:
 *
 *   FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, UNTIL (a date) or COUNT, and BYDAY:
 *   weekdays for weekly ("TU,TH"), or one weekday position for monthly ("2TU", "-1FR").
 *   Monthly without BYDAY repeats on the start's day of the month.
 *
 * Dates are "YYYY-MM-DD" calendar days. Shared by the server and the web app
 * (which imports this file), so it has no imports of its own.
 */

export const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type Freq = (typeof FREQS)[number];

/** Monday first, as iCalendar weeks start. */
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Rule {
  freq: Freq;
  interval: number;
  /** Weekly: the weekdays (n null). Monthly: at most one, with n 1-4 or -1 (last). */
  byDay: { n: number | null; day: Weekday }[];
  until: string | null;
  count: number | null;
}

export class RuleError extends Error {}

const DAY_RE = /^([+-]?\d)?(MO|TU|WE|TH|FR|SA|SU)$/;

/** Parses and checks a rule (with or without the "RRULE:" prefix). Throws RuleError. */
export function parseRule(text: string): Rule {
  const parts = new Map<string, string>();
  for (const part of text.trim().replace(/^RRULE:/i, '').split(';').filter(Boolean)) {
    const [key, value] = part.split('=');
    if (!key || value === undefined) throw new RuleError(`Can't read "${part}" in the repeat rule.`);
    parts.set(key.toUpperCase(), value.toUpperCase());
  }
  const unsupported = [...parts.keys()].filter((k) => !['FREQ', 'INTERVAL', 'BYDAY', 'UNTIL', 'COUNT', 'WKST'].includes(k));
  if (unsupported.length) {
    throw new RuleError(
      `Repeat rules can use FREQ, INTERVAL, BYDAY, UNTIL and COUNT only (not ${unsupported.join(', ')}). For "the 15th of every month", use FREQ=MONTHLY with the start on the 15th.`,
    );
  }

  const freq = parts.get('FREQ') as Freq | undefined;
  if (!freq || !FREQS.includes(freq)) throw new RuleError('A repeat rule needs FREQ=DAILY, WEEKLY, MONTHLY or YEARLY.');

  const interval = parts.has('INTERVAL') ? Number(parts.get('INTERVAL')) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 99) throw new RuleError('INTERVAL must be 1 to 99.');

  const byDay = (parts.get('BYDAY') ?? '')
    .split(',')
    .filter(Boolean)
    .map((d) => {
      const m = d.match(DAY_RE);
      if (!m) throw new RuleError(`"${d}" isn't a weekday like TU or 2TU.`);
      return { n: m[1] ? Number(m[1]) : null, day: m[2] as Weekday };
    });
  if (freq === 'WEEKLY' && byDay.some((d) => d.n !== null)) throw new RuleError('Weekly BYDAY takes plain weekdays, like TU,TH.');
  if (freq === 'MONTHLY') {
    const [first] = byDay;
    if (byDay.length > 1 || (first && (first.n === null || ![1, 2, 3, 4, -1].includes(first.n)))) {
      throw new RuleError('Monthly BYDAY takes one position and weekday, like 2TU (second Tuesday) or -1FR (last Friday).');
    }
  }
  if ((freq === 'DAILY' || freq === 'YEARLY') && byDay.length) throw new RuleError(`BYDAY doesn't go with FREQ=${freq}.`);

  let until: string | null = null;
  const rawUntil = parts.get('UNTIL');
  if (rawUntil) {
    const m = rawUntil.match(/^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/);
    if (!m) throw new RuleError('UNTIL must be a date like 20261231.');
    until = `${m[1]}-${m[2]}-${m[3]}`;
  }
  const count = parts.has('COUNT') ? Number(parts.get('COUNT')) : null;
  if (count !== null && (!Number.isInteger(count) || count < 1 || count > 999)) throw new RuleError('COUNT must be 1 to 999.');
  if (until && count) throw new RuleError('Use UNTIL or COUNT, not both.');

  return { freq, interval, byDay: sortDays(byDay), until, count };
}

function sortDays(days: Rule['byDay']) {
  return [...days].sort((a, b) => WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day));
}

export function formatRule(rule: Rule): string {
  return [
    `FREQ=${rule.freq}`,
    rule.interval > 1 ? `INTERVAL=${rule.interval}` : null,
    rule.byDay.length ? `BYDAY=${sortDays(rule.byDay).map((d) => `${d.n ?? ''}${d.day}`).join(',')}` : null,
    rule.until ? `UNTIL=${rule.until.replaceAll('-', '')}` : null,
    rule.count ? `COUNT=${rule.count}` : null,
  ]
    .filter(Boolean)
    .join(';');
}

// ---------- Calendar days ----------

const toDate = (day: string) => new Date(`${day}T00:00:00Z`);
const fromDate = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  const d = toDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return fromDate(d);
}

export function weekdayOf(day: string): Weekday {
  return WEEKDAYS[(toDate(day).getUTCDay() + 6) % 7];
}

const daysInMonth = (year: number, month0: number) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');
const dayString = (year: number, month0: number, date: number) => `${year}-${pad(month0 + 1)}-${pad(date)}`;

/** The nth (1-4, or -1 for last) given weekday of a month, or null if there isn't one. */
function nthWeekday(year: number, month0: number, n: number, day: Weekday): string | null {
  const target = WEEKDAYS.indexOf(day);
  const length = daysInMonth(year, month0);
  if (n === -1) {
    const lastIdx = (new Date(Date.UTC(year, month0, length)).getUTCDay() + 6) % 7;
    return dayString(year, month0, length - ((lastIdx - target + 7) % 7));
  }
  const firstIdx = (new Date(Date.UTC(year, month0, 1)).getUTCDay() + 6) % 7;
  const date = 1 + ((target - firstIdx + 7) % 7) + (n - 1) * 7;
  return date <= length ? dayString(year, month0, date) : null;
}

// ---------- Occurrences ----------

const MAX_YEARS = 100;

/**
 * Every occurrence on or after `start`, in order. The first one is `start` itself
 * when it fits the rule (the app lines the start up with the rule when saving).
 */
export function* occurrences(rule: Rule, start: string): Generator<string> {
  const [sy, sm, sd] = start.split('-').map(Number);
  const stop = dayString(sy + MAX_YEARS, sm - 1, 1);
  let emitted = 0;
  const within = (day: string) => day <= stop && (!rule.until || day <= rule.until);

  function* candidates(): Generator<string> {
    for (let k = 0; ; k++) {
      if (rule.freq === 'DAILY') {
        yield addDays(start, k * rule.interval);
      } else if (rule.freq === 'WEEKLY') {
        const weekStart = addDays(start, -WEEKDAYS.indexOf(weekdayOf(start)) + k * 7 * rule.interval);
        const days = rule.byDay.length ? sortDays(rule.byDay).map((d) => d.day) : [weekdayOf(start)];
        for (const d of days) yield addDays(weekStart, WEEKDAYS.indexOf(d));
      } else if (rule.freq === 'MONTHLY') {
        const m = sm - 1 + k * rule.interval;
        const year = sy + Math.floor(m / 12);
        const month0 = ((m % 12) + 12) % 12;
        const pos = rule.byDay[0];
        const day = pos ? nthWeekday(year, month0, pos.n!, pos.day) : sd <= daysInMonth(year, month0) ? dayString(year, month0, sd) : null;
        if (day) yield day;
        else if (year > sy + MAX_YEARS) return;
      } else {
        const year = sy + k * rule.interval;
        if (sd <= daysInMonth(year, sm - 1)) yield dayString(year, sm - 1, sd);
        else if (year > sy + MAX_YEARS) return;
      }
    }
  }

  for (const day of candidates()) {
    if (day < start) continue;
    if (!within(day)) return;
    yield day;
    if (rule.count && ++emitted >= rule.count) return;
  }
}

/** The first occurrence on or after `from`, or null when the series is over. */
export function nextOccurrence(rule: Rule, start: string, from: string): string | null {
  for (const day of occurrences(rule, start)) if (day >= from) return day;
  return null;
}

/** The series' true first day: `start` if it fits the rule, else the next day that does. */
export function firstOccurrence(rule: Rule, start: string): string | null {
  return occurrences({ ...rule, count: null, until: null }, start).next().value ?? null;
}

// ---------- Words ----------

const DAY_NAMES: Record<Weekday, string> = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
};
const ORDINALS: Record<number, string> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', [-1]: 'last' };

function ordinalDate(n: number) {
  const suffix = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

const shortDate = (day: string, withYear: boolean) =>
  toDate(day).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });

function joinWords(words: string[]) {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** "Every Tuesday", "Every 2 weeks on Monday and Wednesday", "Monthly on the last Friday", "…, until Dec 31". */
export function describeRule(rule: Rule, start: string): string {
  const every = (unit: string) => (rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${unit}s`);
  let text: string;
  if (rule.freq === 'DAILY') {
    text = every('day');
  } else if (rule.freq === 'WEEKLY') {
    const days = (rule.byDay.length ? rule.byDay.map((d) => d.day) : [weekdayOf(start)]).map((d) => DAY_NAMES[d]);
    const weekdays = days.length === 5 && !days.includes('Saturday') && !days.includes('Sunday');
    text =
      rule.interval === 1
        ? weekdays
          ? 'Every weekday'
          : `Every ${joinWords(days)}`
        : `${every('week')} on ${weekdays ? 'weekdays' : joinWords(days)}`;
  } else if (rule.freq === 'MONTHLY') {
    const pos = rule.byDay[0];
    const on = pos ? `the ${ORDINALS[pos.n!]} ${DAY_NAMES[pos.day]}` : `the ${ordinalDate(Number(start.slice(8)))}`;
    text = `${rule.interval === 1 ? 'Monthly' : every('month')} on ${on}`;
  } else {
    text = `${rule.interval === 1 ? 'Yearly' : every('year')} on ${shortDate(start, false)}`;
  }
  if (rule.until) text += `, until ${shortDate(rule.until, rule.until.slice(0, 4) !== start.slice(0, 4))}`;
  if (rule.count) text += `, ${rule.count} times`;
  return text;
}
