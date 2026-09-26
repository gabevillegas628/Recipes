import path from 'node:path';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

const isProd = process.env.NODE_ENV === 'production';

export const env = {
  isProd,
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
  sessionSecret: required('SESSION_SECRET'),
  /** Where recipe images live. On Railway, point this at the mounted volume. */
  uploadDir: path.resolve(process.env.UPLOAD_DIR ?? '../uploads'),
  /** Built React app, served by this server in production. */
  webDist: path.resolve(process.env.WEB_DIST ?? '../web/dist'),
  /** Optional. Enables AI extraction for pages without structured recipe data and for pasted text. */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
  /** Public base URL for links (connector URL, recipe links for Claude). Defaults to the request's host. */
  publicUrl: process.env.PUBLIC_URL?.replace(/\/$/, '') || null,
};
