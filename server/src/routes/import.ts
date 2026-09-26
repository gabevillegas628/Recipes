import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { prisma } from '../db.js';
import { aiEnabled } from '../import/ai.js';
import { ImportError } from '../import/errors.js';
import { extractFromText, extractFromUrl } from '../import/extract.js';
import { FetchError } from '../import/safeFetch.js';
import { findExistingRecipe, kickImportWorker } from '../import/worker.js';

const MAX_BULK_URLS = 500;

function sendImportError(reply: FastifyReply, err: unknown) {
  if (err instanceof ImportError || err instanceof FetchError) {
    return reply.code(422).send({ error: err.message });
  }
  throw err;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function importRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/import/config', async () => ({ aiEnabled }));

  /** Extract a recipe from a URL for preview/editing. Nothing is saved. */
  app.post('/api/import/url', async (request, reply) => {
    const parsed = z.object({ url: z.string().trim() }).safeParse(request.body);
    if (!parsed.success || !isHttpUrl(parsed.data.url)) {
      return reply.code(400).send({ error: 'Enter a link starting with http:// or https://' });
    }
    try {
      const [result, duplicateOf] = await Promise.all([
        extractFromUrl(parsed.data.url),
        findExistingRecipe(parsed.data.url),
      ]);
      return { ...result, duplicateOf };
    } catch (err) {
      return sendImportError(reply, err);
    }
  });

  /** Extract a recipe from pasted text with AI. Nothing is saved. */
  app.post('/api/import/text', async (request, reply) => {
    const parsed = z
      .object({ text: z.string(), url: z.string().trim().optional() })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Paste some recipe text first.' });
    const url = parsed.data.url && isHttpUrl(parsed.data.url) ? parsed.data.url : null;
    try {
      return { ...(await extractFromText(parsed.data.text, url)), duplicateOf: null };
    } catch (err) {
      return sendImportError(reply, err);
    }
  });

  /** Queue many URLs (one per line) to import in the background. */
  app.post('/api/import/bulk', async (request, reply) => {
    const parsed = z.object({ text: z.string() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Paste one link per line.' });

    const lines = parsed.data.text
      .split(/\s+/)
      .map((l) => l.trim())
      .filter(Boolean);
    const urls = [...new Set(lines.filter(isHttpUrl))];
    const invalid = lines.filter((l) => !isHttpUrl(l));

    if (urls.length === 0) return reply.code(400).send({ error: 'No links found.' });
    if (urls.length > MAX_BULK_URLS) {
      return reply.code(400).send({ error: `At most ${MAX_BULK_URLS} links at a time.` });
    }

    await prisma.importJob.createMany({
      data: urls.map((url) => ({ url, createdById: request.userId })),
    });
    kickImportWorker();
    return { queued: urls.length, invalid };
  });

  app.get('/api/import/jobs', async () => {
    const jobs = await prisma.importJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { recipe: { select: { id: true, title: true } } },
    });
    return jobs;
  });

  app.post('/api/import/jobs/:id/retry', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const result = await prisma.importJob.updateMany({
      where: { id, status: 'FAILED' },
      data: { status: 'PENDING', error: null },
    });
    if (result.count === 0) return reply.code(404).send({ error: 'No failed job with that id' });
    kickImportWorker();
    return { ok: true };
  });

  /** Clears finished jobs (done, duplicate, failed) from the list. */
  app.delete('/api/import/jobs', async () => {
    const result = await prisma.importJob.deleteMany({
      where: { status: { in: ['DONE', 'DUPLICATE', 'FAILED'] } },
    });
    return { deleted: result.count };
  });
}
