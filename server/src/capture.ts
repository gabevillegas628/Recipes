import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { env } from './env.js';
import { saveImage } from './images.js';
import type { RecipeDraft, ImportMethod } from './import/draft.js';
import { ImportError } from './import/errors.js';
import { writeRecipe } from './import/ai.js';
import { extractFromPhotos, extractFromText, extractFromUrl, preparePhotos } from './import/extract.js';
import { FetchError } from './import/safeFetch.js';
import { FindTimeError, personFor, runFindTime, type FindTimeInput, type FindTimeResult } from './findTimeService.js';
import { GoogleApiError, GoogleAuthError } from './google.js';
import { getHousehold, type Household } from './household.js';
import { findExistingRecipe } from './import/worker.js';
import { addDays, firstOccurrence, formatRule, nextOccurrence, WEEKDAYS, type Rule } from './recurrence.js';

/**
 * "Capture": something typed, dictated, pasted or photographed, sorted by Claude
 * into a note, reminder, appointment, recipe or grocery list, or a request to
 * find a time for something or to write a recipe. Nothing is saved here; the app
 * shows the result for a quick check first. Recipes (found or written) and grocery
 * lists hand off to the existing recipe review and grocery list; finding a time
 * runs findTimeService.ts.
 */

const client = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const classification = z.object({
  today: z.string().describe("Today's date, YYYY-MM-DD, from the current date given"),
  kind: z.enum(['note', 'reminder', 'appointment', 'recipe', 'writeRecipe', 'groceries', 'findTime']),
  title: z.string().describe('Short title, e.g. "Dentist: Maya" or "Call the plumber"'),
  details: z
    .string()
    .nullable()
    .describe('Everything else worth keeping, as plain text. null if the title says it all.'),
  date: z.string().nullable().describe('YYYY-MM-DD: when the appointment is, or when the reminder is due'),
  time: z.string().nullable().describe('HH:MM, 24-hour, local time. null for all day or no time given'),
  endDate: z.string().nullable().describe('YYYY-MM-DD, only for appointments that end on a later day'),
  endTime: z.string().nullable().describe('HH:MM, 24-hour, when the appointment ends, if stated'),
  location: z.string().nullable().describe('Appointments only: the place or address, as given'),
  groceryItems: z.array(z.string()).describe('Groceries only: one item per entry, with amounts. Empty otherwise.'),
  repeat: z
    .object({
      freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
      interval: z.number().int().describe('1 for every week, 2 for every other week, and so on'),
      weekdays: z.array(z.enum(WEEKDAYS)).describe('Weekly only: the days, e.g. ["TU","TH"]. Empty for the weekday of date.'),
      monthlyBy: z
        .enum(['date', 'weekday', 'lastWeekday'])
        .nullable()
        .describe('Monthly only: same day of the month (the 15th), same weekday position (second Tuesday), or last weekday (last Friday)'),
      until: z.string().nullable().describe('YYYY-MM-DD of the last possible occurrence, if stated'),
      count: z.number().int().nullable().describe('How many times in total, if stated'),
    })
    .nullable()
    .describe('Only for appointments and reminders that repeat'),
  schedule: z
    .object({
      people: z.array(z.string()).describe('findTime: household names of who has to be there, exactly as listed. Empty for a task.'),
      durationMinutes: z.number().int().describe('How long it takes there, or how long doing the task takes'),
      travelMinutes: z.number().int().describe("Each way. 0 when there's no trip; -1 for the family's usual travel time"),
      from: z.string().describe('YYYY-MM-DD, first day to look at'),
      to: z.string().describe('YYYY-MM-DD, last day to look at'),
      earliest: z.string().describe('HH:MM, only when it has to fit certain hours; "" otherwise'),
      latest: z.string().describe('HH:MM, only when it has to fit certain hours; "" otherwise'),
      days: z.array(z.enum(WEEKDAYS)).describe('findTime: only if the request limits or widens the days, e.g. weekends. Empty otherwise.'),
      deadline: z.string().describe('Task: YYYY-MM-DD it has to be done by, or the date it leads up to; "" if none'),
      startBy: z.string().describe('Task with a deadline: YYYY-MM-DD to get started; "" otherwise'),
      why: z.string().describe('Task with a deadline: one short sentence on the timing, for the person; "" otherwise'),
    })
    .nullable()
    .describe('For findTime, and for a reminder to do something with no time of day stated, that the app should find a slot for'),
});

const SYSTEM = `You file things for a family's shared organizer app. The input was typed, dictated (so expect speech-to-text slips and filler words), pasted, or photographed (a flyer, a letter from school, an appointment card, a screenshot).

Decide what it is:
- appointment: something happening at a particular date that takes up someone's time, where they have to be somewhere or are busy: a doctor's visit, a school event, a party, a class, a haircut, proctoring a makeup exam, an event on a flyer. Even when it's just one person's, it goes on the family calendar so everyone knows they're busy.
- reminder: something someone needs to do, or to be nudged about, with or without a deadline: "remind me to call the plumber", "I need to call the insurance company", "pay the water bill Friday", "return library books". There's no separate to-do list: these are all reminders.
- note: information to keep, not an action or event: gift ideas, a wifi password, sizes, a phone number, a thought.
- recipe: ingredients or cooking steps for a dish, or a link to a recipe.
- writeRecipe: asking for a recipe to be written or suggested, with no recipe given: "give me a weeknight chili recipe", "what can I make with chicken thighs and rice", "a gluten-free birthday cake for Saturday". Just naming a dish to remember or try ("try Mom's lasagna sometime") is a note or reminder instead.
- groceries: a list of things to buy at the store.
- findTime: asking when something could be scheduled, with no time settled yet: "I need to schedule Evan an eye appointment sometime the week of 11/2", "when could I fit in a haircut next week", "find a night for date night this month". If a time is already set, it's an appointment instead.

Then fill in the fields:
- title: short and scannable, the way someone would write it in a calendar. For events, lead with what it is, and add who it's for when stated ("Dentist: Maya").
- details: keep anything useful that isn't in the other fields, such as what to bring, cost, phone numbers, links, or registration deadlines. Keep the person's own wording for dictated notes, minus filler words. Don't repeat the title, date, time or place.
- Reminders, by how they're timed:
  - A time is stated ("call Mom at 7", "tonight at 8"), or it repeats: date and time, no schedule.
  - A nudge on a day with no time ("remind me Friday it's Grandma's birthday", "trash night Tuesday"): the date, plus a sensible time for it (usually 09:00; the evening for trash and things for the next morning), no schedule.
  - Something to do that takes a bit of time, with no time of day stated ("I need to call the insurance company", "renew the passport by March 1", "pay the water bill Friday", "drop the library books off"): fill in schedule (a task) and leave date and time null; the app books a free slot on the person's calendar. people and days stay empty.
    - durationMinutes: realistic time to do it: a call to an office 30 (they put you on hold), paying a bill online 10, an errand 20 plus travel, a form 30.
    - travelMinutes: each way to where it's done: 0 for calls, online and at home; around 15 for an errand in town. Never -1 for a task.
    - A deadline, or a date it leads up to ("renew the passport by March 1", "hire a contractor for a renovation starting March 15"): the point of the reminder is to start at the right time, not now. deadline is that date. startBy is when to get started: the deadline minus the realistic lead time, plus some slack. Contractors book up two to three months ahead and need time for quotes; a passport takes six to eight weeks; booking a popular venue months; mail a few days; a bill due Friday a day or two. why says so in a sentence ("Contractors book up 2-3 months out, so start in early December."). Don't repeat the deadline in details; the app adds it.
    - from and to: with a deadline, the same as startBy. Otherwise the days it could be done. A day stated ("Friday") is that day; with no timeframe, today through two days from today. Never before today.
    - earliest and latest: only when it has to fit certain hours: business hours (09:00-17:00) for calling an office or a business, opening hours for errands. "" otherwise.
  - Someday, with no timeframe ("fix the fence gate someday"): no date, no time, no schedule.
- date and time: resolve relative dates ("next Tuesday", "the 14th", "tomorrow at 3") against the current date given below. When a flyer gives a month and day with no year, use the next time that date comes up. For reminders, see above. If only a time is given for a reminder, use today, or tomorrow if that time has passed.
- repeat: only when it recurs ("every Tuesday", "the first Monday of each month", "every other week", "daily until Friday"). date is then the first occurrence on or after today.
- For a recipe, a recipe to write or a grocery list, only kind and title matter (plus groceryItems for groceries).
- findTime: title is what the appointment will be called ("Eye appointment: Evan"); details and location as for appointments. In schedule:
  - people: who has to be there, by household name. "Me" or "I" is the person typing; "us" or "we" is the two adults. For a child's appointment, list just the child; the app adds a parent to take them.
  - from and to: the days to look at. "The week of 11/2" is that Monday to the Sunday after; "next week" is next Monday to Sunday; "this month" runs from today; with no dates given, the next two weeks. Never before today.
  - durationMinutes: as stated, else typical time there: a doctor, dentist or eye exam 60, a haircut 30, a dinner out 90.
  - earliest, latest and days: only when the request says ("after 4", "mornings", "weekends are fine", "not Monday"); otherwise "" and empty, and the family's usual weekday hours apply.
  - travelMinutes: 0 when there's no trip (a phone or video call, something at home, or at the place the person already is, like their own workplace); -1 for anywhere else, and the family's usual travel time applies.
  - deadline, startBy and why: "".`;

export type NoteDraft = {
  kind: 'NOTE' | 'REMINDER' | 'APPOINTMENT';
  title: string;
  body: string | null;
  date: string | null;
  time: string | null;
  endDate: string | null;
  endTime: string | null;
  location: string | null;
  /** An RRULE when it repeats (see recurrence.ts). */
  recurrence: string | null;
  /** The photo, stored, to keep with the note. */
  uploadedImage: string | null;
};

type RecipeResult = {
  draft: RecipeDraft;
  method: ImportMethod;
  duplicateOf: { id: string; title: string } | null;
  uploadedImage?: string | null;
};

export type CaptureResult =
  | { kind: 'note'; note: NoteDraft; slot?: Slot }
  | { kind: 'recipe'; recipe: RecipeResult }
  | { kind: 'groceries'; items: string[] }
  | { kind: 'findTime'; find: FindTimeResult };

export const captureEnabled = client !== null;

/**
 * `now` is the phone's local date and time in words, e.g. "Monday, September 28, 2026 at 2:05 PM EDT";
 * `userName` is who's typing, so "me" means someone.
 */
export async function capture(text: string, photos: Buffer[], now: string, userName: string | null): Promise<CaptureResult> {
  if (!client) throw new ImportError("Sorting needs AI, which isn't set up on the server (ANTHROPIC_API_KEY).");
  text = text.trim().slice(0, 20_000);
  if (!text && photos.length === 0) throw new ImportError('Type something or add a photo first.');

  const [prepared, household] = await Promise.all([preparePhotos(photos), getHousehold()]);
  const response = await client.beta.messages.parse({
    model: env.anthropicModel,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: zodOutputFormat(classification) },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          ...prepared.map((photo) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: photo.toString('base64') },
          })),
          {
            type: 'text' as const,
            text: `It is now ${now}.${familyContext(household, userName)}${text ? `\n\n<input>\n${text}\n</input>` : ''}`,
          },
        ],
      },
    ],
  });

  console.info(
    JSON.stringify({
      msg: 'ai capture',
      model: response.model,
      kind: response.parsed_output?.kind ?? null,
      stopReason: response.stop_reason,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      photos: photos.length || undefined,
    }),
  );

  if (response.stop_reason === 'refusal') throw new ImportError('The AI declined to process this.');
  const result = response.parsed_output;
  if (!result) throw new ImportError("Couldn't make sense of that. Try again, or add a bit more detail.");

  if (result.kind === 'recipe') return { kind: 'recipe', recipe: await recipeFrom(text, photos) };
  if (result.kind === 'writeRecipe' && text) {
    return { kind: 'recipe', recipe: { draft: await writeRecipe(text), method: 'generated', duplicateOf: null } };
  }
  if (result.kind === 'findTime' && result.schedule) return { kind: 'findTime', find: await findTimeFrom(result, household) };
  if (result.kind === 'groceries' && result.groceryItems.length > 0) {
    return { kind: 'groceries', items: result.groceryItems.map((s) => s.trim()).filter(Boolean) };
  }

  const kind = result.kind === 'appointment' ? 'APPOINTMENT' : result.kind === 'reminder' ? 'REMINDER' : 'NOTE';
  let date = result.date && DATE.test(result.date) ? result.date : null;
  const rule = kind !== 'NOTE' && date && result.repeat ? ruleFrom(result.repeat, date) : null;
  // Line the start up with the rule ("every Thursday" said on a Monday starts Thursday),
  // and start from today, not an occurrence already past ("last Friday of the month" said after it).
  // (Counted from the AI's date, which sets the day of the month for monthly and yearly repeats.)
  const today = DATE.test(result.today) ? result.today : null;
  const endless = rule && { ...rule, until: null, count: null };
  const first =
    endless && date ? (today && date < today ? nextOccurrence(endless, date, today) : firstOccurrence(endless, date)) : null;
  if (first) date = first;
  const valid = (t: string | null) => (t && TIME.test(t) ? t : null);
  // A task with no time stated gets a free slot on the person's calendar.
  const slot =
    kind === 'REMINDER' && result.schedule && !valid(result.time) && !rule ? await slotFor(result, household, userName) : null;
  const note: NoteDraft = {
    kind,
    title: result.title.trim() || text.slice(0, 80),
    // A grocery list with no items falls through as a note; keep what was typed.
    body: result.details?.trim() || (result.kind === 'groceries' ? text || null : null),
    date,
    time: date ? valid(result.time) : null,
    endDate: date && result.endDate && DATE.test(result.endDate) ? result.endDate : null,
    endTime: date ? valid(result.endTime) : null,
    location: result.location?.trim() || null,
    recurrence: rule ? formatRule(rule) : null,
    uploadedImage: photos.length ? await saveImage(photos[0]).catch(() => null) : null,
  };
  if (slot?.picked) Object.assign(note, slot.picked, { endDate: null });
  // No slot: keep it due on the last day it was meant for, at least.
  else if (slot && !note.date) note.date = slot.lastDay;
  if (!slot) return { kind: 'note', note };
  // The deadline goes with the reminder, for when it goes off months from now.
  if (slot.deadline) note.body = [`By ${dayName(slot.deadline, true)}`, note.body].filter(Boolean).join('\n\n');
  const { picked: _picked, lastDay: _lastDay, deadline: _deadline, ...shown } = slot;
  return { kind: 'note', note, slot: shown };
}

/** A slot the app picked for a task, and how: for the check screen and "Pick another time". */
export type Slot = {
  /** What was looked at ("Gabe · Thu – Sat · about 30 min · no travel"), or why nothing was. */
  summary: string;
  /** The search, to run again for other options; null when it couldn't run. */
  input: FindTimeInput | null;
  notes: string[];
  /** With a deadline: when it's for and why the time was picked ("By Mon, Mar 15, 2027. Contractors book up…"). */
  why: string | null;
  /** The booked time's day, for the timeline (FindTimeDay), and who's who in it. */
  day: { view: FindTimeResult['options'][number]['dayView']; people: FindTimeResult['people'] } | null;
};

/**
 * Books a task into the first free slot for the person typing, the trip included
 * (travel there, doing it, travel back): soon, or before the deadline. When the
 * days asked about are full, the two weeks after. When there's no calendar to
 * look at, the reminder keeps just a date.
 */
async function slotFor(
  result: z.infer<typeof classification>,
  household: Household,
  userName: string | null,
): Promise<Slot & { picked: Pick<NoteDraft, 'date' | 'time' | 'endTime'> | null; lastDay: string; deadline: string | null }> {
  const t = result.schedule!;
  const today = DATE.test(result.today) ? result.today : new Date().toISOString().slice(0, 10);
  const deadline = t.deadline && DATE.test(t.deadline) && t.deadline >= today ? t.deadline : null;
  const given = deadline && t.startBy && DATE.test(t.startBy) && t.startBy <= deadline ? t.startBy : null;
  // No start given: two weeks ahead of the deadline.
  const startBy = deadline ? (given ?? addDays(deadline, -14)) : null;
  let from: string;
  let to: string;
  if (deadline) {
    // Around when to start; once that's passed, as soon as possible.
    from = startBy && startBy > today ? startBy : today;
    to = addDays(from, from === today ? 2 : 4);
    if (to > deadline) to = deadline < from ? from : deadline;
  } else {
    from = DATE.test(t.from) && t.from > today ? t.from : today;
    to = DATE.test(t.to) && t.to >= from ? t.to : addDays(from, 2);
    if (addDays(from, 14) < to) to = addDays(from, 14);
  }
  const timing = deadline
    ? {
        deadline,
        why: [
          `By ${dayName(deadline, true)}.`,
          startBy && startBy > today ? (given ? t.why?.trim() : 'Two weeks ahead of it.') : 'That’s soon, so the first free time.',
        ]
          .filter(Boolean)
          .join(' '),
      }
    : { deadline: null, why: null };
  const me = personFor(household, userName);
  if (!me) {
    return { summary: 'Add yourself to the household in Settings so the app can find you a free time.', input: null, notes: [], day: null, picked: null, lastDay: to, ...timing };
  }
  const time = (v: string | null) => (v && TIME.test(v) ? v : null);
  const input: FindTimeInput = {
    title: result.title.trim() || 'Task',
    location: null,
    details: result.details?.trim() || null,
    people: [me.id],
    from,
    to,
    durationMinutes: Math.min(8 * 60, Math.max(5, t.durationMinutes || 30)),
    hoursStart: time(t.earliest) ?? TASK_HOURS.start,
    hoursEnd: time(t.latest) ?? TASK_HOURS.end,
    days: [...WEEKDAYS],
    travelMinutes: Math.min(240, Math.max(0, t.travelMinutes || 0)),
  };
  try {
    let found = await runFindTime(input);
    const notes: string[] = [];
    if (!found.options.length) {
      const later = await runFindTime({ ...input, from: addDays(to, 1), to: addDays(to, 14) });
      notes.push(
        later.options.length
          ? `Nothing free by ${dayName(to)}, so this is the first free time after.`
          : `Nothing free by ${dayName(addDays(to, 14))}. Pick a time yourself.`,
      );
      found = later;
    }
    const o = found.options[0];
    const trip = o?.dayView.trip;
    return {
      summary: found.summary,
      input: found.input,
      notes,
      picked: o ? { date: o.draft.date, time: hhmm(trip!.start), endTime: hhmm(Math.min(trip!.end, 24 * 60 - 1)) } : null,
      day: o ? { view: o.dayView, people: found.people } : null,
      lastDay: to,
      ...timing,
    };
  } catch (err) {
    if (err instanceof FindTimeError || err instanceof GoogleAuthError || err instanceof GoogleApiError) {
      return { summary: `Couldn’t look for a free time: ${err.message}`, input: null, notes: [], day: null, picked: null, lastDay: to, ...timing };
    }
    throw err;
  }
}

/** Tasks fit any day, within reason. */
const TASK_HOURS = { start: '07:00', end: '21:00' };

/**
 * Free times for a reminder that was missed, for the person asking: as long as
 * its block was (half an hour if it had none), over the next couple of days.
 * Its travel was booked as part of the block, so none is added.
 */
export async function findTimeForReminder(
  note: { title: string; body: string | null; startsAt: Date | null; endsAt: Date | null },
  userName: string | null,
  today: string,
) {
  const household = await getHousehold();
  const me = personFor(household, userName);
  if (!me) throw new FindTimeError('Add yourself to the household in Settings so the app can find you a free time.');
  const length = note.startsAt && note.endsAt ? Math.round((note.endsAt.getTime() - note.startsAt.getTime()) / 60_000) : 30;
  return runFindTime({
    title: note.title,
    location: null,
    details: note.body,
    people: [me.id],
    from: today,
    to: addDays(today, 2),
    durationMinutes: Math.min(8 * 60, Math.max(5, length)),
    hoursStart: TASK_HOURS.start,
    hoursEnd: TASK_HOURS.end,
    days: [...WEEKDAYS],
    travelMinutes: 0,
  });
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** "Mon, Dec 7"; with the year when asked for, or when it isn't this year's. */
const dayName = (day: string, withYear = false) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(withYear || day.slice(0, 4) !== new Date().toISOString().slice(0, 4) ? { year: 'numeric' } : {}),
  });

/** Who's in the family and who's typing, for "me", "us" and names in the input. */
function familyContext(household: Household, userName: string | null) {
  if (!household.people.length) return '';
  const list = household.people.map((p) => `${p.name} (${p.adult ? 'adult' : 'child'}${p.aliases.length ? `, also ${p.aliases.join(', ')}` : ''})`);
  return `\nHousehold: ${list.join('; ')}.${userName ? ` The person typing is ${userName}.` : ''}`;
}

/** The AI's reading of "find a time for ...", checked, then run against the calendar. */
async function findTimeFrom(result: z.infer<typeof classification>, household: Household): Promise<FindTimeResult> {
  const f = result.schedule!;
  const idFor = (name: string) => {
    const n = name.trim().toLowerCase();
    return household.people.find((p) => p.name.toLowerCase() === n || p.aliases.some((a) => a.toLowerCase() === n))?.id;
  };
  const today = DATE.test(result.today) ? result.today : new Date().toISOString().slice(0, 10);
  const from = DATE.test(f.from) && f.from > today ? f.from : today;
  const to = DATE.test(f.to) && f.to >= from ? f.to : from;
  const time = (t: string | null) => (t && TIME.test(t) ? t : null);
  try {
    return await runFindTime({
      title: result.title.trim() || 'Appointment',
      location: result.location?.trim() || null,
      details: result.details?.trim() || null,
      people: [...new Set(f.people.flatMap((n) => idFor(n) ?? []))],
      from,
      to,
      durationMinutes: Math.min(12 * 60, Math.max(5, f.durationMinutes || 60)),
      hoursStart: time(f.earliest),
      hoursEnd: time(f.latest),
      days: f.days.length ? f.days : null,
      travelMinutes: f.travelMinutes < 0 ? null : Math.min(240, f.travelMinutes),
    });
  } catch (err) {
    if (err instanceof FindTimeError) throw new ImportError(err.message);
    throw err;
  }
}

type Repeat = NonNullable<z.infer<typeof classification>['repeat']>;

/** The AI's repeat fields as a rule. Monthly weekday positions come from the start date. */
function ruleFrom(repeat: Repeat, date: string): Rule {
  const freq = repeat.freq.toUpperCase() as Rule['freq'];
  const weekday = WEEKDAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7];
  const dom = Number(date.slice(8));
  let byDay: Rule['byDay'] = [];
  if (freq === 'WEEKLY') byDay = (repeat.weekdays.length ? repeat.weekdays : [weekday]).map((day) => ({ n: null, day }));
  if (freq === 'MONTHLY' && repeat.monthlyBy === 'weekday') byDay = [{ n: Math.min(4, Math.ceil(dom / 7)), day: weekday }];
  if (freq === 'MONTHLY' && repeat.monthlyBy === 'lastWeekday') byDay = [{ n: -1, day: weekday }];
  const until = repeat.until && DATE.test(repeat.until) && repeat.until >= date ? repeat.until : null;
  const count = !until && repeat.count && repeat.count > 0 ? Math.min(999, repeat.count) : null;
  return {
    freq,
    interval: Math.min(99, Math.max(1, repeat.interval || 1)),
    byDay: [...new Set(byDay.map((d) => JSON.stringify(d)))].map((d) => JSON.parse(d)),
    until,
    count,
  };
}

/** Hands a recipe to the regular import: the link if there is one, else the photos or text. */
async function recipeFrom(text: string, photos: Buffer[]): Promise<RecipeResult> {
  if (photos.length) return { ...(await extractFromPhotos(photos)), duplicateOf: null };
  const url = text.match(/https?:\/\/\S+/)?.[0];
  if (url) {
    try {
      const [result, duplicateOf] = await Promise.all([extractFromUrl(url), findExistingRecipe(url)]);
      return { ...result, duplicateOf };
    } catch (err) {
      // The page couldn't be read; fall back to whatever text came with the link.
      if (!(err instanceof ImportError || err instanceof FetchError)) throw err;
      if (text.replace(url, '').trim().length < 40) throw err;
    }
  }
  return { ...(await extractFromText(text, url ?? null)), duplicateOf: null };
}
