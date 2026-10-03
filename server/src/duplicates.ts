import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { prisma } from './db.js';
import { env } from './env.js';
import { ingredientLines, type IndexedItem } from './ingredients.js';
import { ingredientWeights, looksAlike, resemblance, type Comparable } from './similarity.js';

/**
 * Catches a recipe Claude writes that the collection already has, or nearly:
 * "Chicken in Mushroom Wine Sauce" when there's a Chicken Marsala. Shortlists
 * the closest few by title and ingredients, then the small model reads both
 * ingredient lists and decides whether a cook would call them the same dish.
 * Without AI, falls back to the shortlist rule alone.
 */

const client = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null;
const effortFor = (model: string) => (model.startsWith('claude-haiku') ? {} : { effort: 'low' as const });

/** Possible matches per new recipe, looked at by the AI. */
const SHORTLIST = 8;
const MIN_RESEMBLANCE = 0.4;

export interface NewRecipe {
  key: string;
  title: string;
  lines: string[];
  items: IndexedItem[];
}

export interface Match {
  id: string;
  title: string;
}

interface LibraryRecipe extends Comparable {
  id: string;
  lines: string[];
}

async function library(): Promise<LibraryRecipe[]> {
  const rows = await prisma.recipe.findMany({
    select: { id: true, title: true, ingredients: true, ingredientIndex: { select: { items: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    lines: ingredientLines(r.ingredients as { title: string | null; items: string[] }[]),
    weights: ingredientWeights((r.ingredientIndex?.items ?? []) as unknown as IndexedItem[]),
  }));
}

const verdict = z.object({
  recipes: z.array(
    z.object({
      recipe: z.number().int(),
      sameAs: z.array(z.number().int()).describe('Numbers of the saved recipes that are the same dish; empty if none'),
    }),
  ),
});

const SYSTEM = `You help keep a family's recipe collection free of duplicates. Each new recipe below comes with a few saved recipes that look close. For each new recipe, say which saved ones are the same dish.

The same dish: a cook would call it the same recipe, maybe with different amounts, a swapped herb or cheese, a different pan or appliance, or a different name ("Chicken in Mushroom Wine Sauce" and "Chicken Marsala"; "Russet Mashed Potatoes" and "Garlic Mashed Potatoes").
Not the same: a different main ingredient, cuisine or format, even with lots of ingredients in common ("Chicken Marsala" and "Chicken Fettuccine Alfredo"; "Chicken Noodle Soup" and "Chicken Tortilla Soup").`;

const listed = (title: string, lines: string[]) => `${title}\n${lines.slice(0, 30).map((l) => `  - ${l}`).join('\n')}`;

/** For each new recipe, the saved recipes that are essentially the same dish. */
export async function findDuplicates(recipes: NewRecipe[]): Promise<Map<string, Match[]>> {
  const result = new Map<string, Match[]>(recipes.map((r) => [r.key, []]));
  if (recipes.length === 0) return result;
  const saved = await library();

  const candidates = recipes.map((r) => {
    const mine: Comparable = { title: r.title, weights: ingredientWeights(r.items) };
    return saved
      .map((s) => ({ s, score: resemblance(mine, s), alike: looksAlike(mine, s) }))
      .filter((c) => c.alike || c.score >= MIN_RESEMBLANCE)
      .sort((a, b) => b.score - a.score)
      .slice(0, SHORTLIST);
  });
  if (candidates.every((c) => c.length === 0)) return result;

  const fallback = () => {
    recipes.forEach((r, i) => result.set(r.key, candidates[i].filter((c) => c.alike).map(({ s }) => ({ id: s.id, title: s.title }))));
    return result;
  };
  if (!client) return fallback();

  const asked = recipes.map((r, i) => ({ r, i })).filter(({ i }) => candidates[i].length > 0);
  const prompt = asked
    .map(({ r, i }, n) =>
      [
        `New recipe ${n}: ${listed(r.title, r.lines)}`,
        ...candidates[i].map((c, j) => `Saved recipe ${j}: ${listed(c.s.title, c.s.lines)}`),
      ].join('\n\n'),
    )
    .join('\n\n---\n\n');
  try {
    const response = await client.messages.parse({
      model: env.groceryModel,
      max_tokens: 4000,
      output_config: { format: zodOutputFormat(verdict), ...effortFor(env.groceryModel) },
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });
    console.info(
      JSON.stringify({
        msg: 'ai duplicate check',
        model: response.model,
        recipes: asked.length,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }),
    );
    if (!response.parsed_output) return fallback();
    for (const v of response.parsed_output.recipes) {
      const ask = asked[v.recipe];
      if (!ask) continue;
      const list = candidates[ask.i];
      const same = [...new Set(v.sameAs)].flatMap((j) => (list[j] ? [{ id: list[j].s.id, title: list[j].s.title }] : []));
      result.set(ask.r.key, same);
    }
    return result;
  } catch (err) {
    console.warn('Duplicate check failed:', (err as Error).message);
    return fallback();
  }
}
