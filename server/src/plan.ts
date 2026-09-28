import { prisma } from './db.js';
import { itemKey, rememberedItems, scheduleSort, totalSources } from './groceries.js';

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
      meal: { select: { id: true, name: true } },
    },
  });
}

/** Adds a recipe to this week, or updates its servings if it's already there. */
export async function addToPlan(
  recipeId: string,
  scale: number,
  userId: string | null,
  mealId: string | null = null,
) {
  await archiveOldPlanItems();
  const existing = await prisma.planItem.findFirst({ where: { recipeId, archivedAt: null } });
  if (existing) {
    return prisma.planItem.update({
      where: { id: existing.id },
      // Adding a single recipe keeps it in whatever meal it was planned with.
      data: { scale, ...(mealId ? { mealId } : {}) },
    });
  }
  return prisma.planItem.create({ data: { recipeId, scale, addedById: userId, mealId } });
}

export async function clearPlan() {
  await prisma.planItem.updateMany({ where: { archivedAt: null }, data: { archivedAt: new Date() } });
}

async function groceryItems() {
  return prisma.groceryItem.findMany({
    orderBy: [{ checked: 'asc' }, { createdAt: 'asc' }],
    include: { recipe: { select: { id: true, title: true } } },
  });
}

type GroceryRow = Awaited<ReturnType<typeof groceryItems>>[number];

/** Lines for the same item, shown and ticked as one row. */
export interface GroceryGroup {
  key: string;
  /** The shared item name; for a single line, just use its text. */
  name: string;
  aisle: string | null;
  checked: boolean;
  /** One amount to buy across the lines, when they've been combined. */
  buy: string | null;
  items: GroceryRow[];
}

/** The list, with lines for the same item combined. Unsorted items fall back to a rough name match. */
export async function getGroceries(): Promise<GroceryGroup[]> {
  const items = await groceryItems();
  const groups = new Map<string, GroceryGroup>();
  for (const item of items) {
    const name = item.name ?? (itemKey(item.text) || item.text.toLowerCase());
    const key = `${item.checked ? 'done' : 'open'}:${name}`;
    const group = groups.get(key);
    if (group) {
      group.items.push(item);
      group.aisle ??= item.aisle;
    } else {
      groups.set(key, { key, name, aisle: item.aisle, checked: item.checked, buy: null, items: [item] });
    }
  }

  const combined = [...groups.values()].filter((g) => g.items.length > 1);
  if (combined.length > 0) {
    const totals = await prisma.groceryTotal.findMany({ where: { name: { in: combined.map((g) => g.name) } } });
    const byName = new Map(totals.map((t) => [t.name, t]));
    for (const group of combined) {
      const total = byName.get(group.name);
      if (total && total.sources === totalSources(group.items.map((i) => i.text))) group.buy = total.buy;
    }
  }
  return [...groups.values()];
}

export async function addGroceries(
  items: { text: string; recipeId?: string | null }[],
  userId: string | null,
) {
  const clean = items.map((i) => ({ ...i, text: i.text.trim() })).filter((i) => i.text);
  // Save now; anything without a remembered aisle is sorted in the background.
  const known = await rememberedItems(clean.map((i) => i.text));
  await prisma.groceryItem.createMany({
    data: clean.map((item, i) => ({
      text: item.text,
      aisle: known[i]?.aisle ?? null,
      name: known[i]?.name ?? null,
      recipeId: item.recipeId ?? null,
      createdById: userId,
    })),
  });
  // Sort anything new, and re-estimate combined amounts now that lines were added.
  scheduleSort();
  return clean.length;
}
