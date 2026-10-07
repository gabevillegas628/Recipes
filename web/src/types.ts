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

export type ImportMethod = 'jsonld' | 'microdata' | 'ai' | 'generated';

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
  /** Notes only: the group it's filed under ("Medical"), or null. */
  group: string | null;
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
  group: string | null;
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
  group: string | null;
  recurrence: string | null;
  uploadedImage: string | null;
}

export type CaptureResult =
  | { kind: 'note'; note: NoteDraft; slot?: TaskSlot }
  | { kind: 'recipe'; recipe: ImportResult }
  | { kind: 'groceries'; items: string[] }
  | { kind: 'findTime'; find: FindTimeResult };

/** The family calendar for Today, from the start of today on. */
export interface TodayCalendar {
  connected: boolean;
  error: string | null;
  calendarName: string | null;
  events: {
    title: string;
    /** Timed events; all-day ones have allDayDate and allDayEnd (exclusive) instead. */
    start: string | null;
    end: string | null;
    allDayDate: string | null;
    allDayEnd: string | null;
    location: string | null;
    /** Marked "free" in Google Calendar: it doesn't take anyone's time. */
    free: boolean;
    /** Set when it's an appointment saved in this app. */
    noteId: string | null;
    /** Whose it is, read from its title (Today only; null before the household is set up). */
    owner?: EventOwner | null;
  }[];
  /** The household, for naming owners (Today only). */
  people?: { id: string; name: string; adult: boolean }[];
  /** The household person who's looking, or null if their name isn't in the household. */
  me?: string | null;
  /** The hours Today counts free time in, "07:00" to "21:00" (Today only). */
  day?: { start: string; end: string } | null;
}

/** Whose a calendar event is. No people and not everyone or unsure: it takes no one's time. */
export interface EventOwner {
  people: string[];
  everyone: boolean;
  /** Couldn't be told from the title; counts as everyone's. */
  unsure: boolean;
}

/** Search across Mise and the family calendar's history. */
export interface SearchResult {
  notes: Note[];
  /** Calendar events Mise doesn't already have (see TodayCalendar). */
  calendar: TodayCalendar['events'];
  calendarError: string | null;
  calendarConnected: boolean;
}

export interface HouseholdPerson {
  /** Missing for someone just added in Settings. */
  id?: string;
  name: string;
  aliases: string[];
  adult: boolean;
}

export interface Household {
  people: (HouseholdPerson & { id: string })[];
  /** "07:20"; null for no school. */
  schoolStart: string | null;
  schoolEnd: string | null;
  travelMinutes: number;
  hoursStart: string;
  hoursEnd: string;
  /** The hours of the day Today counts free time in. */
  dayStart: string;
  dayEnd: string;
}

/** A "find a time" request as Capture read it; sent back as-is to search again. */
export interface FindTimeInput {
  title: string;
  location: string | null;
  details: string | null;
  people: string[];
  from: string;
  to: string;
  durationMinutes: number;
  hoursStart: string | null;
  hoursEnd: string | null;
  days: string[] | null;
  /** Each way; null for the household's usual. */
  travelMinutes?: number | null;
}

/** How the app picked a task's time, for the check screen. */
export interface TaskSlot {
  /** What was looked at, or why nothing could be. */
  summary: string;
  /** The search, for "Pick another time"; null when it couldn't run. */
  input: FindTimeInput | null;
  notes: string[];
  /** With a deadline: when it's due and why this time ("By Mon, Mar 15, 2027. Contractors book up…"). */
  why: string | null;
  /** The booked time's day, for the timeline, and who's who in it. */
  day: { view: FindTimeDayView; people: FindTimeResult['people'] } | null;
}

export interface FindTimeOption {
  day: string;
  window: string;
  reasons: string[];
  missesSchool: boolean;
  /** The appointment it becomes. */
  draft: { date: string; time: string; endTime: string; body: string | null };
  dayView: FindTimeDayView;
}

/** An option's day, for the timeline. Times are minutes since midnight. */
export interface FindTimeDayView {
  /** The hours to draw. */
  from: number;
  to: number;
  /** Timed events that day. No people and not everyone: it takes no one's time. */
  events: { title: string; start: number; end: number; everyone: boolean; people: string[] }[];
  allDay: string[];
  /** Travel there, the visit, travel back, at the earliest start; lastStart is the latest start that works. */
  trip: { start: number; visitStart: number; visitEnd: number; end: number; lastStart: number };
  school: { start: number; end: number } | null;
}

/** Whose an event is, by its title. No people and not everyone (and not unsure): it takes no one's time. */
export interface EventTagInfo {
  title: string;
  people: string[];
  everyone: boolean;
  unsure: boolean;
  byHand: boolean;
}

export interface FindTimeResult {
  input: FindTimeInput;
  summary: string;
  /** Each way, as used. */
  travelMinutes: number;
  options: FindTimeOption[];
  notes: string[];
  calendar: EventTagInfo[];
  people: { id: string; name: string; adult: boolean }[];
}

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

/** A place Today's weather is for (Settings → Weather). */
export interface WeatherPlace {
  name: string;
  lat: number;
  lon: number;
}

export interface Weather {
  place: string;
  high: number;
  low: number;
  /** Only when rain or snow is likely during the rest of the day. */
  wet: { kind: 'rain' | 'snow'; chance: number; when: string } | null;
}

/** A recipe Claude wrote for a plan; saved only when the plan is added to the week. */
export interface PlanDraft {
  key: string;
  title: string;
  description: string;
  servings: string;
  prepMinutes: number;
  cookMinutes: number;
  ingredients: string[];
  steps: string[];
  items: { line: number; name: string; amount: number | null; unit: string | null; kind: 'staple' | 'keeps' | 'perishable' | 'meat' }[];
  /** Saved recipes that are essentially this one. */
  similarTo: { id: string; title: string }[];
}

/** Recipes planned together because they share ingredients (see server/src/weekPlanner.ts). */
export interface PlanSuggestion {
  recipes: {
    /** Recipe id, or a draft's key. */
    key: string;
    id: string | null;
    title: string;
    image: string | null;
    totalMinutes: number | null;
    /** Ingredients it shares with the others. */
    shares: string[];
    draft: PlanDraft | null;
  }[];
  shared: {
    name: string;
    kind: 'staple' | 'keeps' | 'perishable' | 'meat';
    uses: { key: string; title: string; line: string }[];
    /** All of it together, when the amounts add up. */
    total: string | null;
  }[];
  /** Different things to buy, staples aside. */
  toBuy: number;
}
