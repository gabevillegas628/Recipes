import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { Section } from '../recipeInput.js';
import type { RecipeDraft } from './draft.js';

/**
 * Reads schema.org Recipe data, which most recipe sites embed for Google:
 * JSON-LD first, then microdata. Both are normalized through fromSchemaRecipe().
 */

type Json = unknown;
type JsonObject = Record<string, Json>;

const isObject = (v: Json): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v: Json): Json[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function isRecipe(node: JsonObject) {
  return asArray(node['@type']).some((t) => typeof t === 'string' && t.toLowerCase() === 'recipe');
}

/** Depth-first search for a Recipe node through arrays, @graph and nested objects. */
function findRecipeNode(node: Json, depth = 0): JsonObject | null {
  if (depth > 8) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipeNode(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isObject(node)) return null;
  if (isRecipe(node)) return node;
  for (const value of Object.values(node)) {
    if (typeof value === 'object') {
      const found = findRecipeNode(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * JSON-LD flattens ingredient groups ("For the sauce") into one list. WP Recipe Maker,
 * the most common recipe plugin, keeps them in its HTML, so recover them from there.
 */
export function ingredientGroupsFromHtml($: CheerioAPI): Section[] | null {
  // Scope to the first recipe card; some posts embed several.
  const card = $('.wprm-recipe-container').first();
  const groups = (
    card.length ? card.find('.wprm-recipe-ingredient-group') : $('.wprm-recipe-ingredient-group')
  ).toArray();
  if (groups.length < 2) return null;

  const sections = groups
    .map((group) => {
      const $group = $(group);
      $group.find('.wprm-checkbox-container').remove();
      return {
        title: nullIfEmpty(cleanText($group.find('.wprm-recipe-group-name').first().text())),
        items: $group
          .find('.wprm-recipe-ingredient')
          .toArray()
          .map((li) => cleanText($(li).text()))
          .filter(Boolean),
      };
    })
    .filter((s) => s.items.length > 0);
  return sections.length > 1 ? sections : null;
}

export function fromJsonLd($: CheerioAPI, pageUrl: string): RecipeDraft | null {
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    const raw = $(el).text().trim();
    if (!raw) continue;
    let data: Json;
    try {
      data = JSON.parse(raw);
    } catch {
      try {
        // Some sites put raw newlines/tabs inside JSON strings.
        data = JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' '));
      } catch {
        continue;
      }
    }
    const recipe = findRecipeNode(data);
    if (recipe) {
      const draft = fromSchemaRecipe(recipe, pageUrl);
      const groups = ingredientGroupsFromHtml($);
      // Only trust the HTML groups if they account for the same ingredients.
      const flatCount = draft.ingredients.reduce((n, s) => n + s.items.length, 0);
      if (groups && groups.reduce((n, s) => n + s.items.length, 0) === flatCount) {
        draft.ingredients = groups;
      }
      return draft;
    }
  }
  return null;
}

export function fromMicrodata($: CheerioAPI, pageUrl: string): RecipeDraft | null {
  const scope = $('[itemscope][itemtype*="schema.org/Recipe" i]').first();
  if (!scope.length) return null;

  const values = (prop: string) =>
    scope
      .find(`[itemprop~="${prop}"]`)
      .toArray()
      .map((el) => {
        const $el = $(el);
        return (
          $el.attr('content') ??
          $el.attr('datetime') ??
          (el.tagName === 'img' ? $el.attr('src') : undefined) ??
          (el.tagName === 'meta' ? '' : $el.text())
        );
      })
      .filter((v): v is string => Boolean(v && v.trim()));

  const first = (prop: string) => values(prop)[0];

  return fromSchemaRecipe(
    {
      name: first('name'),
      description: first('description'),
      image: first('image'),
      recipeYield: first('recipeYield') ?? first('yield'),
      prepTime: first('prepTime'),
      cookTime: first('cookTime'),
      totalTime: first('totalTime'),
      recipeIngredient: values('recipeIngredient').length
        ? values('recipeIngredient')
        : values('ingredients'),
      recipeInstructions: values('recipeInstructions'),
      recipeCategory: values('recipeCategory'),
      recipeCuisine: values('recipeCuisine'),
    },
    pageUrl,
  );
}

// ---------- Normalization ----------

/** Decodes HTML entities, strips tags and collapses whitespace. */
export function cleanText(value: Json): string {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return '';
  const text = /[<&]/.test(value) ? cheerio.load(value, null, false).text() : value;
  return text.replace(/\s+/g, ' ').trim();
}

const nullIfEmpty = (s: string) => s || null;

/** ISO 8601 durations ("PT1H30M", "P0DT0H20M") or loose text ("1 hour 30 mins") to minutes. */
export function parseDuration(value: Json): number | null {
  const text = cleanText(value);
  if (!text) return null;

  const iso = text.match(
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i,
  );
  let minutes: number;
  if (iso) {
    const [, d, h, m, s] = iso.map((x) => Number(x ?? 0));
    minutes = d * 1440 + h * 60 + m + s / 60;
  } else {
    const h = text.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i);
    const m = text.match(/(\d+)\s*(?:m|min|mins|minute|minutes)\b/i);
    if (!h && !m) return null;
    minutes = Number(h?.[1] ?? 0) * 60 + Number(m?.[1] ?? 0);
  }
  const rounded = Math.round(minutes);
  return rounded > 0 ? rounded : null;
}

function pickImage(value: Json): string | null {
  for (const item of asArray(value)) {
    if (typeof item === 'string' && item.trim()) return item.trim();
    if (isObject(item)) {
      const url = item.url ?? item.contentUrl ?? item['@id'];
      if (typeof url === 'string' && url.trim()) return url.trim();
    }
  }
  return null;
}

function pickYield(value: Json): string | null {
  // Often ["4", "4 servings"]; the longest entry is usually the most descriptive.
  const options = asArray(value).map(cleanText).filter(Boolean);
  return options.sort((a, b) => b.length - a.length)[0] ?? null;
}

function stepText(node: Json): string {
  if (isObject(node)) return cleanText(node.text ?? node.name ?? '');
  return cleanText(node);
}

/** Handles a plain string, a list of strings, HowToStep objects and HowToSection groups. */
function parseInstructions(value: Json): Section[] {
  const sections: Section[] = [];
  const loose: string[] = [];

  const flushLoose = () => {
    if (loose.length) sections.push({ title: null, items: loose.splice(0) });
  };

  const addSteps = (text: string, into: string[]) => {
    // A single blob of text: split on line breaks / numbered steps.
    const parts = text.includes('\n') ? text.split(/\n+/) : [text];
    into.push(...parts.map((p) => p.replace(/^\s*\d+[.)]\s+/, '').trim()).filter(Boolean));
  };

  for (const item of asArray(value)) {
    if (typeof item === 'string') {
      // Keep line breaks from HTML-ish blobs so they can be split into steps.
      const withBreaks = item.replace(/<\s*(br|\/p|\/li)\s*\/?>/gi, '\n');
      addSteps(withBreaks.split('\n').map(cleanText).join('\n'), loose);
    } else if (isObject(item) && asArray(item['@type']).includes('HowToSection')) {
      flushLoose();
      const items = asArray(item.itemListElement).map(stepText).filter(Boolean);
      if (items.length) sections.push({ title: nullIfEmpty(cleanText(item.name)), items });
    } else {
      const text = stepText(item);
      if (text) loose.push(text);
    }
  }
  flushLoose();
  return sections;
}

function parseIngredients(value: Json): Section[] {
  const items = asArray(value).map(cleanText).filter(Boolean);
  return items.length ? [{ title: null, items }] : [];
}

function parseTags(recipe: JsonObject): string[] {
  const tags = [...asArray(recipe.recipeCategory), ...asArray(recipe.recipeCuisine)]
    .flatMap((t) => cleanText(t).split(','))
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t && t.length <= 30);
  return [...new Set(tags)].slice(0, 6);
}

export function fromSchemaRecipe(recipe: JsonObject, pageUrl: string): RecipeDraft {
  const image = pickImage(recipe.image) ?? pickImage(recipe.thumbnailUrl);
  let imageUrl: string | null = null;
  if (image) {
    try {
      imageUrl = new URL(image, pageUrl).toString();
    } catch {
      imageUrl = null;
    }
  }

  const prepMinutes = parseDuration(recipe.prepTime);
  const cookMinutes = parseDuration(recipe.cookTime);

  return {
    title: cleanText(recipe.name ?? recipe.headline),
    description: nullIfEmpty(cleanText(recipe.description)),
    sourceUrl: pageUrl,
    imageUrl,
    servings: pickYield(recipe.recipeYield ?? recipe.yield),
    prepMinutes,
    cookMinutes,
    totalMinutes: parseDuration(recipe.totalTime),
    ingredients: parseIngredients(recipe.recipeIngredient ?? recipe.ingredients),
    instructions: parseInstructions(recipe.recipeInstructions),
    notes: null,
    tags: parseTags(recipe),
  };
}
