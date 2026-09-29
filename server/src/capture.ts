import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { env } from './env.js';
import { saveImage } from './images.js';
import type { RecipeDraft, ImportMethod } from './import/draft.js';
import { ImportError } from './import/errors.js';
import { extractFromPhotos, extractFromText, extractFromUrl, preparePhotos } from './import/extract.js';
import { FetchError } from './import/safeFetch.js';
import { findExistingRecipe } from './import/worker.js';
import { firstOccurrence, formatRule, nextOccurrence, WEEKDAYS, type Rule } from './recurrence.js';

/**
 * "Capture": something typed, dictated, pasted or photographed, sorted by Claude
 * into a note, reminder, appointment, recipe or grocery list. Nothing is saved
 * here; the app shows the result for a quick check first. Recipes and grocery
 * lists hand off to the existing recipe import and grocery list.
 */

const client = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const classification = z.object({
  today: z.string().describe("Today's date, YYYY-MM-DD, from the current date given"),
  kind: z.enum(['note', 'reminder', 'appointment', 'recipe', 'groceries']),
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
});

const SYSTEM = `You file things for a family's shared organizer app. The input was typed, dictated (so expect speech-to-text slips and filler words), pasted, or photographed (a flyer, a letter from school, an appointment card, a screenshot).

Decide what it is:
- appointment: something happening at a particular date, usually with a time or place: a doctor's visit, a school event, a party, a class, an event on a flyer.
- reminder: something someone needs to do, with or without a deadline: "remind me to call the plumber", "pay the water bill Friday", "return library books".
- note: information to keep, not an action or event: gift ideas, a wifi password, sizes, a phone number, a thought.
- recipe: ingredients or cooking steps for a dish, or a link to a recipe.
- groceries: a list of things to buy at the store.

Then fill in the fields:
- title: short and scannable, the way someone would write it in a calendar. For events, lead with what it is, and add who it's for when stated ("Dentist: Maya").
- details: keep anything useful that isn't in the other fields, such as what to bring, cost, phone numbers, links, or registration deadlines. Keep the person's own wording for dictated notes, minus filler words. Don't repeat the title, date, time or place.
- date and time: resolve relative dates ("next Tuesday", "the 14th", "tomorrow at 3") against the current date given below. When a flyer gives a month and day with no year, use the next time that date comes up. A reminder gets a date only when one is stated or clearly implied. If only a time is given for a reminder, use today, or tomorrow if that time has passed.
- repeat: only when it recurs ("every Tuesday", "the first Monday of each month", "every other week", "daily until Friday"). date is then the first occurrence on or after today.
- For a recipe or a grocery list, only kind and title matter (plus groceryItems for groceries).`;

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
  | { kind: 'note'; note: NoteDraft }
  | { kind: 'recipe'; recipe: RecipeResult }
  | { kind: 'groceries'; items: string[] };

export const captureEnabled = client !== null;

/** `now` is the phone's local date and time in words, e.g. "Monday, September 28, 2026 at 2:05 PM EDT". */
export async function capture(text: string, photos: Buffer[], now: string): Promise<CaptureResult> {
  if (!client) throw new ImportError("Sorting needs AI, which isn't set up on the server (ANTHROPIC_API_KEY).");
  text = text.trim().slice(0, 20_000);
  if (!text && photos.length === 0) throw new ImportError('Type something or add a photo first.');

  const prepared = await preparePhotos(photos);
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
          { type: 'text' as const, text: `It is now ${now}.${text ? `\n\n<input>\n${text}\n</input>` : ''}` },
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
  return {
    kind: 'note',
    note: {
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
    },
  };
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
