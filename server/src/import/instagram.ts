import * as cheerio from 'cheerio';
import { safeFetch } from './safeFetch.js';

/**
 * Instagram posts and reels. Recipes there live in the caption (or behind a link in it),
 * so read the caption from Instagram's public embed page, which works logged out.
 */

const SHORTCODE = /\/(?:p|reels?|tv)\/([A-Za-z0-9_-]{5,})/;

/** The post's shortcode, for instagram.com/p/<code>, /reel/<code>, /<user>/reel/<code>/<slug> etc. */
export function instagramShortcode(url: URL): string | null {
  if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return null;
  return url.pathname.match(SHORTCODE)?.[1] ?? null;
}

export const canonicalInstagramUrl = (code: string) => `https://www.instagram.com/p/${code}/`;

export interface InstagramPost {
  author: string | null;
  caption: string;
  imageUrl: string | null;
}

export async function fetchInstagramPost(code: string): Promise<InstagramPost | null> {
  const page = await safeFetch(`https://www.instagram.com/p/${code}/embed/captioned/`, {
    accept: 'text/html',
    maxBytes: 8 * 1024 * 1024,
  });
  const $ = cheerio.load(page.body.toString('utf8'));

  const caption = $('.Caption').first();
  const author = caption.find('.CaptionUsername').first().text().trim() || null;
  caption.find('.CaptionUsername, .CaptionComments').remove();
  caption.find('br').replaceWith('\n');
  const text = caption
    .text()
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const imageUrl = $('img.EmbeddedMediaImage').attr('src') ?? null;
  if (!text && !imageUrl) return null;
  return { author, caption: text, imageUrl };
}

const IGNORED_LINK_HOSTS =
  /(^|\.)(instagram\.com|facebook\.com|tiktok\.com|youtube\.com|youtu\.be|linktr\.ee|amazon\.com|amzn\.to|ltk\.app|liketoknow\.it|shopmy\.us)$/i;

/** Links in a caption that might be the full recipe (a blog post, not a social or shopping link). */
export function recipeLinksIn(caption: string): string[] {
  const found = caption.match(/\bhttps?:\/\/[^\s)]+|\bwww\.[^\s)]+\.[a-z]{2,}[^\s)]*/gi) ?? [];
  const links: string[] = [];
  for (const raw of found) {
    try {
      const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
      url.pathname = url.pathname.replace(/[.,!]+$/, '');
      if (!IGNORED_LINK_HOSTS.test(url.hostname)) links.push(url.toString());
    } catch {
      // Not a real link.
    }
  }
  return [...new Set(links)].slice(0, 2);
}
