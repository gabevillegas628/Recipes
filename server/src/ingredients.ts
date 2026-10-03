import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { prisma } from './db.js';
import { env } from './env.js';
import { ITEM_NAME_RULES } from './groceries.js';

/**
 * Every recipe's ingredient lines read as name, amount and unit ("1/2 lb sweet
 * Italian sausage, casings removed" -> sweet italian sausage, 0.5, lb), so the
 * planner can find recipes that share ingredients and add up what they share.
 * Names follow the grocery list's rules, so both agree on what's the same item.
 * Read by the small grocery model in the background after recipes are saved,
 * and cached until a recipe's ingredients change.
 */

export const KINDS = ['staple', 'keeps', 'perishable', 'meat'] as const;

export interface IndexedItem {
  /** Position among the recipe's ingredient lines, across sections. */
  line: number;
  name: string;
  amount: number | null;
  unit: string | null;
  kind: (typeof KINDS)[number];
}

type Section = { title: string | null; items: string[] };

const client = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null;
const effortFor = (model: string) => (model.startsWith('claude-haiku') ? {} : { effort: 'low' as const });

/** Bump when the prompt changes, so every recipe is read again. */
const INDEX_VERSION = 5;
const RECIPES_PER_CALL = 8;
const PARALLEL_CALLS = 3;

const indexResult = z.object({
  recipes: z.array(
    z.object({
      recipe: z.number().int(),
      main: z.boolean().describe('True for a dish that is dinner by itself or its centerpiece'),
      items: z.array(
        z.object({
          line: z.number().int(),
          name: z.string(),
          amount: z.number().nullable().describe('As a decimal: "1/2" is 0.5, "1 1/2" is 1.5. For a range, the larger end. Null when there is none ("salt to taste")'),
          unit: z.string().nullable().describe('One of lb, oz, g, kg, cup, tbsp, tsp, ml, l, pint, quart, clove, can, jar, package, bunch, head, stick, slice; null for a plain count ("3 eggs")'),
          kind: z.enum(KINDS),
        }),
      ),
    }),
  ),
});

const SYSTEM = `You read recipe ingredient lists for a household meal planner, which looks for recipes that share ingredients so less food goes to waste. Each recipe is numbered, and so are its lines.

For each recipe, main: true for a dish that is dinner by itself or its centerpiece (a pasta, a soup, a roast, tacos, meatloaf); false for sides, sauces, dressings, desserts, breads, drinks and components (a spice rub, pie crust).

For every line:
- name: the plain name of the thing to buy. ${ITEM_NAME_RULES}
- amount and unit: how much the line calls for. Use the unit the line uses, written in its short form. "2 (15 oz) cans black beans" is 2 can. When a line gives no amount, amount is null.
- kind: "staple" for things a kitchen keeps on hand and nobody shops for a recipe: salt, pepper, water, cooking oil, flour, sugar, baking soda and powder, dried herbs and ground spices, vinegar, ice. "keeps" for things that last weeks once bought: onions, garlic, potatoes, rice, pasta, canned and dried goods, condiments, hard cheese like parmesan, butter. "meat" for raw meat, poultry, fish and seafood, and cured meats like bacon and sausage: they spoil first. "perishable" for everything else that goes bad within a week or so of buying or opening: fresh herbs, most produce, milk, cream, soft cheese, opened stock, tortillas, bread.
When a line offers a choice ("beef or chicken stock", "parsley or cilantro"), name the first: "beef stock".
When a name is already in the list of names in use, and it's the same thing, use that name exactly.
Give one entry per numbered line. Lines that aren't ingredients (a heading like "For the sauce:") get kind "staple".`;

export const hashOf = (sections: Section[]) =>
  createHash('sha256').update(JSON.stringify([INDEX_VERSION, sections])).digest('hex');

/** The lines of a recipe's ingredient sections, in order, as the index numbers them. */
export const ingredientLines = (sections: Section[]) => sections.flatMap((s) => s.items);

/** Reads a few recipes' ingredient lines in one call. Null when the AI isn't available or fails. */
export interface ReadRecipe {
  main: boolean;
  items: IndexedItem[];
}

export async function readIngredients(recipes: string[][], knownNames: string[] = []): Promise<ReadRecipe[] | null> {
  if (!client) return null;
  if (recipes.every((lines) => lines.length === 0)) return recipes.map(() => ({ main: false, items: [] }));
  const text = recipes
    .map((lines, r) => `Recipe ${r}\n${lines.map((l, i) => `${i}. ${l}`).join('\n')}`)
    .join('\n\n');
  try {
    const response = await client.messages.parse({
      model: env.groceryModel,
      max_tokens: 16000,
      output_config: { format: zodOutputFormat(indexResult), ...effortFor(env.groceryModel) },
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `${knownNames.length ? `Names in use: ${knownNames.join('; ')}\n\n` : ''}${text}`,
        },
      ],
    });
    console.info(
      JSON.stringify({
        msg: 'ai ingredient index',
        model: response.model,
        recipes: recipes.length,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }),
    );
    const parsed = response.parsed_output;
    if (!parsed) return null;
    const byRecipe = new Map(parsed.recipes.map((r) => [r.recipe, r]));
    return recipes.map((lines, r) => ({
      main: byRecipe.get(r)?.main ?? true,
      items: (byRecipe.get(r)?.items ?? [])
        .filter((i) => i.line >= 0 && i.line < lines.length && i.name.trim())
        .map((i) => ({
          line: i.line,
          name: i.name.trim().toLowerCase(),
          amount: i.amount != null && Number.isFinite(i.amount) && i.amount > 0 ? i.amount : null,
          unit: i.unit?.trim().toLowerCase() || null,
          kind: i.kind,
        })),
    }));
  } catch (err) {
    console.warn('Ingredient index failed:', (err as Error).message);
    return null;
  }
}

/**
 * Names already in the index, most used first, so new recipes reuse them. Leaves
 * out recipes still to be read again, whose names may be from an older prompt.
 */
export async function namesInUse(skip: string[] = []): Promise<string[]> {
  const rows = await prisma.recipeIngredients.findMany({ where: { recipeId: { notIn: skip } }, select: { items: true } });
  const counts = new Map<string, number>();
  for (const row of rows) for (const i of row.items as unknown as IndexedItem[]) if (i.kind !== 'staple') counts.set(i.name, (counts.get(i.name) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 400).map(([n]) => n);
}

/** Recipes with no index yet, or whose ingredients changed since. */
async function staleRecipes() {
  const recipes = await prisma.recipe.findMany({
    select: { id: true, ingredients: true, ingredientIndex: { select: { hash: true } } },
  });
  return recipes
    .map((r) => ({ id: r.id, sections: r.ingredients as Section[], hash: hashOf(r.ingredients as Section[]) }))
    .filter((r, i) => recipes[i].ingredientIndex?.hash !== r.hash);
}

async function indexBatch(batch: { id: string; sections: Section[]; hash: string }[], known: string[]) {
  const read = await readIngredients(batch.map((r) => ingredientLines(r.sections)), known);
  if (!read) return false;
  await prisma.$transaction(
    batch.map((r, i) =>
      prisma.recipeIngredients.upsert({
        where: { recipeId: r.id },
        create: { recipeId: r.id, hash: r.hash, main: read[i].main, items: read[i].items as unknown as object },
        update: { hash: r.hash, main: read[i].main, items: read[i].items as unknown as object },
      }),
    ),
  );
  return true;
}

let running: Promise<void> | null = null;
let again = false;

/** Indexes every recipe that needs it. Concurrent callers share one run. */
export function indexRecipes(): Promise<void> {
  if (!client) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        const stale = await staleRecipes();
        if (stale.length === 0) break;
        const batches: (typeof stale)[] = [];
        for (let i = 0; i < stale.length; i += RECIPES_PER_CALL) batches.push(stale.slice(i, i + RECIPES_PER_CALL));
        // The first batch alone, then a few at a time, each round reusing the names
        // the rounds before settled on so the same item doesn't get two names.
        const rounds = [batches.slice(0, 1)];
        for (let i = 1; i < batches.length; i += PARALLEL_CALLS) rounds.push(batches.slice(i, i + PARALLEL_CALLS));
        const pending = new Set(stale.map((r) => r.id));
        let failed = false;
        for (const round of rounds) {
          const known = await namesInUse([...pending]);
          const results = await Promise.all(round.map((b) => indexBatch(b, known)));
          for (const r of round.flat()) pending.delete(r.id);
          failed ||= results.includes(false);
        }
        // Don't loop on a failing AI; the next save or plan tries again.
        if (failed) break;
      } while (again);
    } catch (err) {
      console.warn('Ingredient indexing failed:', (err as Error).message);
    } finally {
      running = null;
    }
  })();
  return running;
}

let timer: NodeJS.Timeout | null = null;

/** Indexes new and changed recipes shortly after saves, so bulk imports share calls. */
export function scheduleIndex(delay = 5000) {
  if (!client) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void indexRecipes();
  }, delay);
}
