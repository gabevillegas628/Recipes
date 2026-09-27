import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { prisma } from './db.js';
import type { Prisma } from './generated/prisma/client.js';
import { ImportError } from './import/errors.js';
import { extractFromUrl } from './import/extract.js';
import { FetchError } from './import/safeFetch.js';
import { draftToInput, findExistingRecipe } from './import/worker.js';
import { addMealToPlan, createMeal, getMeal, listMeals } from './meals.js';
import { addGroceries, addToPlan, getGroceries, getPlan } from './plan.js';
import { recipeInput } from './recipeInput.js';
import { createRecipe, searchWhere, serialize, updateRecipe, withTags } from './recipes.js';

/**
 * The MCP server Claude connects to (as a custom connector) to save and look up recipes.
 * Built per request: the transport is stateless.
 */

const section = z.object({
  title: z
    .string()
    .nullish()
    .describe('Group heading such as "For the sauce". Omit when the recipe has a single group.'),
  items: z.array(z.string()).describe('One ingredient line or one step per item'),
});

const recipeFields = {
  title: z.string().describe('Recipe name'),
  description: z.string().nullish().describe('One or two sentences about the dish'),
  servings: z.string().nullish().describe('e.g. "4" or "2 loaves"'),
  prepMinutes: z.number().int().nullish(),
  cookMinutes: z.number().int().nullish(),
  totalMinutes: z.number().int().nullish(),
  ingredients: z
    .array(section)
    .describe('Ingredients with quantities, e.g. "2 cups flour". Use sections for groups.'),
  instructions: z.array(section).describe('Steps in order, one step per item'),
  notes: z
    .string()
    .nullish()
    .describe('Tips, substitutions, variations or context worth keeping with the recipe'),
  tags: z
    .array(z.string())
    .nullish()
    .describe('2-5 short lowercase tags like "dinner", "chicken", "vegetarian", "quick"'),
  imageUrl: z
    .string()
    .nullish()
    .describe(
      'Direct link to a photo of the dish (an image file URL), if one appeared in the conversation. The server downloads and stores it.',
    ),
  sourceUrl: z.string().nullish().describe('Link to the original recipe, if it came from a website'),
};

type Link = (id: string) => string;

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function toolError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/** Recipe shape handed back to Claude: drops internal fields, adds the web link. */
function forClaude(recipe: ReturnType<typeof serialize<Prisma.RecipeGetPayload<{ include: typeof withTags }>>>, link: Link) {
  const { createdById: _c, image, needsReview: _n, ...rest } = recipe;
  return { ...rest, hasPhoto: Boolean(image), url: link(recipe.id) };
}

export function buildMcpServer(baseUrl: string) {
  const link: Link = (id) => `${baseUrl}/r/${id}`;
  const server = new McpServer({ name: 'recipe-box', version: '1.0.0' });

  server.registerTool(
    'save_recipe',
    {
      title: 'Save recipe',
      description:
        "Save a recipe to the user's personal recipe box. Use this when the user asks to save, keep or store a recipe from the conversation. Include the complete ingredient list with quantities and every step; don't summarize. Returns the saved recipe's link.",
      inputSchema: recipeFields,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const parsed = recipeInput.safeParse({
        ...args,
        tags: args.tags ?? [],
        imageUrl: args.imageUrl || undefined,
        source: 'CLAUDE',
      });
      if (!parsed.success) return toolError(z.prettifyError(parsed.error));
      const recipe = await createRecipe(parsed.data, { userId: null });
      return text({ saved: true, id: recipe.id, title: recipe.title, url: link(recipe.id) });
    },
  );

  server.registerTool(
    'import_recipe_from_url',
    {
      title: 'Import recipe from a link',
      description:
        "Import a recipe from a web page into the user's recipe box. The server fetches the page and extracts the recipe itself, so use this for recipe links instead of copying the content into save_recipe.",
      inputSchema: { url: z.string().describe('The recipe page URL') },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ url }) => {
      try {
        const existing = await findExistingRecipe(url);
        if (existing) {
          return text({ saved: false, alreadySaved: true, ...existing, url: link(existing.id) });
        }
        const { draft, method } = await extractFromUrl(url);
        const recipe = await createRecipe(draftToInput(draft), {
          userId: null,
          needsReview: method === 'ai',
        });
        return text({ saved: true, id: recipe.id, title: recipe.title, url: link(recipe.id) });
      } catch (err) {
        if (err instanceof ImportError || err instanceof FetchError) return toolError(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    'search_recipes',
    {
      title: 'Search recipes',
      description:
        "Search the user's recipe box by words in the title, description, ingredients or tags. Call with no query to list the most recent recipes. Use get_recipe for the full recipe.",
      inputSchema: {
        query: z.string().nullish().describe('Words to look for, e.g. "chickpea curry"'),
        tag: z.string().nullish().describe('Only recipes with this tag'),
        limit: z.number().int().min(1).max(50).nullish().describe('Default 20'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, tag, limit }) => {
      const and = await searchWhere(query ?? '');
      if (tag) and.push({ tags: { some: { name: tag.trim().toLowerCase() } } });
      const where: Prisma.RecipeWhereInput = { AND: and };

      const recipes = await prisma.recipe.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit ?? 20,
        select: {
          id: true,
          title: true,
          description: true,
          source: true,
          totalMinutes: true,
          favorite: true,
          createdAt: true,
          tags: withTags.tags,
        },
      });
      return text(recipes.map((r) => ({ ...serialize(r), url: link(r.id) })));
    },
  );

  server.registerTool(
    'get_recipe',
    {
      title: 'Get recipe',
      description: 'Get a full recipe (ingredients, steps, notes) by id.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const recipe = await prisma.recipe.findUnique({ where: { id }, include: withTags });
      if (!recipe) return toolError(`No recipe with id ${id}`);
      return text(forClaude(serialize(recipe), link));
    },
  );

  server.registerTool(
    'update_recipe',
    {
      title: 'Update recipe',
      description:
        'Change an existing recipe. Only the fields you pass are changed; ingredients, instructions and tags replace the whole list, so send the complete updated list. Call get_recipe first to see the current version.',
      inputSchema: {
        id: z.string(),
        ...Object.fromEntries(
          Object.entries(recipeFields).map(([k, v]) => [k, v.optional()]),
        ) as { [K in keyof typeof recipeFields]: z.ZodOptional<(typeof recipeFields)[K]> },
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id, ...changes }) => {
      const existing = await prisma.recipe.findUnique({ where: { id }, include: withTags });
      if (!existing) return toolError(`No recipe with id ${id}`);

      const current = serialize(existing);
      const merged = {
        title: current.title,
        description: current.description,
        source: current.source,
        sourceUrl: current.sourceUrl,
        servings: current.servings,
        prepMinutes: current.prepMinutes,
        cookMinutes: current.cookMinutes,
        totalMinutes: current.totalMinutes,
        ingredients: current.ingredients,
        instructions: current.instructions,
        notes: current.notes,
        favorite: current.favorite,
        tags: current.tags,
        ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
        imageUrl: changes.imageUrl || undefined,
      };
      const parsed = recipeInput.safeParse({ ...merged, tags: merged.tags ?? [] });
      if (!parsed.success) return toolError(z.prettifyError(parsed.error));

      const updated = await updateRecipe(id, parsed.data);
      if (!updated) return toolError(`No recipe with id ${id}`);
      return text({ updated: true, id, title: updated.title, url: link(id) });
    },
  );

  server.registerTool(
    'get_this_week',
    {
      title: 'Get this week',
      description:
        'List the recipes planned for this week (recipes drop off 7 days after being added), with whether each has been cooked.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const plan = await getPlan();
      return text(
        plan.map((p) => ({
          planItemId: p.id,
          recipeId: p.recipe.id,
          title: p.recipe.title,
          servingsMultiplier: p.scale,
          cooked: Boolean(p.cookedAt),
          addedOn: p.createdAt,
          url: link(p.recipe.id),
        })),
      );
    },
  );

  server.registerTool(
    'add_to_this_week',
    {
      title: 'Add to this week',
      description:
        "Put a saved recipe on this week's meal plan. Use search_recipes to find the id. servingsMultiplier scales it (0.5 = half, 2 = double).",
      inputSchema: {
        recipeId: z.string(),
        servingsMultiplier: z.number().positive().max(20).nullish(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ recipeId, servingsMultiplier }) => {
      const recipe = await prisma.recipe.findUnique({ where: { id: recipeId }, select: { title: true } });
      if (!recipe) return toolError(`No recipe with id ${recipeId}`);
      await addToPlan(recipeId, servingsMultiplier ?? 1, null);
      return text({ added: true, title: recipe.title, url: link(recipeId) });
    },
  );

  server.registerTool(
    'get_grocery_list',
    {
      title: 'Get grocery list',
      description: 'Show the shared grocery list, grouped by store section, with checked-off items marked.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const items = await getGroceries();
      return text(
        items.map((i) => ({ text: i.text, aisle: i.aisle, checked: i.checked, forRecipe: i.recipe?.title ?? null })),
      );
    },
  );

  server.registerTool(
    'add_to_grocery_list',
    {
      title: 'Add to grocery list',
      description:
        "Add items to the shared grocery list, one ingredient per item with its quantity (e.g. \"2 lb chicken thighs\"). Before adding a recipe's ingredients, leave out pantry staples the user said they already have. Items are sorted into store sections automatically.",
      inputSchema: {
        items: z.array(z.string()).min(1).max(100),
        recipeId: z.string().nullish().describe('The recipe these are for, if any'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ items, recipeId }) => {
      const added = await addGroceries(
        items.map((t) => ({ text: t, recipeId: recipeId ?? null })),
        null,
      );
      return text({ added, url: `${baseUrl}/groceries` });
    },
  );

  server.registerTool(
    'list_meals',
    {
      title: 'List meals',
      description:
        'List saved meals. A meal is a named set of recipes cooked together, like "Taco night" or "Thanksgiving".',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const meals = await listMeals();
      return text(
        meals.map((m) => ({
          mealId: m.id,
          name: m.name,
          serves: m.servings,
          recipes: m.recipeTitles,
          url: `${baseUrl}/m/${m.id}`,
        })),
      );
    },
  );

  server.registerTool(
    'get_meal',
    {
      title: 'Get meal',
      description: "Get a meal's recipes (with ids and each recipe's amount multiplier) and notes.",
      inputSchema: { mealId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ mealId }) => {
      const meal = await getMeal(mealId);
      if (!meal) return toolError(`No meal with id ${mealId}`);
      return text({
        mealId: meal.id,
        name: meal.name,
        serves: meal.servings,
        notes: meal.notes,
        recipes: meal.recipes.map((r) => ({
          recipeId: r.recipe.id,
          title: r.recipe.title,
          recipeServes: r.recipe.servings,
          amountMultiplier: r.scale,
        })),
        url: `${baseUrl}/m/${meal.id}`,
      });
    },
  );

  server.registerTool(
    'create_meal',
    {
      title: 'Create meal',
      description:
        'Group saved recipes into a meal (e.g. a main and sides, or a holiday dinner). Find recipe ids with search_recipes first; save any new recipes with save_recipe before adding them. Recipes are kept in the order given.',
      inputSchema: {
        name: z.string(),
        recipeIds: z.array(z.string()).min(1).max(50),
        serves: z.number().int().positive().nullish().describe('How many people the meal feeds as planned'),
        notes: z.string().nullish().describe('Timing or plan notes, e.g. "Turkey in by 11"'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ name, recipeIds, serves, notes }) => {
      const meal = await createMeal({ name, recipeIds, servings: serves ?? null, notes: notes ?? null }, null);
      const saved = await getMeal(meal.id);
      return text({
        created: true,
        mealId: meal.id,
        recipes: saved?.recipes.map((r) => r.recipe.title),
        url: `${baseUrl}/m/${meal.id}`,
      });
    },
  );

  server.registerTool(
    'add_meal_to_week',
    {
      title: 'Add meal to this week',
      description:
        "Put every recipe in a meal on this week's plan, grouped under the meal. Pass serves to scale the whole meal to a number of people (needs the meal to have a serving count), or multiplier to scale directly.",
      inputSchema: {
        mealId: z.string(),
        serves: z.number().positive().nullish(),
        multiplier: z.number().positive().max(20).nullish(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ mealId, serves, multiplier }) => {
      const meal = await getMeal(mealId);
      if (!meal) return toolError(`No meal with id ${mealId}`);
      const factor = serves && meal.servings ? serves / meal.servings : (multiplier ?? 1);
      await addMealToPlan(mealId, factor, null);
      return text({ added: true, meal: meal.name, recipes: meal.recipes.length, multiplier: factor });
    },
  );

  return server;
}
