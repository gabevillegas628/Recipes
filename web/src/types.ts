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
  needsReview: boolean;
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

export type RecipeInput = Omit<Recipe, 'id' | 'image' | 'needsReview' | 'createdAt' | 'updatedAt'> & {
  /** Omit to keep the current image, a URL to download a new one, or null to remove it. */
  imageUrl?: string | null;
  /** A photo already uploaded with api.uploadImage. */
  uploadedImage?: string;
};

/** A recipe extracted from a link or pasted text, not yet saved. */
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
  /** A photo already stored on the server (from a photo import). */
  uploadedImage?: string | null;
}

export type ImportMethod = 'jsonld' | 'microdata' | 'ai';

export interface ImportResult {
  draft: RecipeDraft;
  method: ImportMethod;
  duplicateOf: { id: string; title: string } | null;
  uploadedImage?: string | null;
}

export type ImportStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'DUPLICATE' | 'FAILED';

export interface ImportJob {
  id: string;
  url: string;
  status: ImportStatus;
  method: ImportMethod | null;
  error: string | null;
  recipe: { id: string; title: string } | null;
  createdAt: string;
}

export interface PlanItem {
  id: string;
  scale: number;
  createdAt: string;
  cookedAt: string | null;
  addedBy: { name: string } | null;
  meal: { id: string; name: string } | null;
  recipe: PlannedRecipe;
}

/** The recipe fields needed to plan, scale and shop for a recipe. */
export interface PlannedRecipe {
  id: string;
  title: string;
  image: string | null;
  servings: string | null;
  totalMinutes: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  ingredients: Section[];
}

export interface MealSummary {
  id: string;
  name: string;
  notes: string | null;
  servings: number | null;
  updatedAt: string;
  recipeCount: number;
  recipeTitles: string[];
  images: string[];
}

export interface Meal {
  id: string;
  name: string;
  notes: string | null;
  servings: number | null;
  recipes: { scale: number; recipe: PlannedRecipe }[];
}

export interface MealInput {
  name: string;
  notes: string | null;
  servings: number | null;
  recipes: { recipeId: string; scale: number }[];
}

export interface GroceryItem {
  id: string;
  text: string;
  aisle: string | null;
  checked: boolean;
  createdAt: string;
  recipe: { id: string; title: string } | null;
}

export type ConnectorStatus =
  | { enabled: false }
  | { enabled: true; createdAt: string; lastUsedAt: string | null };

export interface User {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
  createdAt?: string;
}

export interface TagCount {
  name: string;
  count: number;
}
