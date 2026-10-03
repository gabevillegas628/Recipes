import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { prisma } from './db.js';
import { env } from './env.js';

/**
 * Sorts grocery lines into store sections, trims recipe prep notes
 * ("1 onion, diced" -> "1 onion") and gives each a plain item name so lines
 * for the same thing ("2 lb carrots", "3 carrots") show as one row. Items are
 * saved first and sorted in the background so adding never waits on the AI.
 * Items bought before reuse what they got last time and skip the AI entirely.
 * When a row combines lines in different units, the AI also estimates one
 * amount to buy. Without an API key (or when a call fails) items simply stay
 * unsorted and uncombined.
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

// Haiku doesn't take an effort setting; bigger models get the cheapest one.
const effortFor = (model: string) => (model.startsWith('claude-haiku') ? {} : { effort: 'low' as const });

function logUsage(msg: string, response: Anthropic.Message, extra: Record<string, unknown>) {
  console.info(
    JSON.stringify({
      msg,
      model: response.model,
      ...extra,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }),
  );
}

// ---------- Sorting ----------

const sortResult = z.object({
  items: z.array(
    z.object({
      index: z.number().int(),
      aisle: z.enum(AISLES),
      item: z.string().describe('The line as a shopping list entry: keep quantity and ingredient, drop prep like "diced" or "at room temperature"'),
      name: z.string().describe('The plain item name, lowercase, no amount or size, e.g. "carrots", "garlic", "unsalted butter"'),
    }),
  ),
});

/**
 * How an ingredient's plain name is written, so lines for the same thing match.
 * Shared with the recipe ingredient index (ingredients.ts) so the planner and
 * the grocery list agree on what's the same item.
 */
export const ITEM_NAME_RULES = `Lowercase, no amounts, sizes or prep: "2 large carrots, peeled" and "1 lb carrots" are both "carrots"; "4 cloves garlic" and "2 garlic cloves" are both "garlic"; "sweet Italian sausage, casings removed" is "sweet italian sausage". Keep differences that matter when shopping: "baby carrots" is not "carrots", "unsalted butter" is not "salted butter", "chicken thighs" is not "chicken breasts", "hot italian sausage" is not "sweet italian sausage". Things a shopper would buy either of get one name: "heavy whipping cream" is "heavy cream", "chicken stock" is "chicken broth", "fresh parsley" is "fresh flat-leaf parsley". Use the plural where it's natural ("lemons", "eggs") and the mass noun otherwise ("flour", "celery").`;

const SORT_SYSTEM = `You organize a household grocery list. For each numbered line:
- aisle: the store section. Butter, milk, cream, cheese and eggs are Dairy & Eggs.
- item: the line rewritten as a short shopping entry. Keep quantities and the ingredient; drop preparation instructions.
- name: the plain name of the thing to buy, used to combine lines for the same item. ${ITEM_NAME_RULES}
Never merge or drop lines.`;

interface SortedItem {
  text: string;
  aisle: string | null;
  name: string | null;
}

async function sortGroceries(lines: string[]): Promise<SortedItem[]> {
  const fallback = lines.map((text) => ({ text, aisle: null, name: null }));
  if (!client || lines.length === 0) return fallback;

  try {
    const response = await client.messages.parse({
      model: env.groceryModel,
      max_tokens: 8000,
      output_config: { format: zodOutputFormat(sortResult), ...effortFor(env.groceryModel) },
      system: SORT_SYSTEM,
      messages: [{ role: 'user', content: lines.map((l, i) => `${i}. ${l}`).join('\n') }],
    });
    logUsage('ai grocery sort', response, { lines: lines.length });
    const parsed = response.parsed_output;
    if (!parsed) return fallback;

    const byIndex = new Map(parsed.items.map((i) => [i.index, i]));
    return lines.map((text, i) => {
      const sorted = byIndex.get(i);
      const name = sorted?.name.trim().toLowerCase();
      return { text: sorted?.item.trim() || text, aisle: sorted?.aisle ?? null, name: sorted && name ? name : null };
    });
  } catch (err) {
    console.warn('Grocery sorting failed:', (err as Error).message);
    return fallback;
  }
}

// ---------- Combined amounts ----------

const totalsResult = z.object({
  totals: z.array(
    z.object({
      index: z.number().int(),
      working: z
        .string()
        .describe('Convert each line to one unit and add them up, e.g. "2 lb + 5 medium carrots (about 1.25 lb) = 3.25 lb"'),
      buy: z.string().describe('Just the amount to buy, no item name, e.g. "about 3 lb", "1 bunch", "2"'),
    }),
  ),
});

const TOTALS_SYSTEM = `You help shop from a household grocery list. Each numbered item below was needed by several recipes, in different amounts and units. For each, give one amount to buy, in the units a US grocery store sells it: a count for onions or lemons, a bunch for celery or herbs, pounds for carrots or meat, a stick or pound for butter, a can, jar, bag or carton for packaged goods. Work it out first: convert every line to one unit using typical sizes (a medium carrot is about 1/4 lb, a stick of butter is 1/2 cup or 8 tbsp) and add them all up. The amount must cover every line. Then round up to something you can actually buy (half an onion means buying 1; 3/4 cup butter means 2 sticks). When the conversion is rough, say "about". Reply with only the amount; the item name is shown separately.`;

async function estimateTotals(groups: { name: string; lines: string[] }[]): Promise<(string | null)[]> {
  const fallback = groups.map(() => null);
  if (!client || groups.length === 0) return fallback;

  try {
    const response = await client.messages.parse({
      model: env.groceryTotalsModel,
      max_tokens: 8000,
      output_config: { format: zodOutputFormat(totalsResult), ...effortFor(env.groceryTotalsModel) },
      system: TOTALS_SYSTEM,
      messages: [
        {
          role: 'user',
          content: groups.map((g, i) => `${i}. ${g.name}\n${g.lines.map((l) => `   - ${l}`).join('\n')}`).join('\n'),
        },
      ],
    });
    logUsage('ai grocery totals', response, { groups: groups.length });
    const parsed = response.parsed_output;
    if (!parsed) return fallback;
    const byIndex = new Map(parsed.totals.map((t) => [t.index, t.buy.trim()]));
    return groups.map((_, i) => byIndex.get(i) || null);
  } catch (err) {
    console.warn('Grocery totals failed:', (err as Error).message);
    return fallback;
  }
}

/** Identifies which lines a stored total was estimated from. */
export function totalSources(lines: string[]): string {
  return [...lines].sort().join('\n');
}

// ---------- Remembered items ----------

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

/**
 * Aisle and item name for lines we've sorted before. Lines with prep notes
 * (a comma) still go to the AI to be tidied.
 */
export async function rememberedItems(lines: string[]): Promise<({ aisle: string; name: string } | null)[]> {
  const keys = lines.map((l) => (l.includes(',') ? '' : itemKey(l)));
  const wanted = [...new Set(keys.filter(Boolean))];
  if (wanted.length === 0) return lines.map(() => null);
  const rows = await prisma.groceryAisle.findMany({ where: { name: { in: wanted }, item: { not: null } } });
  const byKey = new Map(rows.map((r) => [r.name, { aisle: r.aisle, name: r.item! }]));
  return keys.map((k) => byKey.get(k) ?? null);
}

// ---------- Background work ----------

const DEBOUNCE_MS = 1500;
const RETRY_MS = 60_000;
const MAX_RETRIES = 3;

let timer: NodeJS.Timeout | null = null;
let running = false;
let again = false;
let failures = 0;

/**
 * Sorts every unsorted item and refreshes combined amounts shortly after the
 * last add, so a few quick adds share one AI call. Safe to call often.
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
    const missed = await sortPending();
    await refreshTotals();
    failures = missed ? failures + 1 : 0;
    if (missed && failures <= MAX_RETRIES) scheduleSort(RETRY_MS);
  } catch (err) {
    console.warn('Grocery sweep failed:', (err as Error).message);
  } finally {
    running = false;
    if (again) {
      again = false;
      scheduleSort(0);
    }
  }
}

/** Returns true when some items couldn't be sorted. */
async function sortPending(): Promise<boolean> {
  const pending = await prisma.groceryItem.findMany({
    where: { OR: [{ aisle: null }, { name: null }] },
    orderBy: { createdAt: 'asc' },
    take: 200,
    select: { id: true, text: true },
  });
  if (pending.length === 0) return false;

  const sorted = await sortGroceries(pending.map((p) => p.text));
  const memo = new Map<string, { aisle: string; item: string }>();
  await prisma.$transaction(
    pending.flatMap((row, i) => {
      const { text, aisle, name } = sorted[i];
      if (!aisle || !name) return [];
      const key = itemKey(text);
      if (key) memo.set(key, { aisle, item: name });
      // Skip items edited or removed while the AI was working.
      return [prisma.groceryItem.updateMany({ where: { id: row.id, text: row.text }, data: { text, aisle, name } })];
    }),
  );
  await prisma.$transaction(
    [...memo].map(([name, data]) =>
      prisma.groceryAisle.upsert({ where: { name }, create: { name, ...data }, update: data }),
    ),
  );
  return sorted.some((s) => !s.aisle || !s.name);
}

/** Estimates one amount to buy for each row that combines several lines, when its lines have changed. */
async function refreshTotals() {
  const open = await prisma.groceryItem.findMany({
    where: { checked: false, name: { not: null } },
    select: { name: true, text: true },
  });
  const byName = new Map<string, string[]>();
  for (const row of open) byName.set(row.name!, [...(byName.get(row.name!) ?? []), row.text]);
  const combined = [...byName].filter(([, lines]) => lines.length > 1);
  if (combined.length === 0) return;

  const stored = await prisma.groceryTotal.findMany({ where: { name: { in: combined.map(([n]) => n) } } });
  const current = new Map(stored.map((t) => [t.name, t.sources]));
  const stale = combined
    .map(([name, lines]) => ({ name, lines, sources: totalSources(lines) }))
    .filter((g) => current.get(g.name) !== g.sources)
    .slice(0, 60);
  if (stale.length === 0) return;

  const buys = await estimateTotals(stale);
  await prisma.$transaction(
    stale.flatMap((g, i) => {
      const buy = buys[i];
      if (!buy) return [];
      return [
        prisma.groceryTotal.upsert({
          where: { name: g.name },
          create: { name: g.name, sources: g.sources, buy },
          update: { sources: g.sources, buy },
        }),
      ];
    }),
  );
}
