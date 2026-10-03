import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { prisma } from './db.js';
import { env } from './env.js';
import { hashOf, ingredientLines, indexRecipes, KINDS, namesInUse, readIngredients, type IndexedItem } from './ingredients.js';
import { addToPlan } from './plan.js';
import { createRecipe } from './recipes.js';
import { recipeInput } from './recipeInput.js';

/**
 * Plans several recipes at once that share ingredients, so what's bought for
 * one gets used up by another (half a pound of sausage here, the other half
 * there). Starts from one recipe, picked or random, and adds the recipe that
 * shares the most with what's chosen so far while bringing the least that's
 * new. Meat counts most, then other perishables; pantry staples not at all. Only main dishes are
 * suggested, and ones nearly the same as one already chosen are skipped. Or Claude writes new
 * recipes around the first one's ingredients ("adventurous").
 */

const client = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null;

export const MIN_RECIPES = 2;
export const MAX_RECIPES = 7;

/**
 * How much sharing an ingredient is worth: what spoils matters, the salt doesn't.
 * Meat spoils first and comes in the biggest packages, so it counts most, and a
 * recipe bringing in a new meat costs the most too.
 */
const WEIGHT: Record<IndexedItem['kind'], number> = { meat: 2.5, perishable: 1, keeps: 0.35, staple: 0 };
/** How much each new thing to buy counts against a recipe. */
const NEW_PENALTY = 0.4;
/** Share of a recipe's ingredients that, shared with one already chosen, makes it "the same recipe". */
const TOO_SIMILAR = 0.7;
/** Picks are drawn from the best few, so planning again gives something different. */
const SHORTLIST = 5;

export class PlannerError extends Error {}

// ---------- Recipes as the planner sees them ----------

/** A recipe Claude wrote, not saved until the plan is accepted. */
export const draftSchema = z.object({
  key: z.string().max(60),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(1000),
  servings: z.string().max(60),
  prepMinutes: z.number().int().min(0).max(1440),
  cookMinutes: z.number().int().min(0).max(1440),
  ingredients: z.array(z.string().max(300)).max(60),
  steps: z.array(z.string().max(2000)).max(40),
  items: z
    .array(
      z.object({
        line: z.number().int(),
        name: z.string().max(200),
        amount: z.number().nullable(),
        unit: z.string().max(40).nullable(),
        kind: z.enum(KINDS),
      }),
    )
    .max(60),
});

export type Draft = z.infer<typeof draftSchema>;

interface Entry {
  /** Recipe id, or the draft's key. */
  key: string;
  id: string | null;
  title: string;
  image: string | null;
  totalMinutes: number | null;
  items: IndexedItem[];
  /** Ingredient line text, by line number, for showing amounts. */
  lines: string[];
  /** Each ingredient worth sharing, with how much it counts. */
  weights: Map<string, number>;
  /** Dinner by itself, not a side or a sauce. Only these are suggested. */
  main: boolean;
  draft?: Draft;
}

function weigh(items: IndexedItem[]): Map<string, number> {
  const weights = new Map<string, number>();
  for (const i of items) {
    const w = WEIGHT[i.kind];
    if (w > 0) weights.set(i.name, Math.max(weights.get(i.name) ?? 0, w));
  }
  return weights;
}

const total = (weights: Map<string, number>) => [...weights.values()].reduce((a, b) => a + b, 0);

async function loadLibrary(): Promise<Entry[]> {
  const recipes = await prisma.recipe.findMany({
    select: {
      id: true,
      title: true,
      image: true,
      totalMinutes: true,
      prepMinutes: true,
      cookMinutes: true,
      ingredients: true,
      ingredientIndex: { select: { items: true, main: true } },
    },
  });
  return recipes.flatMap((r) => {
    if (!r.ingredientIndex) return [];
    const items = r.ingredientIndex.items as unknown as IndexedItem[];
    return [
      {
        key: r.id,
        id: r.id,
        title: r.title,
        image: r.image,
        totalMinutes: r.totalMinutes ?? (r.prepMinutes || r.cookMinutes ? (r.prepMinutes ?? 0) + (r.cookMinutes ?? 0) : null),
        items,
        lines: ingredientLines(r.ingredients as { title: string | null; items: string[] }[]),
        weights: weigh(items),
        main: r.ingredientIndex.main,
      },
    ];
  });
}

function draftEntry(d: Draft): Entry {
  return {
    key: d.key,
    id: null,
    title: d.title,
    image: null,
    totalMinutes: d.prepMinutes + d.cookMinutes || null,
    items: d.items,
    lines: d.ingredients,
    weights: weigh(d.items),
    main: true,
    draft: d,
  };
}

// ---------- Choosing ----------

const TITLE_FILLER = new Set('the a an and with of in on best easy classic homemade my our simple quick perfect ultimate recipe style'.split(' '));

/** The words that say what a dish is: "Garlic Yukon Gold Mashed Potatoes" -> garlic, yukon, gold, mashed, potato. */
function titleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .split(/[^a-z]+/)
      .filter((w) => w.length > 2 && !TITLE_FILLER.has(w))
      .map((w) => (w.length > 4 && w.endsWith('es') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)),
  );
}

/** The same dish by name: identical, or two words in common ("Russet Mashed Potatoes", "Garlic Mashed Potatoes"). */
function sameDish(a: string, b: string): boolean {
  const wa = titleWords(a);
  const common = [...titleWords(b)].filter((w) => wa.has(w)).length;
  return a.trim().toLowerCase() === b.trim().toLowerCase() || common >= 2;
}

function shared(a: Map<string, number>, b: Map<string, number>): number {
  let sum = 0;
  for (const [name, w] of a) if (b.has(name)) sum += Math.min(w, b.get(name)!);
  return sum;
}

function tooSimilar(a: Entry, b: Entry): boolean {
  if (sameDish(a.title, b.title)) return true;
  const smaller = Math.min(total(a.weights), total(b.weights));
  return smaller >= 1.5 && shared(a.weights, b.weights) / smaller >= TOO_SIMILAR;
}

function score(candidate: Entry, pool: Map<string, number>): number {
  let s = 0;
  for (const [name, w] of candidate.weights) s += pool.has(name) ? w : -NEW_PENALTY * w;
  return s;
}

/** One of the best few, the best most likely. */
function drawFromBest<T>(ranked: { item: T; score: number }[]): T | null {
  if (ranked.length === 0) return null;
  const best = ranked[0].score;
  const shortlist = ranked.slice(0, SHORTLIST).filter((r) => best <= 0 || r.score >= best * 0.6);
  const tickets = shortlist.flatMap((r, i) => Array<T>(shortlist.length - i).fill(r.item));
  return tickets[Math.floor(Math.random() * tickets.length)];
}

function choose(chosen: Entry[], library: Entry[], count: number, skip: Set<string>): Entry[] {
  const picked = [...chosen];
  while (picked.length < count) {
    const pool = new Map<string, number>();
    for (const e of picked) for (const [n, w] of e.weights) pool.set(n, Math.max(pool.get(n) ?? 0, w));
    const ranked = library
      .filter((e) => e.main && !skip.has(e.key) && !picked.some((p) => p.key === e.key || tooSimilar(p, e)) && e.weights.size > 0)
      .map((e) => ({ item: e, score: score(e, pool) }))
      .sort((a, b) => b.score - a.score);
    const next = drawFromBest(ranked);
    if (!next) break;
    picked.push(next);
  }
  return picked;
}

/** Recipes already on this week, which the planner doesn't suggest again. */
async function plannedIds(): Promise<Set<string>> {
  const items = await prisma.planItem.findMany({ where: { archivedAt: null }, select: { recipeId: true } });
  return new Set(items.map((i) => i.recipeId));
}

function randomAnchor(library: Entry[], skip: Set<string>): Entry {
  // Something with a few real ingredients to build around.
  const worth = library.filter((e) => e.main && !skip.has(e.key) && total(e.weights) >= 2);
  const from = worth.length ? worth : library.filter((e) => e.main && e.weights.size > 0);
  if (from.length === 0) throw new PlannerError('No recipes with ingredients to plan from yet.');
  return from[Math.floor(Math.random() * from.length)];
}

async function ready(): Promise<Entry[]> {
  if (!client) throw new PlannerError('Planning needs AI, which isn’t set up (no ANTHROPIC_API_KEY).');
  // Reads any recipe not indexed yet; quick unless many were just added.
  await indexRecipes();
  return loadLibrary();
}

function anchorOf(library: Entry[], anchorId: string | undefined, skip: Set<string>): Entry {
  if (!anchorId) return randomAnchor(library, skip);
  const anchor = library.find((e) => e.id === anchorId);
  if (!anchor) throw new PlannerError('Couldn’t read that recipe’s ingredients. Try again in a minute.');
  return anchor;
}

export const suggestInput = z.object({
  count: z.number().int().min(MIN_RECIPES).max(MAX_RECIPES),
  /** The recipe to build around; random when left out. */
  anchorId: z.string().optional(),
  /** Recipes to keep, in order, when swapping one out. The first is the anchor. */
  keep: z.array(z.string()).max(MAX_RECIPES).default([]),
  /** Recipes not to suggest (ones swapped out). */
  exclude: z.array(z.string()).max(200).default([]),
});

/** Recipes from the collection that share ingredients. */
export async function suggestPlan(input: z.infer<typeof suggestInput>) {
  const library = await ready();
  const planned = await plannedIds();
  const skip = new Set([...input.exclude, ...planned]);
  const byId = new Map(library.map((e) => [e.key, e]));
  const kept = input.keep.flatMap((id) => byId.get(id) ?? []);
  const start = kept.length ? kept : [anchorOf(library, input.anchorId, skip)];
  return describe(choose(start, library, input.count, skip));
}

// ---------- Adventurous: Claude writes the rest ----------

const invented = z.object({
  recipes: z.array(
    z.object({
      title: z.string(),
      description: z.string().describe('One or two sentences on what it is'),
      servings: z.string().describe('e.g. "4"'),
      prepMinutes: z.number().int(),
      cookMinutes: z.number().int(),
      ingredients: z.array(z.string()).describe('One line each, amount first, US units, e.g. "1/2 lb sweet Italian sausage, casings removed"'),
      steps: z.array(z.string()),
    }),
  ),
});

const INVENT_SYSTEM = `You write home-cooking recipes for a family's weekly meal plan. The point is to waste less: they'll shop once for the whole week, so your recipes should use up what the given recipe leaves over.

Look at what the given recipe buys that comes in bigger amounts than it uses, or spoils fast once opened: the rest of a pound of sausage, the other half of a bunch of cilantro, a carton of cream with most still in it, the remaining tortillas. Build each new recipe around several of those, in amounts that use them up, while bringing in as few new perishable ingredients as you can. Pantry staples are free to use.

Each recipe must be a clearly different dish from the given one and from each other: a different cuisine, cooking method or format (a soup, a pasta, a sheet-pan dinner, tacos), not a variation. Weeknight-friendly: about an hour or less, ordinary grocery-store ingredients, clear steps. Write ingredient lines amount first in US units, with prep notes after a comma.`;

export const inventInput = z.object({
  count: z.number().int().min(MIN_RECIPES).max(MAX_RECIPES),
  anchorId: z.string().optional(),
  /** Claude's recipes to keep when swapping one out. */
  keep: z.array(draftSchema).max(MAX_RECIPES).default([]),
  /** Titles not to write again (ones swapped out). */
  avoid: z.array(z.string().max(200)).max(50).default([]),
});

/** The anchor from the collection, plus new recipes Claude writes to share its ingredients. */
export async function inventPlan(input: z.infer<typeof inventInput>) {
  const library = await ready();
  const anchor = anchorOf(library, input.anchorId, await plannedIds());
  const kept = input.keep.map(draftEntry);
  const wanted = input.count - 1 - kept.length;
  if (wanted <= 0) return describe([anchor, ...kept]);

  const others = [...kept.map((k) => k.title), ...input.avoid];
  const response = await client!.beta.messages.parse({
    model: env.anthropicModel,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: zodOutputFormat(invented) },
    system: INVENT_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          `Write ${wanted} new recipe${wanted === 1 ? '' : 's'} to cook the same week as this one.`,
          `\n${anchor.title}\n${anchor.lines.map((l) => `- ${l}`).join('\n')}`,
          others.length ? `\nAlso planned or already turned down, so don't repeat them: ${others.join('; ')}.` : '',
          kept.length
            ? `\nThe other recipes planned use:\n${kept.map((k) => `${k.title}: ${k.lines.join('; ')}`).join('\n')}`
            : '',
        ].join('\n'),
      },
    ],
  });
  console.info(
    JSON.stringify({
      msg: 'ai invent recipes',
      model: response.model,
      stopReason: response.stop_reason,
      wanted,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }),
  );
  if (response.stop_reason === 'refusal') throw new PlannerError('Claude declined to write these recipes.');
  const written = response.parsed_output?.recipes.slice(0, wanted);
  if (!written?.length) throw new PlannerError('Claude couldn’t come up with recipes this time. Try again.');

  // Named like the collection's ingredients, so what they share shows.
  const read = await readIngredients(written.map((r) => r.ingredients), await namesInUse());
  if (!read) throw new PlannerError('Couldn’t read the new recipes’ ingredients. Try again.');
  const drafts = written.map((r, i): Draft => ({
    key: `draft-${randomUUID()}`,
    title: r.title.trim(),
    description: r.description.trim(),
    servings: r.servings.trim(),
    prepMinutes: Math.max(0, r.prepMinutes),
    cookMinutes: Math.max(0, r.cookMinutes),
    ingredients: r.ingredients.map((l) => l.trim()).filter(Boolean),
    steps: r.steps.map((l) => l.trim()).filter(Boolean),
    items: read[i].items,
  }));
  return describe([anchor, ...kept, ...drafts.map(draftEntry)]);
}

// ---------- What's shared, and how much ----------

/** Units that add up: each as a multiple of the dimension's base (oz, tsp). */
const MEASURES: Record<string, { dim: 'mass' | 'volume'; base: number }> = {
  oz: { dim: 'mass', base: 1 },
  ounce: { dim: 'mass', base: 1 },
  lb: { dim: 'mass', base: 16 },
  pound: { dim: 'mass', base: 16 },
  g: { dim: 'mass', base: 0.035274 },
  gram: { dim: 'mass', base: 0.035274 },
  kg: { dim: 'mass', base: 35.274 },
  tsp: { dim: 'volume', base: 1 },
  teaspoon: { dim: 'volume', base: 1 },
  tbsp: { dim: 'volume', base: 3 },
  tablespoon: { dim: 'volume', base: 3 },
  cup: { dim: 'volume', base: 48 },
  ml: { dim: 'volume', base: 0.202884 },
  l: { dim: 'volume', base: 202.884 },
  pint: { dim: 'volume', base: 96 },
  quart: { dim: 'volume', base: 192 },
};

/** "lbs" -> "lb", "Cups" -> "cup". */
function unitKey(unit: string | null): string {
  if (!unit) return '';
  const u = unit.toLowerCase().replace(/\.$/, '');
  if (MEASURES[u]) return u;
  if (/(ch|sh|x)es$/.test(u)) return u.slice(0, -2);
  return u.endsWith('s') && !u.endsWith('ss') ? u.slice(0, -1) : u;
}

const FRACTIONS: [number, string][] = [
  [0, ''],
  [0.25, '¼'],
  [1 / 3, '⅓'],
  [0.5, '½'],
  [2 / 3, '⅔'],
  [0.75, '¾'],
  [1, ''],
];

/** 1.5 -> "1½", 0.333 -> "⅓", 2.1 -> "2". */
export function formatNumber(n: number): string {
  if (n >= 10) return String(Math.round(n));
  let whole = Math.floor(n);
  const rest = n - whole;
  const [value, glyph] = FRACTIONS.reduce((best, f) => (Math.abs(f[0] - rest) < Math.abs(best[0] - rest) ? f : best));
  if (value === 1) whole += 1;
  // Too little to round to a quarter: say it as it is.
  if (whole === 0 && !glyph) return String(Number(n.toFixed(2)));
  return `${whole || ''}${glyph}`;
}

function formatAmount(amount: number, unit: string): string {
  const n = formatNumber(amount);
  if (!unit) return n;
  return `${n} ${amount > 1 && !MEASURES[unit] && !unit.endsWith('s') ? `${unit}s` : unit}`;
}

/** Mass in oz, volume in tsp, written in the unit a cook would use. */
function formatMeasure(dim: 'mass' | 'volume', base: number): string {
  if (dim === 'mass') return base >= 8 ? formatAmount(base / 16, 'lb') : formatAmount(base, 'oz');
  if (base >= 12) return formatAmount(base / 48, 'cup');
  if (base >= 3) return formatAmount(base / 3, 'tbsp');
  return formatAmount(base, 'tsp');
}

/** What the lines add up to, e.g. "1 lb", or "1 cup + 2 cans" when the units don't mix. Null if any line has no amount. */
export function addUp(uses: { amount: number | null; unit: string | null }[]): string | null {
  if (uses.some((u) => u.amount == null)) return null;
  const sums = new Map<string, { dim?: 'mass' | 'volume'; sum: number }>();
  for (const u of uses) {
    const key = unitKey(u.unit);
    const measure = MEASURES[key];
    const group = measure ? measure.dim : `unit:${key}`;
    const entry = sums.get(group) ?? { dim: measure?.dim, sum: 0 };
    entry.sum += u.amount! * (measure?.base ?? 1);
    sums.set(group, entry);
  }
  return [...sums]
    .map(([group, { dim, sum }]) => (dim ? formatMeasure(dim, sum) : formatAmount(sum, group.slice(5))))
    .join(' + ');
}

export interface SharedItem {
  name: string;
  kind: IndexedItem['kind'];
  uses: { key: string; title: string; line: string }[];
  /** All of it together, when the amounts add up. */
  total: string | null;
}

function describe(entries: Entry[]) {
  const byName = new Map<string, { kind: IndexedItem['kind']; uses: (SharedItem['uses'][number] & { amount: number | null; unit: string | null })[] }>();
  for (const e of entries) {
    for (const item of e.items) {
      if (item.kind === 'staple') continue;
      const entry = byName.get(item.name) ?? { kind: item.kind, uses: [] };
      entry.uses.push({ key: e.key, title: e.title, line: e.lines[item.line] ?? item.name, amount: item.amount, unit: item.unit });
      byName.set(item.name, entry);
    }
  }
  const sharedItems: SharedItem[] = [...byName]
    .filter(([, v]) => new Set(v.uses.map((u) => u.key)).size > 1)
    .map(([name, v]) => ({
      name,
      kind: v.kind,
      uses: v.uses.map(({ key, title, line }) => ({ key, title, line })),
      total: addUp(v.uses),
    }))
    // Meat first, then other perishables: they're what would go to waste.
    .sort((a, b) => WEIGHT[b.kind] - WEIGHT[a.kind] || b.uses.length - a.uses.length || a.name.localeCompare(b.name));
  const sharedNames = new Set(sharedItems.map((s) => s.name));

  return {
    recipes: entries.map((e) => ({
      key: e.key,
      id: e.id,
      title: e.title,
      image: e.image,
      totalMinutes: e.totalMinutes,
      shares: [...e.weights.keys()].filter((n) => sharedNames.has(n)),
      draft: e.draft ?? null,
    })),
    shared: sharedItems,
    /** Different things to buy, staples aside. */
    toBuy: byName.size,
  };
}

export type PlanSuggestion = ReturnType<typeof describe>;

// ---------- Accepting ----------

export const acceptInput = z.object({
  recipeIds: z.array(z.string()).max(MAX_RECIPES),
  drafts: z.array(draftSchema).max(MAX_RECIPES),
});

/** Saves Claude's recipes to the collection and puts everything on this week. */
export async function acceptPlan(input: z.infer<typeof acceptInput>, userId: string | null) {
  const ids = [...input.recipeIds];
  for (const d of input.drafts) {
    const recipe = await createRecipe(
      recipeInput.parse({
        title: d.title,
        description: d.description || null,
        source: 'CLAUDE',
        servings: d.servings || null,
        prepMinutes: d.prepMinutes || null,
        cookMinutes: d.cookMinutes || null,
        totalMinutes: d.prepMinutes + d.cookMinutes || null,
        ingredients: [{ title: null, items: d.ingredients }],
        instructions: [{ title: null, items: d.steps }],
      }),
      { userId },
    );
    // Already read when Claude wrote it.
    const sections = [{ title: null, items: d.ingredients }];
    const index = { hash: hashOf(sections), items: d.items };
    await prisma.recipeIngredients.upsert({ where: { recipeId: recipe.id }, create: { recipeId: recipe.id, ...index }, update: index });
    ids.push(recipe.id);
  }
  for (const id of ids) await addToPlan(id, 1, userId);
  return { added: ids.length, recipeIds: ids };
}
