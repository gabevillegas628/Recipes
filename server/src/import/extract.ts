import * as cheerio from 'cheerio';
import { aiEnabled, extractWithAi, pageText } from './ai.js';
import { hasContent, type ImportMethod, type RecipeDraft } from './draft.js';
import { ImportError } from './errors.js';
import { safeFetch } from './safeFetch.js';
import { fromJsonLd, fromMicrodata } from './schemaOrg.js';

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src)$/i;

/** Strips tracking params and fragments so the same recipe matches for duplicate checks. */
export function normalizeUrl(input: string): string {
  const url = new URL(input.trim());
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

export async function extractFromUrl(
  input: string,
): Promise<{ draft: RecipeDraft; method: ImportMethod }> {
  const sourceUrl = normalizeUrl(input);
  const page = await safeFetch(sourceUrl, {
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    maxBytes: 8 * 1024 * 1024,
  });
  if (page.contentType && !/html|xml/i.test(page.contentType)) {
    throw new ImportError("That link isn't a web page.");
  }

  const $ = cheerio.load(page.body.toString('utf8'));
  const ogImage = $('meta[property="og:image"]').attr('content') ?? null;

  let result: { draft: RecipeDraft; method: ImportMethod } | null = null;
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

export async function extractFromText(
  text: string,
  sourceUrl: string | null,
): Promise<{ draft: RecipeDraft; method: ImportMethod }> {
  if (!text.trim()) throw new ImportError('Paste some recipe text first.');
  const draft = await extractWithAi(text, sourceUrl ? normalizeUrl(sourceUrl) : null);
  return { draft, method: 'ai' };
}
