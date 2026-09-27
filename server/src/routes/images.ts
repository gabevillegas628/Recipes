import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.js';
import { saveImage } from '../images.js';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Photo uploads from the phone (camera or library). Returns the stored image name. */
export async function imageRoutes(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  app.addHook('preHandler', requireAuth);

  app.post('/api/images', async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: 'No photo received.' });

    const buffer = await file.toBuffer().catch(() => null);
    if (!buffer || file.file.truncated) {
      return reply.code(413).send({ error: 'That photo is too large (25 MB max).' });
    }
    try {
      return { image: await saveImage(buffer) };
    } catch {
      return reply.code(400).send({ error: "Couldn't read that photo. Try a JPEG or PNG." });
    }
  });
}
