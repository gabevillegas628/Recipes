import { prisma } from '../db.js';
import { sealer } from '../secrets.js';
import { claim } from './simplefin.js';

/** The one SimpleFIN connection (Settings → Money). Its access URL is stored encrypted. */

const { encrypt, decrypt } = sealer('simplefin-access-url');

export const connectionSecret = decrypt;

/** Claims a setup token and saves the access URL, replacing any earlier connection. Accounts and history stay. */
export async function connect(setupToken: string, userId: string | null) {
  const accessUrl = encrypt(await claim(setupToken));
  const data = { accessUrl, error: null, warnings: [], connectedById: userId };
  await prisma.financeConnection.upsert({ where: { id: 'default' }, create: { id: 'default', ...data }, update: data });
}

/** Forgets the access URL. Accounts and transactions already copied stay. */
export async function disconnect() {
  await prisma.financeConnection.deleteMany({ where: { id: 'default' } });
}

/** The family calendar's time zone, which decides what day a balance or an imported row belongs to. */
export async function homeTimeZone(): Promise<string> {
  const google = await prisma.googleConnection.findUnique({ where: { id: 'default' }, select: { timeZone: true } });
  return google?.timeZone ?? 'America/New_York';
}
