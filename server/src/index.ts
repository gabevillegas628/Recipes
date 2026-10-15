import { buildApp } from './app.js';
import { kickCalendarSync } from './calendarSync.js';
import { env } from './env.js';
import { scheduleSort } from './groceries.js';
import { scheduleIndex } from './ingredients.js';
import { classify } from './money/classify.js';
import { recapDue } from './money/recap.js';
import { kickMoneySync, SYNC_EVERY } from './money/sync.js';

const app = await buildApp();
await app.listen({ port: env.port, host: '0.0.0.0' });
// Pick up any items left unsorted by a restart or an earlier AI failure.
scheduleSort();
// Read the ingredients of recipes saved before the index existed, or changed since.
scheduleIndex(30_000);
// Send anything saved while Google was unreachable, now and every few minutes.
kickCalendarSync();
setInterval(kickCalendarSync, 5 * 60 * 1000);
// Sort any transactions left unsorted by a restart or an AI failure.
void classify();
// Bank and card data from SimpleFIN. Restarts (deploys) don't re-sync if the last one was recent.
kickMoneySync(SYNC_EVERY);
setInterval(() => {
  kickMoneySync(SYNC_EVERY);
  // Last month's recap, once it's a few days into the month.
  recapDue().catch((err) => console.error('Money recap check failed:', err));
}, 15 * 60 * 1000);
