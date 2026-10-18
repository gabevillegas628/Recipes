import { z } from 'zod';
import { normalizeCategories } from './categoryList.js';

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
  /** A photo already uploaded via POST /api/images; takes precedence over imageUrl. */
  uploadedImage: z
    .string()
    .regex(/^[0-9a-f-]{36}\.webp$/, 'Invalid uploaded image')
    .optional(),
  /** Categories (categoryList.ts), in any case; anything else is dropped. None and Claude sorts it after saving. */
  tags: z.array(z.string()).default([]).transform(normalizeCategories),
});

export type RecipeInput = z.infer<typeof recipeInput>;
