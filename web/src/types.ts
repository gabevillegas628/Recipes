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

/** Mise en place. Numbers index the recipe's ingredient lines and steps, counted across sections. */
export interface PrepPlan {
  tasks: { text: string; ingredients: number[] }[];
  bowls: { step: number; label: string; items: { ingredient: number; note: string | null }[] }[];
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

/** Lines for the same item ("2 lb carrots", "3 carrots"), shown and ticked as one row. */
export interface GroceryGroup {
  key: string;
  /** The shared item name ("carrots"). */
  name: string;
  aisle: string | null;
  checked: boolean;
  /** One amount to buy across the lines, once estimated. */
  buy: string | null;
  items: GroceryItem[];
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

export type NoteKind = 'NOTE' | 'REMINDER' | 'APPOINTMENT';

/** A note, reminder or appointment. All-day times sit at 12:00 UTC on their date. */
export interface Note {
  id: string;
  kind: NoteKind;
  title: string;
  body: string | null;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  location: string | null;
  /** An RRULE when it repeats; startsAt is the first occurrence. */
  recurrence: string | null;
  image: string | null;
  /** For a repeating reminder: when the latest occurrence was ticked off. */
  doneAt: string | null;
  googleEventId: string | null;
  syncPending: boolean;
  syncError: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: { name: string } | null;
}

export interface NoteInput {
  kind: NoteKind;
  title: string;
  body: string | null;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  location: string | null;
  recurrence: string | null;
}

/** What capture read out of the input: local dates and times, not yet saved. */
export interface NoteDraft {
  kind: NoteKind;
  title: string;
  body: string | null;
  date: string | null;
  time: string | null;
  endDate: string | null;
  endTime: string | null;
  location: string | null;
  recurrence: string | null;
  uploadedImage: string | null;
}

export type CaptureResult =
  | { kind: 'note'; note: NoteDraft }
  | { kind: 'recipe'; recipe: ImportResult }
  | { kind: 'groceries'; items: string[] };

export interface GoogleStatus {
  /** GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set on the server. */
  configured: boolean;
  connected: boolean;
  email: string | null;
  calendarId: string | null;
  calendarName: string | null;
  /** Where reminders go; null means with appointments. */
  remindersCalendarId: string | null;
  remindersCalendarName: string | null;
  /** Google event colorId "1"-"11", or null for the calendar's own color. */
  remindersColor: string | null;
  /** The connection stopped working and needs reconnecting. */
  error: string | null;
  connectedBy: string | null;
  pending: number;
  failed: number;
}

export interface GoogleCalendarChoice {
  id: string;
  name: string;
  primary: boolean;
}
