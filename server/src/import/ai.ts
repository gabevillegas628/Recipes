import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { CheerioAPI } from 'cheerio';
import { z } from 'zod';
import { env } from '../env.js';
import type { RecipeDraft } from './draft.js';
import { ImportError, NoRecipeFoundError } from './errors.js';

/**
 * Fallback for pages without structured recipe data, and for pasted text:
 * ask Claude to pull the recipe out into our schema.
 */

const client = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null;

export const aiEnabled = client !== null;

const section = z.object({
  title: z.string().nullable().describe('Section heading like "For the sauce", or null'),
  items: z.array(z.string()),
});

const extraction = z.object({
  found: z
    .boolean()
    .describe(
      'true if the input gives ingredients or steps for a dish, even informally (a social media caption, or cooking instructions printed on packaging); false if it only mentions or describes food',
    ),
  title: z.string(),
  description: z.string().nullable().describe('One or two sentences, or null'),
  servings: z.string().nullable(),
  prepMinutes: z.number().int().nullable(),
  cookMinutes: z.number().int().nullable(),
  totalMinutes: z.number().int().nullable(),
  ingredients: z.array(section),
  instructions: z.array(section),
  notes: z.string().nullable().describe('Tips, substitutions or storage notes from the recipe author'),
  tags: z.array(z.string()).describe('2-5 short lowercase tags, e.g. "dinner", "chicken", "vegetarian"'),
});

const SYSTEM = `You extract recipes from web pages, pasted text and photos for a personal recipe box.

Copy ingredient lines and steps faithfully, with their quantities and wording; don't invent or "improve" anything. Leave out life stories, ads, comments, nutrition panels and navigation text. Keep ingredient and step groupings (e.g. "For the dough") as sections, using a null title when there's only one group. Each instruction item should be one step. Use null for anything the text doesn't state.

Photos may show a recipe card, a cookbook page, or food packaging. For packaging (a frozen pizza, a boxed mix), use the product name as the title and the product itself as the ingredient, plus anything the package says to add (water, eggs, oil). When the package gives several methods (oven, microwave, air fryer), make each one an instruction section titled with the method, and keep temperatures and times exactly as printed.`;

/** Readable text from an HTML page, with the obvious non-content removed. */
export function pageText($: CheerioAPI): string {
  $('script, style, noscript, svg, iframe, nav, footer, header, aside, form, [aria-hidden="true"]').remove();
  $('br, p, li, h1, h2, h3, h4, h5, h6, tr, div, section, article').after('\n');
  const root = $('article').first().length ? $('article').first() : $('main').first().length ? $('main').first() : $('body');
  return root
    .text()
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

// Recipe pages bury the recipe under long comment threads; ~100k chars is well past any
// real recipe while keeping the request small.
const MAX_INPUT_CHARS = 100_000;

/** Photos go to Claude as JPEG, already resized (see routes/import.ts). */
export async function extractWithAi(
  text: string,
  sourceUrl: string | null,
  photos: Buffer[] = [],
): Promise<RecipeDraft> {
  if (!client) {
    throw new ImportError(
      "This page doesn't include structured recipe data, and AI extraction isn't set up (no ANTHROPIC_API_KEY).",
    );
  }

  const input = text.slice(0, MAX_INPUT_CHARS);
  const response = await client.beta.messages.parse({
    model: env.anthropicModel,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: zodOutputFormat(extraction) },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          ...photos.map((photo) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: 'image/jpeg' as const,
              data: photo.toString('base64'),
            },
          })),
          {
            type: 'text' as const,
            text: photos.length
              ? `${photos.length === 1 ? 'This photo shows' : 'These photos show'} a recipe or food packaging.${input ? `\n\n${input}` : ''}`
              : `${sourceUrl ? `Source: ${sourceUrl}\n\n` : ''}<page>\n${input}\n</page>`,
          },
        ],
      },
    ],
  });

  console.info(
    JSON.stringify({
      msg: 'ai recipe extraction',
      model: response.model,
      found: response.parsed_output?.found ?? null,
      stopReason: response.stop_reason,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      source: sourceUrl,
      photos: photos.length || undefined,
    }),
  );

  if (response.stop_reason === 'refusal') {
    throw new ImportError('The AI declined to process this page.');
  }
  const result = response.parsed_output;
  if (!result) throw new ImportError("The AI couldn't read a recipe from this page.");
  if (!result.found) throw new NoRecipeFoundError("Couldn't find a recipe on this page.");

  const nonNegative = (n: number | null) => (n != null && n > 0 ? n : null);
  return {
    title: result.title.trim(),
    description: result.description,
    sourceUrl,
    imageUrl: null,
    servings: result.servings,
    prepMinutes: nonNegative(result.prepMinutes),
    cookMinutes: nonNegative(result.cookMinutes),
    totalMinutes: nonNegative(result.totalMinutes),
    ingredients: result.ingredients,
    instructions: result.instructions,
    notes: result.notes,
    tags: result.tags,
  };
}
