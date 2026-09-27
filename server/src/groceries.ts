import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { env } from './env.js';

/**
 * Sorts grocery lines into store sections and trims recipe prep notes
 * ("1 onion, diced" -> "1 onion"). Falls back to the original text, unsorted,
 * when AI isn't configured or the call fails; the list still works.
 */

export const AISLES = [
  'Produce',
  'Meat & Seafood',
  'Dairy & Eggs',
  'Bakery',
  'Pantry',
  'Spices & Baking',
  'Canned & Jarred',
  'Frozen',
  'Drinks',
  'Household',
  'Other',
] as const;

const client = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null;

const result = z.object({
  items: z.array(
    z.object({
      index: z.number().int(),
      aisle: z.enum(AISLES),
      item: z.string().describe('The line as a shopping list entry: keep quantity and ingredient, drop prep like "diced" or "at room temperature"'),
    }),
  ),
});

export interface SortedItem {
  text: string;
  aisle: string | null;
}

export async function sortGroceries(lines: string[]): Promise<SortedItem[]> {
  const fallback = lines.map((text) => ({ text, aisle: null }));
  if (!client || lines.length === 0) return fallback;

  try {
    const response = await client.messages.parse({
      model: env.anthropicModel,
      max_tokens: 8000,
      output_config: { effort: 'low', format: zodOutputFormat(result) },
      system:
        'You organize a household grocery list. For each numbered line, choose the store section and rewrite it as a short shopping entry. Keep quantities and the ingredient; drop preparation instructions. Never merge or drop lines.',
      messages: [{ role: 'user', content: lines.map((l, i) => `${i}. ${l}`).join('\n') }],
    });
    const parsed = response.parsed_output;
    console.info(
      JSON.stringify({
        msg: 'ai grocery sort',
        model: response.model,
        lines: lines.length,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }),
    );
    if (!parsed) return fallback;

    const byIndex = new Map(parsed.items.map((i) => [i.index, i]));
    return lines.map((text, i) => {
      const sorted = byIndex.get(i);
      return { text: sorted?.item.trim() || text, aisle: sorted?.aisle ?? null };
    });
  } catch (err) {
    console.warn('Grocery sorting failed:', (err as Error).message);
    return fallback;
  }
}
