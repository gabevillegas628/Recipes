import { buildApp } from './app.js';
import { env } from './env.js';
import { scheduleSort } from './groceries.js';

const app = await buildApp();
await app.listen({ port: env.port, host: '0.0.0.0' });
// Pick up any items left unsorted by a restart or an earlier AI failure.
scheduleSort();
