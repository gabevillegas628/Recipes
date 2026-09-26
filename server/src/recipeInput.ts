import { z } from 'zod';

const section = z.object({
  title: z
    .string()
    .trim()
    .nullish()
    .transform((t) => t || null),
  items: z.array(z.string().trim()).transform((items) => items.filter(Boolean)),
});

export type Section = z.infer<typeof section>;

const optionalText = z
  .string()
  .trim()
  .nullish()
  .transform((s) => s || null);

const optionalMinutes = z
  .number()
  .int()
  .nonnegative()
  .nullish()
  .transform((n) => n ?? null);

/** Body for creating/updating a recipe. Shared by the REST API and (later) the MCP tools. */
export const recipeInput = z.object({
  title: z.string().trim().min(1, 'Title is required'),
  description: optionalText,
  source: z.enum(['URL', 'CLAUDE', 'MANUAL']).default('MANUAL'),
  sourceUrl: optionalText,
  servings: optionalText,
  prepMinutes: optionalMinutes,
  cookMinutes: optionalMinutes,
  totalMinutes: optionalMinutes,
  ingredients: z.array(section).default([]),
  instructions: z.array(section).default([]),
  notes: optionalText,
  favorite: z.boolean().default(false),
  /** Omit to keep the current image, a URL to download a new one, or null to remove it. */
  imageUrl: z.url({ protocol: /^https?$/ }).nullable().optional(),
  tags: z
    .array(z.string())
    .default([])
    .transform((tags) => [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))]),
});

export type RecipeInput = z.infer<typeof recipeInput>;
