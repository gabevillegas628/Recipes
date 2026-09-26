export type RecipeSource = 'URL' | 'CLAUDE' | 'MANUAL';

/** A titled group of ingredients or steps. title is null for the default group. */
export interface Section {
  title: string | null;
  items: string[];
}

export interface RecipeSummary {
  id: string;
  title: string;
  image: string | null;
  source: RecipeSource;
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
  favorite: boolean;
  createdAt: string;
  tags: string[];
}

export interface Recipe extends RecipeSummary {
  description: string | null;
  sourceUrl: string | null;
  servings: string | null;
  ingredients: Section[];
  instructions: Section[];
  notes: string | null;
  updatedAt: string;
}

export type RecipeInput = Omit<Recipe, 'id' | 'image' | 'createdAt' | 'updatedAt'>;

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface TagCount {
  name: string;
  count: number;
}
