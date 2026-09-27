import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { prisma } from './db.js';
import { env } from './env.js';

/**
 * Sorts grocery lines into store sections and trims recipe prep notes
 * ("1 onion, diced" -> "1 onion"). Items are saved first with no aisle, then
 * sorted in the background so adding never waits on the AI. Items bought
 * before reuse the aisle they got last time and skip the AI entirely.
 * Without an API key (or when a call fails) items simply stay unsorted.
 */

export const AISLES = [
  'Produce',
  'Meat & Seafood',
  'Dairy & Eggs',
  'Bakery',
  'Pantry',
  'Spices & Baking',
  'Canned & Jarred',
  'Frozen',
  'Drinks',
  'Household',
  'Other',
] as const;

const client = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null;

const result = z.object({
  items: z.array(
    z.object({
      index: z.number().int(),
      aisle: z.enum(AISLES),
      item: z.string().describe('The line as a shopping list entry: keep quantity and ingredient, drop prep like "diced" or "at room temperature"'),
    }),
  ),
});

interface SortedItem {
  text: string;
  aisle: string | null;
}

async function sortGroceries(lines: string[]): Promise<SortedItem[]> {
  const fallback = lines.map((text) => ({ text, aisle: null }));
  if (!client || lines.length === 0) return fallback;

  try {
    const response = await client.messages.parse({
      model: env.groceryModel,
      max_tokens: 8000,
      // Haiku doesn't take an effort setting; bigger models get the cheapest one.
      output_config: {
        format: zodOutputFormat(result),
        ...(env.groceryModel.startsWith('claude-haiku') ? {} : { effort: 'low' as const }),
      },
      system:
        'You organize a household grocery list. For each numbered line, choose the store section and rewrite it as a short shopping entry. Keep quantities and the ingredient; drop preparation instructions. Never merge or drop lines.',
      messages: [{ role: 'user', content: lines.map((l, i) => `${i}. ${l}`).join('\n') }],
    });
    const parsed = response.parsed_output;
    console.info(
      JSON.stringify({
        msg: 'ai grocery sort',
        model: response.model,
        lines: lines.length,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }),
    );
    if (!parsed) return fallback;

    const byIndex = new Map(parsed.items.map((i) => [i.index, i]));
    return lines.map((text, i) => {
      const sorted = byIndex.get(i);
      return { text: sorted?.item.trim() || text, aisle: sorted?.aisle ?? null };
    });
  } catch (err) {
    console.warn('Grocery sorting failed:', (err as Error).message);
    return fallback;
  }
}

// ---------- Remembered aisles ----------

// Words stripped from the front of a line to get at the item itself.
const LEADING = new Set(
  (
    'a an some few of x tsp teaspoon tbsp tablespoon cup oz ounce lb lbs pound g gram kg ml l liter litre ' +
    'pint quart gallon can jar bag box bunch head clove package pkg pack bottle carton dozen stick ' +
    'large small medium big fresh'
  ).split(' '),
);

function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 4 && /(ch|sh|x|ss|o)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** "2 lb Lemons (organic)" -> "lemon". Empty when nothing item-like is left. */
export function itemKey(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && LEADING.has(singular(words[0]))) words.shift();
  if (words.length === 0) return '';
  words[words.length - 1] = singular(words[words.length - 1]);
  return words.join(' ');
}

/** Aisles for lines we've sorted before. Lines with prep notes (a comma) still go to the AI to be tidied. */
export async function rememberedAisles(lines: string[]): Promise<(string | null)[]> {
  const keys = lines.map((l) => (l.includes(',') ? '' : itemKey(l)));
  const wanted = [...new Set(keys.filter(Boolean))];
  if (wanted.length === 0) return lines.map(() => null);
  const rows = await prisma.groceryAisle.findMany({ where: { name: { in: wanted } } });
  const byName = new Map(rows.map((r) => [r.name, r.aisle]));
  return keys.map((k) => byName.get(k) ?? null);
}

// ---------- Background sorting ----------

const DEBOUNCE_MS = 1500;
const RETRY_MS = 60_000;
const MAX_RETRIES = 3;

let timer: NodeJS.Timeout | null = null;
let running = false;
let again = false;
let failures = 0;

/**
 * Sorts every unsorted item shortly after the last add, so a few quick adds
 * share one AI call. Safe to call often.
 */
export function scheduleSort(delay = DEBOUNCE_MS) {
  if (!client) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void sweep();
  }, delay);
}

async function sweep() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    const pending = await prisma.groceryItem.findMany({
      where: { aisle: null },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { id: true, text: true },
    });
    if (pending.length === 0) return;

    const sorted = await sortGroceries(pending.map((p) => p.text));
    const memo = new Map<string, string>();
    await prisma.$transaction(
      pending.flatMap((item, i) => {
        const { text, aisle } = sorted[i];
        if (!aisle) return [];
        const key = itemKey(text);
        if (key) memo.set(key, aisle);
        // Skip items edited or removed while the AI was working.
        return [prisma.groceryItem.updateMany({ where: { id: item.id, aisle: null, text: item.text }, data: { text, aisle } })];
      }),
    );
    await prisma.$transaction(
      [...memo].map(([name, aisle]) =>
        prisma.groceryAisle.upsert({ where: { name }, create: { name, aisle }, update: { aisle } }),
      ),
    );

    const missed = sorted.some((s) => !s.aisle);
    failures = missed ? failures + 1 : 0;
    if (missed && failures <= MAX_RETRIES) scheduleSort(RETRY_MS);
  } catch (err) {
    console.warn('Grocery sort sweep failed:', (err as Error).message);
  } finally {
    running = false;
    if (again) {
      again = false;
      scheduleSort(0);
    }
  }
}
