import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { ALL_CATEGORIES, CATEGORY_GROUPS, normalizeCategories } from './categoryList.js';
import { prisma } from './db.js';
import { env } from './env.js';
import type { Section } from './recipeInput.js';

/**
 * Sorts recipes into the categories (categoryList.ts) in the background: any
 * recipe with none, shortly after saves and on startup. One prompt for every
 * way a recipe arrives (an import, one Claude wrote, one typed in, the Claude
 * connector), so they're sorted alike. Clearing a recipe's categories has it sorted again.
 */

const client = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null;

const RECIPES_PER_CALL = 16;
const PARALLEL_CALLS = 3;

const [type, ingredient, cuisine, goodFor] = CATEGORY_GROUPS.map((g) => z.array(z.enum(g.values)));

const sorted = z.object({
  recipes: z.array(z.object({ recipe: z.number().int(), type, ingredient, cuisine, goodFor })),
});

const SYSTEM = `You sort a family's recipes into categories, so they can browse their recipe box by them. For each recipe, pick from each list every category that fits, and only those: browsing "Chicken" should turn up every chicken dish and nothing else.

- type: what the dish is, usually one.
  - Main: a main dish, other than a soup or a salad. A main-dish salad is Salad; a hearty soup or chili is Soup & stew.
  - Sauces & basics: stocks, sauces, dressings, gravies and other building blocks.
  - Snack: snacks and appetizers.
- ingredient: what the dish is built around, usually one or two: its meat or fish (not a little bacon for flavor), and Pasta when pasta, noodles, gnocchi or tortellini are central. Vegetarian for anything with no meat, poultry or fish, sides included; a chicken-stock soup isn't vegetarian. A stock or gravy gets the meat it's made from.
- cuisine: only when the dish clearly belongs to one; leave it empty for everyday dishes without a clear origin. American for classic American dishes (meatloaf, chili, mac and cheese), not as a default. Asian covers Chinese, Japanese, Thai, Korean, Vietnamese, Filipino and so on; Eastern European covers Hungarian, Russian, Polish and so on; Mediterranean covers Spanish, Greek and Middle Eastern.
- goodFor, only when clearly true:
  - Quick: on the table in about 30 minutes or less.
  - One-pot: a whole meal from one pot, pan or sheet, its pasta, rice, potatoes or vegetables cooked in with it (one-pot sausage pasta, a sheet-pan dinner). Not soups, stews and sides, which are one pot anyway, and not a main that just cooks in one skillet and needs sides made separately.
  - Make-ahead: made largely ahead, or freezes well, by design.
  - Slow cooker, Pressure cooker, Air fryer: the recipe uses one (or offers it as the main method).
  - Kid-friendly: mild, familiar food most kids eat happily.
  - Holiday: a Thanksgiving, Christmas or Easter dish.`;

type Recipe = {
  id: string;
  title: string;
  description: string | null;
  totalMinutes: number | null;
  ingredients: unknown;
  instructions: unknown;
};

const lines = (sections: unknown) => (sections as Section[]).flatMap((s) => s.items);

function describe(r: Recipe, i: number) {
  return [
    `Recipe ${i}: ${r.title}`,
    r.description && r.description.slice(0, 300),
    r.totalMinutes && `Total time: ${r.totalMinutes} min`,
    `Ingredients: ${lines(r.ingredients).slice(0, 40).join('; ')}`,
    `Steps: ${lines(r.instructions).join(' ').slice(0, 1200)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Categories for each recipe, in order, or null if the AI failed. */
async function sortBatch(recipes: Recipe[]): Promise<string[][] | null> {
  if (!client) return null;
  try {
    const response = await client.messages.parse({
      model: env.anthropicModel,
      max_tokens: 8000,
      output_config: { effort: 'low', format: zodOutputFormat(sorted) },
      system: SYSTEM,
      messages: [{ role: 'user', content: recipes.map(describe).join('\n\n') }],
    });
    console.info(
      JSON.stringify({
        msg: 'ai categorize',
        model: response.model,
        recipes: recipes.length,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }),
    );
    const parsed = response.parsed_output;
    if (!parsed) return null;
    const byRecipe = new Map(parsed.recipes.map((r) => [r.recipe, r]));
    return recipes.map((_, i) => {
      const r = byRecipe.get(i);
      if (!r) return [];
      // Soups and sides are one pot anyway; the model tags them so despite the prompt.
      const onePotMeal = !r.type.some((t) => t === 'Soup & stew' || t === 'Side');
      const goodFor = r.goodFor.filter((g) => g !== 'One-pot' || onePotMeal);
      return normalizeCategories([...r.type, ...r.ingredient, ...r.cuisine, ...goodFor]);
    });
  } catch (err) {
    console.warn('Categorizing failed:', (err as Error).message);
    return null;
  }
}

async function saveBatch(recipes: Recipe[]) {
  const categories = await sortBatch(recipes);
  if (!categories) return false;
  for (const [i, r] of recipes.entries()) {
    if (!categories[i].length) continue;
    // Categories picked by hand in the meantime win.
    const now = await prisma.recipe.findUnique({ where: { id: r.id }, select: { _count: { select: { tags: true } } } });
    if (!now || now._count.tags > 0) continue;
    await prisma.recipe.update({
      where: { id: r.id },
      data: { tags: { connect: categories[i].map((name) => ({ name })) } },
    });
  }
  return true;
}

let running: Promise<void> | null = null;
let again = false;

/** Sorts every recipe with no categories. Concurrent callers share one run. */
export function categorizeRecipes(): Promise<void> {
  if (!client) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        const todo = await prisma.recipe.findMany({
          where: { tags: { none: {} } },
          orderBy: { createdAt: 'asc' },
          select: { id: true, title: true, description: true, totalMinutes: true, ingredients: true, instructions: true },
        });
        if (todo.length === 0) break;
        // Every category exists first, so batches saved in parallel only link to them.
        await prisma.tag.createMany({ data: ALL_CATEGORIES.map((name) => ({ name })), skipDuplicates: true });
        const batches: Recipe[][] = [];
        for (let i = 0; i < todo.length; i += RECIPES_PER_CALL) batches.push(todo.slice(i, i + RECIPES_PER_CALL));
        let failed = false;
        for (let i = 0; i < batches.length; i += PARALLEL_CALLS) {
          const results = await Promise.all(batches.slice(i, i + PARALLEL_CALLS).map(saveBatch));
          failed ||= results.includes(false);
        }
        // Don't loop on a failing AI; the next save or restart tries again.
        if (failed) break;
      } while (again);
    } catch (err) {
      console.warn('Categorizing failed:', (err as Error).message);
    } finally {
      running = null;
    }
  })();
  return running;
}

let timer: NodeJS.Timeout | null = null;

/** Sorts new recipes shortly after saves, so bulk imports share calls. */
export function scheduleCategorize(delay = 5000) {
  if (!client) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void categorizeRecipes();
  }, delay);
}
