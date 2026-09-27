import { prisma } from './db.js';
import { addToPlan } from './plan.js';

/** Meals: named, ordered sets of recipes. Shared by the REST routes and the MCP tools. */

const recipeSummary = {
  select: {
    id: true,
    title: true,
    image: true,
    servings: true,
    totalMinutes: true,
    prepMinutes: true,
    cookMinutes: true,
    ingredients: true,
  },
} as const;

export async function listMeals() {
  const meals = await prisma.meal.findMany({
    orderBy: { updatedAt: 'desc' },
    include: {
      recipes: {
        orderBy: { position: 'asc' },
        select: { recipe: { select: { title: true, image: true } } },
      },
    },
  });
  return meals.map(({ recipes, ...meal }) => ({
    ...meal,
    recipeCount: recipes.length,
    recipeTitles: recipes.map((r) => r.recipe.title),
    images: recipes.map((r) => r.recipe.image).filter((i): i is string => Boolean(i)).slice(0, 4),
  }));
}

export async function getMeal(id: string) {
  const meal = await prisma.meal.findUnique({
    where: { id },
    include: {
      recipes: { orderBy: { position: 'asc' }, include: { recipe: recipeSummary } },
    },
  });
  if (!meal) return null;
  const { recipes, ...rest } = meal;
  return { ...rest, recipes: recipes.map((r) => ({ scale: r.scale, recipe: r.recipe })) };
}

export async function createMeal(
  input: { name: string; notes?: string | null; servings?: number | null; recipeIds?: string[] },
  userId: string | null,
) {
  const recipeIds = [...new Set(input.recipeIds ?? [])];
  const found = await prisma.recipe.findMany({ where: { id: { in: recipeIds } }, select: { id: true } });
  const valid = new Set(found.map((r) => r.id));
  return prisma.meal.create({
    data: {
      name: input.name,
      notes: input.notes ?? null,
      servings: input.servings ?? null,
      createdById: userId,
      recipes: {
        create: recipeIds.filter((id) => valid.has(id)).map((recipeId, position) => ({ recipeId, position })),
      },
    },
  });
}

export async function updateMeal(
  id: string,
  input: {
    name?: string;
    notes?: string | null;
    servings?: number | null;
    /** Full, ordered replacement of the meal's recipes. */
    recipes?: { recipeId: string; scale?: number }[];
  },
) {
  const { recipes, ...fields } = input;
  return prisma.$transaction(async (tx) => {
    const meal = await tx.meal.update({ where: { id }, data: fields });
    if (recipes) {
      const seen = new Set<string>();
      const unique = recipes.filter((r) => !seen.has(r.recipeId) && seen.add(r.recipeId));
      await tx.mealRecipe.deleteMany({ where: { mealId: id } });
      await tx.mealRecipe.createMany({
        data: unique.map((r, position) => ({ mealId: id, recipeId: r.recipeId, scale: r.scale ?? 1, position })),
      });
    }
    return meal;
  });
}

export async function addRecipeToMeal(mealId: string, recipeId: string) {
  const last = await prisma.mealRecipe.findFirst({ where: { mealId }, orderBy: { position: 'desc' } });
  await prisma.mealRecipe.upsert({
    where: { mealId_recipeId: { mealId, recipeId } },
    create: { mealId, recipeId, position: (last?.position ?? -1) + 1 },
    update: {},
  });
  await prisma.meal.update({ where: { id: mealId }, data: { updatedAt: new Date() } });
}

/** Puts every recipe in the meal on this week, each at its own amount times `factor`. */
export async function addMealToPlan(mealId: string, factor: number, userId: string | null) {
  const meal = await getMeal(mealId);
  if (!meal) return null;
  for (const { recipe, scale } of meal.recipes) {
    await addToPlan(recipe.id, scale * factor, userId, mealId);
  }
  return meal;
}
