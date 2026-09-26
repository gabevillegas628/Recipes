import fs from 'node:fs';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { loadSession } from './auth.js';
import { env } from './env.js';
import { resumeImportJobs } from './import/worker.js';
import { authRoutes } from './routes/auth.js';
import { importRoutes } from './routes/import.js';
import { recipeRoutes } from './routes/recipes.js';

export async function buildApp() {
  const app = Fastify({ logger: true, trustProxy: true });

  await app.register(cookie, { secret: env.sessionSecret });
  app.decorateRequest('userId', null);
  app.addHook('onRequest', loadSession);

  app.get('/api/health', async () => ({ ok: true }));
  await app.register(authRoutes);
  await app.register(recipeRoutes);
  await app.register(importRoutes);
  app.addHook('onReady', resumeImportJobs);

  // Recipe images from the upload dir (a Railway volume in production).
  fs.mkdirSync(env.uploadDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: env.uploadDir,
    prefix: '/images/',
    decorateReply: false,
    maxAge: '365d',
    immutable: true,
  });

  // The built React app. In dev, Vite serves it and proxies /api here.
  if (fs.existsSync(env.webDist)) {
    await app.register(fastifyStatic, { root: env.webDist, prefix: '/', wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      const isAsset = request.url.startsWith('/api/') || request.url.startsWith('/images/');
      if (request.method === 'GET' && !isAsset) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}
