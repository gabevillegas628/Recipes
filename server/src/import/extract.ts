import * as cheerio from 'cheerio';
import sharp from 'sharp';
import { saveImage } from '../images.js';
import { aiEnabled, extractWithAi, pageText } from './ai.js';
import { hasContent, type ImportMethod, type RecipeDraft } from './draft.js';
import { ImportError, NoRecipeFoundError } from './errors.js';
import {
  canonicalInstagramUrl,
  fetchInstagramPost,
  instagramShortcode,
  recipeLinksIn,
} from './instagram.js';
import { safeFetch } from './safeFetch.js';
import { fromJsonLd, fromMicrodata } from './schemaOrg.js';

type Extracted = { draft: RecipeDraft; method: ImportMethod };

const TRACKING_PARAMS =
  /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igsh|igshid|stkn|ig_rid|si)$/i;

/** Hosts that wrap outbound links, e.g. l.facebook.com/l.php?u=<real url> from Messenger. */
const REDIRECT_WRAPPERS: Record<string, string> = {
  'l.facebook.com': 'u',
  'lm.facebook.com': 'u',
  'l.messenger.com': 'u',
  'l.instagram.com': 'u',
  'www.google.com': 'q',
};

function unwrap(url: URL): URL {
  for (let i = 0; i < 3; i++) {
    const param = REDIRECT_WRAPPERS[url.hostname.toLowerCase()];
    const inner = param && url.searchParams.get(param);
    if (!inner || !/^https?:\/\//i.test(inner)) break;
    url = new URL(inner);
  }
  return url;
}

/**
 * Unwraps redirect links, strips tracking params and fragments, and canonicalizes
 * Instagram posts, so the same recipe matches for duplicate checks.
 */
export function normalizeUrl(input: string): string {
  const url = unwrap(new URL(input.trim()));
  const igCode = instagramShortcode(url);
  if (igCode) return canonicalInstagramUrl(igCode);

  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

export async function extractFromUrl(input: string): Promise<Extracted> {
  const sourceUrl = normalizeUrl(input);
  const igCode = instagramShortcode(new URL(sourceUrl));
  if (igCode) return extractFromInstagram(igCode);
  return extractFromWebPage(sourceUrl);
}

async function extractFromWebPage(sourceUrl: string): Promise<Extracted> {
  const page = await safeFetch(sourceUrl, {
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    maxBytes: 8 * 1024 * 1024,
  });
  if (page.contentType && !/html|xml/i.test(page.contentType)) {
    throw new ImportError("That link isn't a web page.");
  }

  const $ = cheerio.load(page.body.toString('utf8'));
  const ogImage = $('meta[property="og:image"]').attr('content') ?? null;

  let result: Extracted | null = null;
  const jsonLd = fromJsonLd($, sourceUrl);
  if (jsonLd && hasContent(jsonLd)) {
    result = { draft: jsonLd, method: 'jsonld' };
  } else {
    const micro = fromMicrodata($, sourceUrl);
    if (micro && hasContent(micro)) result = { draft: micro, method: 'microdata' };
  }

  if (!result) {
    if (!aiEnabled) {
      throw new ImportError(
        "Couldn't find recipe data on this page. Try pasting the recipe text instead.",
      );
    }
    const draft = await extractWithAi(pageText($), sourceUrl);
    result = { draft, method: 'ai' };
  }

  if (!result.draft.imageUrl && ogImage) {
    try {
      result.draft.imageUrl = new URL(ogImage, page.url).toString();
    } catch {
      // Ignore a malformed og:image.
    }
  }
  return result;
}

const NOT_IN_CAPTION =
  "This post's caption doesn't include the recipe. Creators often put it in the comments, on their website, or send it by DM. If you can get the text, use Paste text.";

/**
 * 1. Links in the caption (a blog post) usually have the complete recipe: try those first.
 * 2. Otherwise have AI read the recipe out of the caption itself.
 */
async function extractFromInstagram(code: string): Promise<Extracted> {
  const post = await fetchInstagramPost(code).catch(() => null);
  if (!post) {
    throw new ImportError("Couldn't read this Instagram post. It may be private or deleted.");
  }

  for (const link of recipeLinksIn(post.caption)) {
    try {
      const result = await extractFromWebPage(normalizeUrl(link));
      result.draft.imageUrl ??= post.imageUrl;
      return result;
    } catch {
      // Not a recipe page; fall back to the caption.
    }
  }

  if (!post.caption) throw new ImportError(NOT_IN_CAPTION);
  if (!aiEnabled) {
    throw new ImportError(
      'Reading recipes from Instagram captions needs AI extraction, which isn’t set up (ANTHROPIC_API_KEY).',
    );
  }

  const sourceUrl = canonicalInstagramUrl(code);
  const context = `Instagram post${post.author ? ` by @${post.author}` : ''}. Caption:\n\n${post.caption}`;
  try {
    const draft = await extractWithAi(context, sourceUrl);
    draft.imageUrl = post.imageUrl;
    return { draft, method: 'ai' };
  } catch (err) {
    if (err instanceof NoRecipeFoundError) throw new ImportError(NOT_IN_CAPTION);
    throw err;
  }
}

/**
 * Photos of a recipe card, cookbook page or packaging. Each is resized for Claude
 * (long edge 1568px, which is what it reads at anyway); the first becomes the
 * recipe's picture.
 */
export async function extractFromPhotos(
  photos: Buffer[],
): Promise<Extracted & { uploadedImage: string | null }> {
  if (!aiEnabled) {
    throw new ImportError('Reading photos needs AI extraction, which isn’t set up (ANTHROPIC_API_KEY).');
  }
  let prepared: Buffer[];
  try {
    prepared = await Promise.all(
      photos.map((p) =>
        sharp(p, { failOn: 'none' })
          .rotate()
          .resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer(),
      ),
    );
  } catch {
    throw new ImportError("Couldn't read that photo. Try a JPEG or PNG.");
  }

  const [draft, uploadedImage] = await Promise.all([
    extractWithAi('', null, prepared).catch((err) => {
      if (err instanceof NoRecipeFoundError) {
        throw new ImportError("Couldn't find a recipe or cooking instructions in that photo. Try a closer, sharper shot.");
      }
      throw err;
    }),
    saveImage(photos[0]).catch(() => null),
  ]);
  return { draft, method: 'ai', uploadedImage };
}

export async function extractFromText(text: string, sourceUrl: string | null): Promise<Extracted> {
  if (!text.trim()) throw new ImportError('Paste some recipe text first.');
  const draft = await extractWithAi(text, sourceUrl ? normalizeUrl(sourceUrl) : null);
  return { draft, method: 'ai' };
}
