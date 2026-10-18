/**
 * The recipe categories: a fixed vocabulary in a few groups. A recipe's tags are
 * these and nothing else; a recipe can have any number from each group. Claude
 * sorts recipes into them (categorize.ts). No imports, so the web app shares it.
 *
 * Adding a value: add it here, deploy, and re-sort (scripts/resortRecipes.ts) so
 * existing recipes get it too.
 */

export const CATEGORY_GROUPS = [
  {
    key: 'type',
    name: 'Type',
    values: ['Main', 'Soup & stew', 'Side', 'Salad', 'Breakfast', 'Sauces & basics', 'Snack', 'Dessert'],
  },
  {
    key: 'ingredient',
    name: 'Main ingredient',
    values: ['Chicken', 'Beef', 'Pork', 'Sausage', 'Turkey', 'Seafood', 'Pasta', 'Vegetarian'],
  },
  {
    key: 'cuisine',
    name: 'Cuisine',
    values: ['Italian', 'American', 'Mexican', 'French', 'Asian', 'Indian', 'Mediterranean', 'Eastern European'],
  },
  {
    key: 'goodFor',
    name: 'Good for',
    values: ['Quick', 'One-pot', 'Make-ahead', 'Slow cooker', 'Pressure cooker', 'Air fryer', 'Kid-friendly', 'Holiday'],
  },
] as const;

export type CategoryGroupKey = (typeof CATEGORY_GROUPS)[number]['key'];

export const ALL_CATEGORIES: string[] = CATEGORY_GROUPS.flatMap((g) => [...g.values]);

const byLowerName = new Map(ALL_CATEGORIES.map((c) => [c.toLowerCase(), c]));

/** Tags as given (any case) to category names, in vocabulary order; anything else is dropped. */
export function normalizeCategories(tags: string[]): string[] {
  const picked = new Set(tags.map((t) => byLowerName.get(t.trim().toLowerCase())).filter((c): c is string => Boolean(c)));
  return ALL_CATEGORIES.filter((c) => picked.has(c));
}

/** The group a category belongs to. */
export function groupOf(category: string) {
  return CATEGORY_GROUPS.find((g) => (g.values as readonly string[]).includes(category));
}
