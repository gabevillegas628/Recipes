import { prisma } from '../db.js';
import { createRecipe } from '../recipes.js';
import { recipeInput } from '../recipeInput.js';
import type { RecipeDraft } from './draft.js';
import { ImportError } from './errors.js';
import { extractFromUrl, normalizeUrl } from './extract.js';
import { FetchError } from './safeFetch.js';

/**
 * Processes bulk-import jobs one at a time, in-process. Fine for a single
 * Railway instance; jobs left RUNNING by a restart are re-queued on boot.
 */

let running = false;

export function kickImportWorker() {
  if (running) return;
  running = true;
  void drain()
    .catch((err) => console.error('Import worker crashed:', err))
    .finally(() => {
      running = false;
    });
}

export async function resumeImportJobs() {
  await prisma.importJob.updateMany({ where: { status: 'RUNNING' }, data: { status: 'PENDING' } });
  kickImportWorker();
}

async function drain() {
  for (;;) {
    const next = await prisma.importJob.findFirst({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
    if (!next) return;

    const claimed = await prisma.importJob.updateMany({
      where: { id: next.id, status: 'PENDING' },
      data: { status: 'RUNNING', error: null },
    });
    if (claimed.count === 0) continue;

    await processJob(next.id, next.url, next.createdById);
  }
}

export async function findExistingRecipe(url: string) {
  let normalized: string;
  try {
    normalized = normalizeUrl(url);
  } catch {
    return null;
  }
  return prisma.recipe.findFirst({
    where: { sourceUrl: normalized },
    select: { id: true, title: true },
  });
}

export function draftToInput(draft: RecipeDraft) {
  const { imageUrl, ...rest } = draft;
  return recipeInput.parse({ ...rest, source: 'URL', imageUrl: imageUrl ?? undefined });
}

async function processJob(id: string, url: string, userId: string | null) {
  try {
    const existing = await findExistingRecipe(url);
    if (existing) {
      await prisma.importJob.update({
        where: { id },
        data: { status: 'DUPLICATE', recipeId: existing.id },
      });
      return;
    }

    const { draft, method } = await extractFromUrl(url);
    const recipe = await createRecipe(draftToInput(draft), {
      userId,
      needsReview: method === 'ai',
    });
    await prisma.importJob.update({
      where: { id },
      data: { status: 'DONE', method, recipeId: recipe.id },
    });
  } catch (err) {
    const known = err instanceof ImportError || err instanceof FetchError;
    if (!known) console.error(`Import job ${id} (${url}) failed:`, err);
    await prisma.importJob.update({
      where: { id },
      data: {
        status: 'FAILED',
        error: known ? (err as Error).message : 'Something went wrong importing this page.',
      },
    });
  }
}
