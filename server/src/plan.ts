import { prisma } from './db.js';
import { sortGroceries } from './groceries.js';

/**
 * "This week" and the grocery list: shared by the REST routes and the MCP tools.
 * Planned recipes drop off 7 days after they were added, so the week never piles up
 * and a plan made on the weekend survives into the week it's for.
 */

export const PLAN_DAYS = 7;

async function archiveOldPlanItems() {
  const cutoff = new Date(Date.now() - PLAN_DAYS * 24 * 60 * 60 * 1000);
  await prisma.planItem.updateMany({
    where: { archivedAt: null, createdAt: { lt: cutoff } },
    data: { archivedAt: new Date() },
  });
}

export async function getPlan() {
  await archiveOldPlanItems();
  return prisma.planItem.findMany({
    where: { archivedAt: null },
    orderBy: { createdAt: 'asc' },
    include: {
      recipe: {
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
      },
      addedBy: { select: { name: true } },
    },
  });
}

/** Adds a recipe to this week, or updates its servings if it's already there. */
export async function addToPlan(recipeId: string, scale: number, userId: string | null) {
  await archiveOldPlanItems();
  const existing = await prisma.planItem.findFirst({ where: { recipeId, archivedAt: null } });
  if (existing) {
    return prisma.planItem.update({ where: { id: existing.id }, data: { scale } });
  }
  return prisma.planItem.create({ data: { recipeId, scale, addedById: userId } });
}

export async function clearPlan() {
  await prisma.planItem.updateMany({ where: { archivedAt: null }, data: { archivedAt: new Date() } });
}

export async function getGroceries() {
  return prisma.groceryItem.findMany({
    orderBy: [{ checked: 'asc' }, { createdAt: 'asc' }],
    include: { recipe: { select: { id: true, title: true } } },
  });
}

export async function addGroceries(
  items: { text: string; recipeId?: string | null }[],
  userId: string | null,
) {
  const clean = items.map((i) => ({ ...i, text: i.text.trim() })).filter((i) => i.text);
  const sorted = await sortGroceries(clean.map((i) => i.text));
  await prisma.groceryItem.createMany({
    data: clean.map((item, i) => ({
      text: sorted[i].text,
      aisle: sorted[i].aisle,
      recipeId: item.recipeId ?? null,
      createdById: userId,
    })),
  });
  return clean.length;
}
