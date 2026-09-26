import type { Section } from '../recipeInput.js';

/** A recipe extracted from a page or text, not yet saved. Mirrors recipeInput plus an image URL. */
export interface RecipeDraft {
  title: string;
  description: string | null;
  sourceUrl: string | null;
  imageUrl: string | null;
  servings: string | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
  ingredients: Section[];
  instructions: Section[];
  notes: string | null;
  tags: string[];
}

export type ImportMethod = 'jsonld' | 'microdata' | 'ai';

export function hasContent(draft: RecipeDraft) {
  const count = (sections: Section[]) => sections.reduce((n, s) => n + s.items.length, 0);
  return Boolean(draft.title) && (count(draft.ingredients) > 0 || count(draft.instructions) > 0);
}
