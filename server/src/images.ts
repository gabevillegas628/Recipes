import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { env } from './env.js';
import { safeFetch } from './import/safeFetch.js';

/**
 * Recipe images live in UPLOAD_DIR as <id>.webp (up to 1200px) plus
 * <id>-thumb.webp (square, for the list). Recipe.image stores "<id>.webp".
 */

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export const thumbName = (image: string) => image.replace(/\.webp$/, '-thumb.webp');

export async function saveImage(buffer: Buffer): Promise<string> {
  const name = `${randomUUID()}.webp`;
  const base = sharp(buffer, { failOn: 'none' }).rotate();
  await Promise.all([
    base
      .clone()
      .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(path.join(env.uploadDir, name)),
    base
      .clone()
      .resize({ width: 240, height: 240, fit: 'cover' })
      .webp({ quality: 75 })
      .toFile(path.join(env.uploadDir, thumbName(name))),
  ]);
  return name;
}

export async function saveImageFromUrl(url: string): Promise<string> {
  const res = await safeFetch(url, {
    accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
    maxBytes: MAX_IMAGE_BYTES,
  });
  if (res.contentType && !/^image\/|octet-stream/i.test(res.contentType)) {
    throw new Error(`Not an image (${res.contentType})`);
  }
  return saveImage(res.body);
}

/** Whether an uploaded image name refers to a file we stored. */
export async function uploadExists(image: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}\.webp$/.test(image)) return null;
  return fs
    .access(path.join(env.uploadDir, image))
    .then(() => image)
    .catch(() => null);
}

export async function deleteImage(image: string | null | undefined) {
  if (!image || image.includes('/') || image.includes('\\')) return;
  await Promise.all(
    [image, thumbName(image)].map((f) => fs.rm(path.join(env.uploadDir, f), { force: true })),
  );
}
