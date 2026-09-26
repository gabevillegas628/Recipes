import { prisma } from './db.js';
import { deleteImage, saveImageFromUrl } from './images.js';
import type { RecipeInput } from './recipeInput.js';

/**
 * Recipe writes shared by the REST routes, the import worker and (later) the MCP tools.
 * Handles tags and downloading images.
 */

export const withTags = { tags: { select: { name: true }, orderBy: { name: 'asc' } } } as const;

export function serialize<T extends { tags: { name: string }[] }>(recipe: T) {
  return { ...recipe, tags: recipe.tags.map((t) => t.name) };
}

function fields(input: RecipeInput) {
  const { tags: _tags, imageUrl: _imageUrl, ...rest } = input;
  return rest;
}

function tagConnect(tags: string[]) {
  return tags.map((name) => ({ where: { name }, create: { name } }));
}

/** Downloads an image, returning null (not throwing) if it fails; a recipe is still useful without one. */
async function tryDownload(url: string): Promise<string | null> {
  try {
    return await saveImageFromUrl(url);
  } catch (err) {
    console.warn(`Image download failed for ${url}: ${(err as Error).message}`);
    return null;
  }
}

export async function createRecipe(
  input: RecipeInput,
  { userId, needsReview = false }: { userId: string | null; needsReview?: boolean },
) {
  const image = input.imageUrl ? await tryDownload(input.imageUrl) : null;
  const recipe = await prisma.recipe.create({
    data: {
      ...fields(input),
      image,
      needsReview,
      createdById: userId,
      tags: { connectOrCreate: tagConnect(input.tags) },
    },
    include: withTags,
  });
  return serialize(recipe);
}

/** Full replace of the recipe's fields. Returns null if it doesn't exist. */
export async function updateRecipe(id: string, input: RecipeInput) {
  const existing = await prisma.recipe.findUnique({ where: { id }, select: { image: true } });
  if (!existing) return null;

  let image = existing.image;
  if (input.imageUrl === null) {
    image = null;
  } else if (input.imageUrl) {
    image = (await tryDownload(input.imageUrl)) ?? existing.image;
  }

  const recipe = await prisma.recipe.update({
    where: { id },
    data: {
      ...fields(input),
      image,
      needsReview: false,
      tags: { set: [], connectOrCreate: tagConnect(input.tags) },
    },
    include: withTags,
  });
  if (image !== existing.image) await deleteImage(existing.image);
  return serialize(recipe);
}

export async function deleteRecipe(id: string): Promise<boolean> {
  const existing = await prisma.recipe.findUnique({ where: { id }, select: { image: true } });
  if (!existing) return false;
  await prisma.recipe.delete({ where: { id } });
  await deleteImage(existing.image);
  return true;
}
