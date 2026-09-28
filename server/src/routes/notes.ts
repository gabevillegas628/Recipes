import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { capture, captureEnabled } from '../capture.js';
import { ImportError } from '../import/errors.js';
import { FetchError } from '../import/safeFetch.js';
import {
  createNote,
  createNoteBody,
  deleteNote,
  getNote,
  listNotes,
  NoteError,
  updateNote,
  updateNoteBody,
} from '../notes.js';

const idParams = z.object({ id: z.string() });
const MAX_PHOTOS = 4;

export async function noteRoutes(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: MAX_PHOTOS } });
  app.addHook('preHandler', requireAuth);

  app.get('/api/capture/config', async () => ({ aiEnabled: captureEnabled }));

  /** Sorts text and/or photos into a note, reminder, appointment, recipe or grocery list. Saves nothing. */
  app.post('/api/capture', async (request, reply) => {
    const photos: Buffer[] = [];
    let text = '';
    let now = '';
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          const buffer = await part.toBuffer();
          if (part.file.truncated) return reply.code(413).send({ error: 'A photo is too large (25 MB max).' });
          photos.push(buffer);
        } else if (part.fieldname === 'text') {
          text = String(part.value);
        } else if (part.fieldname === 'now') {
          now = String(part.value).slice(0, 100);
        }
      }
    } catch {
      return reply.code(400).send({ error: `Send up to ${MAX_PHOTOS} photos at a time.` });
    }
    try {
      return await capture(text, photos, now || new Date().toUTCString());
    } catch (err) {
      if (err instanceof ImportError || err instanceof FetchError) {
        return reply.code(422).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get('/api/notes', async () => listNotes());

  app.get('/api/notes/:id', async (request, reply) => {
    const note = await getNote(idParams.parse(request.params).id);
    return note ?? reply.code(404).send({ error: 'Note not found' });
  });

  app.post('/api/notes', async (request, reply) => {
    const parsed = createNoteBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    try {
      return reply.code(201).send(await createNote(parsed.data, request.userId));
    } catch (err) {
      if (err instanceof NoteError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.patch('/api/notes/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = updateNoteBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    try {
      return (await updateNote(id, parsed.data)) ?? reply.code(404).send({ error: 'Note not found' });
    } catch (err) {
      if (err instanceof NoteError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/api/notes/:id', async (request, reply) => {
    const deleted = await deleteNote(idParams.parse(request.params).id);
    return deleted ? reply.code(204).send() : reply.code(404).send({ error: 'Note not found' });
  });
}
