import { createHash, randomBytes } from 'node:crypto';
import { prisma } from './db.js';

/**
 * The Claude connector's secret URL token. One active token at a time: generating a
 * new one revokes the old. Only the hash is stored, so the URL is shown once.
 */

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

// Don't write lastUsedAt on every tool call; once a minute is plenty.
const LAST_USED_RESOLUTION_MS = 60_000;

export async function connectorStatus() {
  const token = await prisma.connectorToken.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, lastUsedAt: true },
  });
  return token ? { enabled: true as const, ...token } : { enabled: false as const };
}

/** Replaces any existing token and returns the new one (the only time it's available). */
export async function generateConnectorToken(userId: string | null): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await prisma.$transaction([
    prisma.connectorToken.deleteMany({}),
    prisma.connectorToken.create({ data: { tokenHash: hash(token), createdById: userId } }),
  ]);
  return token;
}

export async function revokeConnectorTokens() {
  await prisma.connectorToken.deleteMany({});
}

export async function verifyConnectorToken(token: string): Promise<boolean> {
  if (!token || token.length > 200) return false;
  const found = await prisma.connectorToken.findUnique({
    where: { tokenHash: hash(token) },
    select: { id: true, lastUsedAt: true },
  });
  if (!found) return false;
  if (!found.lastUsedAt || Date.now() - found.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    await prisma.connectorToken.update({ where: { id: found.id }, data: { lastUsedAt: new Date() } });
  }
  return true;
}
