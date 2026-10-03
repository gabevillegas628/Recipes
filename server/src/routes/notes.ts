import Anthropic from '@anthropic-ai/sdk';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { capture, captureEnabled, findTimeForReminder } from '../capture.js';
import { FindTimeError } from '../findTimeService.js';
import { GoogleApiError, GoogleAuthError } from '../google.js';
import { prisma } from '../db.js';
import { ImportError } from '../import/errors.js';
import { FetchError } from '../import/safeFetch.js';
import {
  createNote,
  createNoteBody,
  deleteNote,
  forgetPastAppointments,
  getNote,
  listGroups,
  listNotes,
  NoteError,
  renameGroup,
  updateNote,
  updateNoteBody,
} from '../notes.js';

const idParams = z.object({ id: z.string() });
const MAX_PHOTOS = 4;

export async function noteRoutes(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: MAX_PHOTOS } });
  app.addHook('preHandler', requireAuth);

  app.get('/api/capture/config', async () => ({ aiEnabled: captureEnabled }));

  /** Sorts text and/or photos into a note, reminder, appointment, recipe or grocery list, or finds a time. Saves nothing. */
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
      const me = request.userId ? await prisma.user.findUnique({ where: { id: request.userId }, select: { name: true } }) : null;
      return await capture(text, photos, now || new Date().toUTCString(), me?.name ?? null);
    } catch (err) {
      if (err instanceof ImportError || err instanceof FetchError) {
        return reply.code(422).send({ error: err.message });
      }
      // Claude outages, overload and rate limits (the SDK has already retried these).
      if (err instanceof Anthropic.APIError && (err.status === undefined || err.status === 429 || err.status >= 500)) {
        request.log.warn({ err }, 'claude unavailable');
        return reply.code(503).send({
          error: "The AI service is having trouble right now. Your text is still here, so try again in a few minutes.",
        });
      }
      throw err;
    }
  });

  app.get('/api/notes', async () => listNotes());

  app.get('/api/notes/groups', async () => listGroups());

  /** Renames a group everywhere; renaming onto an existing group merges them, and "" ungroups. */
  app.post('/api/notes/groups/rename', async (request, reply) => {
    const parsed = z.object({ from: z.string().trim().min(1).max(60), to: z.string().trim().max(60) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Which group, and its new name?' });
    return { renamed: await renameGroup(parsed.data.from, parsed.data.to || null) };
  });

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

  /** Removes past appointments from Mise; their Google Calendar events stay. */
  app.post('/api/notes/forget-past', async (request, reply) => {
    const parsed = z.object({ ids: z.array(z.string()).min(1).max(1000) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Nothing to remove' });
    return { removed: await forgetPastAppointments(parsed.data.ids) };
  });

  /** Free times to move a missed reminder to. `today` is the phone's date. */
  app.post('/api/notes/:id/find-time', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = z.object({ today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Send today’s date' });
    const note = await prisma.note.findUnique({ where: { id }, select: { kind: true, title: true, body: true, startsAt: true, endsAt: true } });
    if (!note || note.kind !== 'REMINDER') return reply.code(404).send({ error: 'Reminder not found' });
    const me = request.userId ? await prisma.user.findUnique({ where: { id: request.userId }, select: { name: true } }) : null;
    try {
      return await findTimeForReminder(note, me?.name ?? null, parsed.data.today);
    } catch (err) {
      if (err instanceof FindTimeError) return reply.code(422).send({ error: err.message });
      if (err instanceof GoogleAuthError || err instanceof GoogleApiError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/api/notes/:id', async (request, reply) => {
    const deleted = await deleteNote(idParams.parse(request.params).id);
    return deleted ? reply.code(204).send() : reply.code(404).send({ error: 'Note not found' });
  });
}
