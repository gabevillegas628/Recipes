import { defineConfig } from 'prisma/config';

try {
  process.loadEnvFile('.env');
} catch {
  // No local .env (e.g. on Railway) — env vars come from the environment.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
