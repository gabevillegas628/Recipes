import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { prisma } from './db.js';
import { env } from './env.js';

/**
 * Mise en place for a recipe: the knife work to do up front, then one bowl per
 * moment ingredients go into the pan together ("add the garlic, nutmeg, salt
 * and pepper" -> one ramekin). Bowls and tasks point at ingredient lines by
 * index rather than restating them, so amounts stay exact and scale in the
 * browser. Built by Claude on first request and cached until the recipe's
 * ingredients or steps change.
 */

const client = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null;

const plan = z.object({
  tasks: z
    .array(
      z.object({
        text: z
          .string()
          .describe('Short imperative without amounts, e.g. "Mince the garlic" or "Grate the parmesan"'),
        ingredients: z.array(z.number().int()).describe('Numbers of the ingredient lines this task is for'),
      }),
    )
    .describe('Knife work and other hands-on prep to do before cooking, in a sensible order'),
  bowls: z
    .array(
      z.object({
        step: z.number().int().describe('Number of the step where this bowl goes in'),
        label: z.string().describe('Two or three words, e.g. "Seasonings", "Sauce liquids", "Pasta"'),
        items: z.array(
          z.object({
            ingredient: z.number().int(),
            note: z
              .string()
              .nullable()
              .describe('Only when just part of the line goes in this bowl, e.g. "half" or "the rest"; otherwise null'),
          }),
        ),
      }),
    )
    .describe('In step order'),
});

export type PrepPlan = z.infer<typeof plan>;

const SYSTEM = `You plan mise en place for a home cook: everything measured and prepped before the stove goes on.

You get a recipe's ingredient lines and steps, each numbered. Return:

tasks: the knife work and other prep to do first (mincing, dicing, slicing, grating, zesting, juicing, trimming, patting dry, softening butter, bringing to room temperature). Take these from preparation notes on the ingredient lines ("1 onion, diced") and from the steps. Leave out anything done during cooking, like browning or reducing. No amounts in the text; the app shows them.

bowls: group ingredients that go into the pan at the same moment into one bowl, so the cook fills one ramekin for "add the garlic, garlic powder, nutmeg, salt and pepper" instead of five. If a step adds things at different moments ("add the garlic, cook 1 minute, then add the cream"), make separate bowls in that order. An ingredient added alone gets its own bowl. The thing being seasoned (the chicken, the pasta) never shares a bowl with its seasonings: "season the chicken with salt, pepper and paprika" is one bowl of salt, pepper and paprika, and the chicken on its own. Every ingredient line belongs in at least one bowl. When an ingredient is divided across steps ("salt, divided", "half the cheese"), put it in each bowl with a note saying how much, as a share of the line ("half", "the rest") where you can, since the cook may scale the recipe. Ingredients for serving or garnish go in a bowl at the step where they're used, or the last step.

Refer to ingredients and steps only by their numbers.`;

type Section = { title: string | null; items: string[] };

function numbered(sections: Section[]): string {
  let n = 0;
  return sections
    .map((s) => [s.title ? `[${s.title}]` : null, ...s.items.map((item) => `${n++}. ${item}`)].filter(Boolean).join('\n'))
    .join('\n');
}

const count = (sections: Section[]) => sections.reduce((sum, s) => sum + s.items.length, 0);

export class PrepError extends Error {}

/** The cached plan when the recipe hasn't changed since it was made; otherwise a fresh one. */
export async function getPrepPlan(recipeId: string): Promise<PrepPlan | null> {
  const recipe = await prisma.recipe.findUnique({
    where: { id: recipeId },
    select: { title: true, ingredients: true, instructions: true, prep: true },
  });
  if (!recipe) return null;

  const ingredients = recipe.ingredients as Section[];
  const instructions = recipe.instructions as Section[];
  const hash = createHash('sha256').update(JSON.stringify([ingredients, instructions])).digest('hex');
  if (recipe.prep && recipe.prep.hash === hash) return recipe.prep.plan as PrepPlan;

  const fresh = await buildPlan(recipe.title, ingredients, instructions);
  await prisma.recipePrep.upsert({
    where: { recipeId },
    create: { recipeId, hash, plan: fresh },
    update: { hash, plan: fresh },
  });
  return fresh;
}

async function buildPlan(title: string, ingredients: Section[], instructions: Section[]): Promise<PrepPlan> {
  const ingredientCount = count(ingredients);
  const stepCount = count(instructions);
  if (ingredientCount === 0 || stepCount === 0) return { tasks: [], bowls: [] };
  if (!client) throw new PrepError('Prep planning needs AI, which isn’t set up (no ANTHROPIC_API_KEY).');

  const response = await client.beta.messages.parse({
    model: env.anthropicModel,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: zodOutputFormat(plan) },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `${title}\n\nIngredients:\n${numbered(ingredients)}\n\nSteps:\n${numbered(instructions)}`,
      },
    ],
  });

  console.info(
    JSON.stringify({
      msg: 'ai prep plan',
      model: response.model,
      stopReason: response.stop_reason,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }),
  );

  if (response.stop_reason === 'refusal') throw new PrepError('The AI declined to plan this recipe.');
  const result = response.parsed_output;
  if (!result) throw new PrepError('Couldn’t work out a prep plan for this recipe.');

  // Drop anything pointing past the end of the recipe.
  const validIngredient = (i: number) => i >= 0 && i < ingredientCount;
  return {
    tasks: result.tasks
      .map((t) => ({ text: t.text.trim(), ingredients: t.ingredients.filter(validIngredient) }))
      .filter((t) => t.text),
    bowls: result.bowls
      .filter((b) => b.step >= 0 && b.step < stepCount)
      .map((b) => ({ ...b, label: b.label.trim(), items: b.items.filter((i) => validIngredient(i.ingredient)) }))
      .filter((b) => b.items.length > 0)
      .sort((a, b) => a.step - b.step),
  };
}
