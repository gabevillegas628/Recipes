/**
 * Clears every recipe's categories and has Claude sort them all again, e.g. after
 * the category list changes (categoryList.ts). Also deletes any old tags not in the list.
 *   npm run recipes:resort -- --yes
 * Without --yes it only says which database it would change.
 */
import { ALL_CATEGORIES, CATEGORY_GROUPS } from '../categoryList.js';
import { categorizeRecipes } from '../categorize.js';
import { prisma } from '../db.js';

const host = (process.env.DATABASE_URL ?? '').match(/@([^:/]+)/)?.[1] ?? 'unknown';
const recipes = await prisma.recipe.count();
console.log(`Database: ${host}, ${recipes} recipes, ${await prisma.tag.count()} tags.`);
if (!process.argv.includes('--yes')) {
  console.log('Run again with --yes to clear every category and sort all recipes again.');
  process.exit(0);
}

// Deleting the tags drops every recipe's links to them too.
const { count } = await prisma.tag.deleteMany({});
console.log(`Deleted ${count} tags. Sorting ${recipes} recipes…`);
await categorizeRecipes();

const tags = await prisma.tag.findMany({ select: { name: true, _count: { select: { recipes: true } } } });
const counts = new Map(tags.map((t) => [t.name, t._count.recipes]));
for (const g of CATEGORY_GROUPS) {
  console.log(`${g.name}: ${g.values.map((v) => `${v} ${counts.get(v) ?? 0}`).join(', ')}`);
}
const stray = tags.filter((t) => !ALL_CATEGORIES.includes(t.name));
if (stray.length) console.log(`Not in the list (shouldn't happen): ${stray.map((t) => t.name).join(', ')}`);
console.log(`Still unsorted: ${await prisma.recipe.count({ where: { tags: { none: {} } } })}`);
process.exit(0);
