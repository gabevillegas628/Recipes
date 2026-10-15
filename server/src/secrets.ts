import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from './env.js';

/**
 * Encrypts secrets the app keeps in the database (Google's refresh token,
 * SimpleFIN's access URL) with a key derived from SESSION_SECRET. Each use gets
 * its own key via `purpose`.
 */
export function sealer(purpose: string) {
  const key = createHash('sha256').update(`${env.sessionSecret}:${purpose}`).digest();
  return {
    encrypt(plain: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
    },
    decrypt(stored: string): string {
      const [iv, tag, data] = stored.split('.').map((s) => Buffer.from(s, 'base64url'));
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    },
  };
}
