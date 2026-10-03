import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { prisma } from './db.js';
import type { Prisma } from './generated/prisma/client.js';
import { ImportError } from './import/errors.js';
import { extractFromUrl } from './import/extract.js';
import { FetchError } from './import/safeFetch.js';
import { findDuplicates } from './duplicates.js';
import { draftToInput, findExistingRecipe } from './import/worker.js';
import { ingredientLines, namesInUse, readIngredients, saveIndex } from './ingredients.js';
import { addMealToPlan, createMeal, getMeal, listMeals } from './meals.js';
import { allDayInstant, createNote, deleteNote, listNotes, NOTE_KINDS, NoteError, updateNote } from './notes.js';
import { describeRule, nextOccurrence, parseRule } from './recurrence.js';
import { addGroceries, addToPlan, getGroceries, getPlan } from './plan.js';
import { recipeInput } from './recipeInput.js';
import { createRecipe, searchWhere, serialize, updateRecipe, withTags } from './recipes.js';

/**
 * The MCP server Claude connects to (as a custom connector) to save and look up recipes.
 * Built per request: the transport is stateless.
 */

const section = z.object({
  title: z
    .string()
    .nullish()
    .describe('Group heading such as "For the sauce". Omit when the recipe has a single group.'),
  items: z.array(z.string()).describe('One ingredient line or one step per item'),
});

const recipeFields = {
  title: z.string().describe('Recipe name'),
  description: z.string().nullish().describe('One or two sentences about the dish'),
  servings: z.string().nullish().describe('e.g. "4" or "2 loaves"'),
  prepMinutes: z.number().int().nullish(),
  cookMinutes: z.number().int().nullish(),
  totalMinutes: z.number().int().nullish(),
  ingredients: z
    .array(section)
    .describe('Ingredients with quantities, e.g. "2 cups flour". Use sections for groups.'),
  instructions: z.array(section).describe('Steps in order, one step per item'),
  notes: z
    .string()
    .nullish()
    .describe('Tips, substitutions, variations or context worth keeping with the recipe'),
  tags: z
    .array(z.string())
    .nullish()
    .describe('2-5 short lowercase tags like "dinner", "chicken", "vegetarian", "quick"'),
  imageUrl: z
    .string()
    .nullish()
    .describe(
      'Direct link to a photo of the dish (an image file URL), if one appeared in the conversation. The server downloads and stores it.',
    ),
  sourceUrl: z.string().nullish().describe('Link to the original recipe, if it came from a website'),
};

type Link = (id: string) => string;

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function toolError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/** Recipe shape handed back to Claude: drops internal fields, adds the web link. */
function forClaude(recipe: ReturnType<typeof serialize<Prisma.RecipeGetPayload<{ include: typeof withTags }>>>, link: Link) {
  const { createdById: _c, image, needsReview: _n, ...rest } = recipe;
  return { ...rest, hasPhoto: Boolean(image), url: link(recipe.id) };
}

export function buildMcpServer(baseUrl: string) {
  const link: Link = (id) => `${baseUrl}/r/${id}`;
  const server = new McpServer({ name: 'recipe-box', version: '1.0.0' });

  server.registerTool(
    'save_recipe',
    {
      title: 'Save recipe',
      description:
        "Save a recipe to the user's personal recipe box. Use this when the user asks to save, keep or store a recipe from the conversation. Include the complete ingredient list with quantities and every step; don't summarize. Returns the saved recipe's link. If the box already has essentially the same dish, nothing is saved and the similar recipes are returned instead: tell the user which ones, and ask whether to save this one anyway (call again with saveEvenIfSimilar), update the existing one with update_recipe, or leave it.",
      inputSchema: {
        ...recipeFields,
        saveEvenIfSimilar: z
          .boolean()
          .nullish()
          .describe('Only after the user has seen the similar recipes and still wants this one saved'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ saveEvenIfSimilar, ...args }) => {
      const parsed = recipeInput.safeParse({
        ...args,
        tags: args.tags ?? [],
        imageUrl: args.imageUrl || undefined,
        source: 'CLAUDE',
      });
      if (!parsed.success) return toolError(z.prettifyError(parsed.error));

      // Read the ingredients now: the duplicate check needs them, and the saved recipe keeps them.
      const lines = ingredientLines(parsed.data.ingredients);
      const read = (await readIngredients([lines], await namesInUse()))?.[0] ?? null;
      if (!saveEvenIfSimilar) {
        const similar = (await findDuplicates([{ key: 'new', title: parsed.data.title, lines, items: read?.items ?? [] }])).get('new') ?? [];
        if (similar.length) {
          return text({
            saved: false,
            reason: 'The recipe box already has essentially this dish. Ask the user before saving.',
            similarRecipes: similar.map((r) => ({ ...r, url: link(r.id) })),
          });
        }
      }

      const recipe = await createRecipe(parsed.data, { userId: null });
      if (read) await saveIndex(recipe.id, parsed.data.ingredients, read);
      return text({ saved: true, id: recipe.id, title: recipe.title, url: link(recipe.id) });
    },
  );

  server.registerTool(
    'import_recipe_from_url',
    {
      title: 'Import recipe from a link',
      description:
        "Import a recipe from a web page into the user's recipe box. The server fetches the page and extracts the recipe itself, so use this for recipe links instead of copying the content into save_recipe.",
      inputSchema: { url: z.string().describe('The recipe page URL') },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ url }) => {
      try {
        const existing = await findExistingRecipe(url);
        if (existing) {
          return text({ saved: false, alreadySaved: true, ...existing, url: link(existing.id) });
        }
        const { draft, method } = await extractFromUrl(url);
        const recipe = await createRecipe(draftToInput(draft), {
          userId: null,
          needsReview: method === 'ai',
        });
        return text({ saved: true, id: recipe.id, title: recipe.title, url: link(recipe.id) });
      } catch (err) {
        if (err instanceof ImportError || err instanceof FetchError) return toolError(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    'search_recipes',
    {
      title: 'Search recipes',
      description:
        "Search the user's recipe box by words in the title, description, ingredients or tags. Call with no query to list the most recent recipes. Use get_recipe for the full recipe.",
      inputSchema: {
        query: z.string().nullish().describe('Words to look for, e.g. "chickpea curry"'),
        tag: z.string().nullish().describe('Only recipes with this tag'),
        limit: z.number().int().min(1).max(50).nullish().describe('Default 20'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, tag, limit }) => {
      const and = await searchWhere(query ?? '');
      if (tag) and.push({ tags: { some: { name: tag.trim().toLowerCase() } } });
      const where: Prisma.RecipeWhereInput = { AND: and };

      const recipes = await prisma.recipe.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit ?? 20,
        select: {
          id: true,
          title: true,
          description: true,
          source: true,
          totalMinutes: true,
          favorite: true,
          createdAt: true,
          tags: withTags.tags,
        },
      });
      return text(recipes.map((r) => ({ ...serialize(r), url: link(r.id) })));
    },
  );

  server.registerTool(
    'get_recipe',
    {
      title: 'Get recipe',
      description: 'Get a full recipe (ingredients, steps, notes) by id.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const recipe = await prisma.recipe.findUnique({ where: { id }, include: withTags });
      if (!recipe) return toolError(`No recipe with id ${id}`);
      return text(forClaude(serialize(recipe), link));
    },
  );

  server.registerTool(
    'update_recipe',
    {
      title: 'Update recipe',
      description:
        'Change an existing recipe. Only the fields you pass are changed; ingredients, instructions and tags replace the whole list, so send the complete updated list. Call get_recipe first to see the current version.',
      inputSchema: {
        id: z.string(),
        ...Object.fromEntries(
          Object.entries(recipeFields).map(([k, v]) => [k, v.optional()]),
        ) as { [K in keyof typeof recipeFields]: z.ZodOptional<(typeof recipeFields)[K]> },
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id, ...changes }) => {
      const existing = await prisma.recipe.findUnique({ where: { id }, include: withTags });
      if (!existing) return toolError(`No recipe with id ${id}`);

      const current = serialize(existing);
      const merged = {
        title: current.title,
        description: current.description,
        source: current.source,
        sourceUrl: current.sourceUrl,
        servings: current.servings,
        prepMinutes: current.prepMinutes,
        cookMinutes: current.cookMinutes,
        totalMinutes: current.totalMinutes,
        ingredients: current.ingredients,
        instructions: current.instructions,
        notes: current.notes,
        favorite: current.favorite,
        tags: current.tags,
        ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
        imageUrl: changes.imageUrl || undefined,
      };
      const parsed = recipeInput.safeParse({ ...merged, tags: merged.tags ?? [] });
      if (!parsed.success) return toolError(z.prettifyError(parsed.error));

      const updated = await updateRecipe(id, parsed.data);
      if (!updated) return toolError(`No recipe with id ${id}`);
      return text({ updated: true, id, title: updated.title, url: link(id) });
    },
  );

  server.registerTool(
    'get_this_week',
    {
      title: 'Get this week',
      description:
        'List the recipes planned for this week (recipes drop off 7 days after being added), with whether each has been cooked.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const plan = await getPlan();
      return text(
        plan.map((p) => ({
          planItemId: p.id,
          recipeId: p.recipe.id,
          title: p.recipe.title,
          servingsMultiplier: p.scale,
          cooked: Boolean(p.cookedAt),
          addedOn: p.createdAt,
          url: link(p.recipe.id),
        })),
      );
    },
  );

  server.registerTool(
    'add_to_this_week',
    {
      title: 'Add to this week',
      description:
        "Put a saved recipe on this week's meal plan. Use search_recipes to find the id. servingsMultiplier scales it (0.5 = half, 2 = double).",
      inputSchema: {
        recipeId: z.string(),
        servingsMultiplier: z.number().positive().max(20).nullish(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ recipeId, servingsMultiplier }) => {
      const recipe = await prisma.recipe.findUnique({ where: { id: recipeId }, select: { title: true } });
      if (!recipe) return toolError(`No recipe with id ${recipeId}`);
      await addToPlan(recipeId, servingsMultiplier ?? 1, null);
      return text({ added: true, title: recipe.title, url: link(recipeId) });
    },
  );

  server.registerTool(
    'get_grocery_list',
    {
      title: 'Get grocery list',
      description: 'Show the shared grocery list, grouped by store section, with checked-off items marked.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const groups = await getGroceries();
      return text(
        groups.map((g) => ({
          item: g.items.length > 1 ? g.name : g.items[0].text,
          buy: g.buy,
          lines: g.items.length > 1 ? g.items.map((i) => i.text) : undefined,
          aisle: g.aisle,
          checked: g.checked,
          forRecipes: [...new Set(g.items.map((i) => i.recipe?.title).filter(Boolean))],
        })),
      );
    },
  );

  server.registerTool(
    'add_to_grocery_list',
    {
      title: 'Add to grocery list',
      description:
        "Add items to the shared grocery list, one ingredient per item with its quantity (e.g. \"2 lb chicken thighs\"). Before adding a recipe's ingredients, leave out pantry staples the user said they already have. Items are sorted into store sections automatically.",
      inputSchema: {
        items: z.array(z.string()).min(1).max(100),
        recipeId: z.string().nullish().describe('The recipe these are for, if any'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ items, recipeId }) => {
      const added = await addGroceries(
        items.map((t) => ({ text: t, recipeId: recipeId ?? null })),
        null,
      );
      return text({ added, url: `${baseUrl}/groceries` });
    },
  );

  server.registerTool(
    'list_meals',
    {
      title: 'List meals',
      description:
        'List saved meals. A meal is a named set of recipes cooked together, like "Taco night" or "Thanksgiving".',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const meals = await listMeals();
      return text(
        meals.map((m) => ({
          mealId: m.id,
          name: m.name,
          serves: m.servings,
          recipes: m.recipeTitles,
          url: `${baseUrl}/m/${m.id}`,
        })),
      );
    },
  );

  server.registerTool(
    'get_meal',
    {
      title: 'Get meal',
      description: "Get a meal's recipes (with ids and each recipe's amount multiplier) and notes.",
      inputSchema: { mealId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ mealId }) => {
      const meal = await getMeal(mealId);
      if (!meal) return toolError(`No meal with id ${mealId}`);
      return text({
        mealId: meal.id,
        name: meal.name,
        serves: meal.servings,
        notes: meal.notes,
        recipes: meal.recipes.map((r) => ({
          recipeId: r.recipe.id,
          title: r.recipe.title,
          recipeServes: r.recipe.servings,
          amountMultiplier: r.scale,
        })),
        url: `${baseUrl}/m/${meal.id}`,
      });
    },
  );

  server.registerTool(
    'create_meal',
    {
      title: 'Create meal',
      description:
        'Group saved recipes into a meal (e.g. a main and sides, or a holiday dinner). Find recipe ids with search_recipes first; save any new recipes with save_recipe before adding them. Recipes are kept in the order given.',
      inputSchema: {
        name: z.string(),
        recipeIds: z.array(z.string()).min(1).max(50),
        serves: z.number().int().positive().nullish().describe('How many people the meal feeds as planned'),
        notes: z.string().nullish().describe('Timing or plan notes, e.g. "Turkey in by 11"'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ name, recipeIds, serves, notes }) => {
      const meal = await createMeal({ name, recipeIds, servings: serves ?? null, notes: notes ?? null }, null);
      const saved = await getMeal(meal.id);
      return text({
        created: true,
        mealId: meal.id,
        recipes: saved?.recipes.map((r) => r.recipe.title),
        url: `${baseUrl}/m/${meal.id}`,
      });
    },
  );

  server.registerTool(
    'add_meal_to_week',
    {
      title: 'Add meal to this week',
      description:
        "Put every recipe in a meal on this week's plan, grouped under the meal. Pass serves to scale the whole meal to a number of people (needs the meal to have a serving count), or multiplier to scale directly.",
      inputSchema: {
        mealId: z.string(),
        serves: z.number().positive().nullish(),
        multiplier: z.number().positive().max(20).nullish(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ mealId, serves, multiplier }) => {
      const meal = await getMeal(mealId);
      if (!meal) return toolError(`No meal with id ${mealId}`);
      const factor = serves && meal.servings ? serves / meal.servings : (multiplier ?? 1);
      await addMealToPlan(mealId, factor, null);
      return text({ added: true, meal: meal.name, recipes: meal.recipes.length, multiplier: factor });
    },
  );

  // ---------- Notes, reminders, appointments ----------

  const when = z
    .string()
    .nullish()
    .describe(
      'A date and time with its UTC offset, e.g. "2026-10-06T15:30:00-04:00", or just a date ("2026-10-06") for all day. Use the user\'s local time zone.',
    );

  /** Accepts "YYYY-MM-DD" (all day) or a date-time with an offset. */
  function parseWhen(value: string | null | undefined, field: string) {
    if (!value) return { iso: null, allDay: false };
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { iso: allDayInstant(value).toISOString(), allDay: true };
    if (/(Z|[+-]\d{2}:?\d{2})$/i.test(value) && !Number.isNaN(Date.parse(value))) {
      return { iso: new Date(value).toISOString(), allDay: false };
    }
    throw new NoteError(`${field} must be a date (2026-10-06) or a date-time with its UTC offset (2026-10-06T15:30:00-04:00).`);
  }

  const repeats = z
    .string()
    .nullish()
    .describe(
      'Only if it repeats: an iCalendar RRULE using FREQ (DAILY, WEEKLY, MONTHLY, YEARLY), INTERVAL, BYDAY and UNTIL (a date) or COUNT. Examples: "FREQ=WEEKLY;BYDAY=TU", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", "FREQ=MONTHLY;BYDAY=-1FR" (last Friday), "FREQ=MONTHLY" (same day of the month as startsAt), "FREQ=DAILY;UNTIL=20261231". startsAt must be the first occurrence.',
    );

  const noteLink = (id: string) => `${baseUrl}/n/${id}`;
  type SavedNote = Awaited<ReturnType<typeof listNotes>>[number];
  // Close enough for listing: timed items are placed on their UTC day.
  const startDay = (n: SavedNote) => n.startsAt!.toISOString().slice(0, 10);
  const noteForClaude = (n: SavedNote) => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
    details: n.body,
    // All-day items come back as a plain date.
    startsAt: n.startsAt && (n.allDay ? n.startsAt.toISOString().slice(0, 10) : n.startsAt.toISOString()),
    endsAt: n.endsAt && (n.allDay ? n.endsAt.toISOString().slice(0, 10) : n.endsAt.toISOString()),
    repeats: n.recurrence,
    repeatsInWords: n.recurrence && n.startsAt ? describeRule(parseRule(n.recurrence), startDay(n)) : null,
    location: n.location,
    done: n.doneAt !== null,
    hasPhoto: Boolean(n.image),
    addedBy: n.createdBy?.name ?? null,
    url: noteLink(n.id),
  });

  server.registerTool(
    'save_note',
    {
      title: 'Save a note, reminder or appointment',
      description:
        "Save something to the family's shared organizer (the same app as the recipe box). kind APPOINTMENT is an event at a set date, like a doctor's visit or a school event; REMINDER is something to do, optionally due at startsAt; NOTE is information to keep. Appointments need startsAt.",
      inputSchema: {
        kind: z.enum(NOTE_KINDS),
        title: z.string().describe('Short, scannable title, e.g. "Dentist: Maya"'),
        details: z.string().nullish().describe('Anything else worth keeping: what to bring, phone numbers, links'),
        startsAt: when.describe('When the appointment starts or the reminder is due. ' + when.description),
        endsAt: when.describe(
          "When an appointment ends, if known. For a reminder, a time later the same day makes it a block set aside for doing the task, shown busy on the calendar. " +
            when.description,
        ),
        location: z.string().nullish().describe('Appointments only: the place or address'),
        repeats,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ kind, title, details, startsAt, endsAt, location, repeats: recurrence }) => {
      try {
        const start = parseWhen(startsAt, 'startsAt');
        const end = parseWhen(endsAt, 'endsAt');
        const note = await createNote(
          {
            kind,
            title,
            body: details ?? null,
            startsAt: start.iso,
            endsAt: end.iso,
            allDay: start.allDay,
            location: location ?? null,
            recurrence,
          },
          null,
        );
        return text({ saved: true, ...noteForClaude(note) });
      } catch (err) {
        if (err instanceof NoteError) return toolError(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    'list_notes',
    {
      title: 'List notes, reminders and appointments',
      description:
        'List what\'s in the shared organizer: upcoming appointments, open reminders and notes, newest first. Appointments that already ended and reminders ticked off over a month ago are left out unless includePast is true.',
      inputSchema: {
        kind: z.enum(NOTE_KINDS).nullish().describe('Only this kind'),
        query: z.string().nullish().describe('Only items with these words in the title or details'),
        includePast: z.boolean().nullish(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ kind, query, includePast }) => {
      const now = Date.now();
      const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const notes = (await listNotes()).filter((n) => {
        if (kind && n.kind !== kind) return false;
        if (!includePast && n.kind === 'APPOINTMENT') {
          const over = n.recurrence
            ? !nextOccurrence(parseRule(n.recurrence), startDay(n), new Date(now - 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
            : (n.endsAt ?? n.startsAt)!.getTime() < now - 24 * 60 * 60 * 1000;
          if (over) return false;
        }
        const haystack = `${n.title} ${n.body ?? ''} ${n.location ?? ''}`.toLowerCase();
        return words.every((w) => haystack.includes(w));
      });
      return text(notes.map(noteForClaude));
    },
  );

  server.registerTool(
    'update_note',
    {
      title: 'Update a note, reminder or appointment',
      description:
        'Change a saved item (find its id with list_notes), or tick a reminder off with done: true (for a repeating reminder, that ticks off the current occurrence). Only the fields you pass change; pass null to clear one, e.g. repeats: null to stop it repeating. Changes apply to every occurrence of a repeating item.',
      inputSchema: {
        id: z.string(),
        kind: z.enum(NOTE_KINDS).optional(),
        title: z.string().optional(),
        details: z.string().nullable().optional(),
        startsAt: when.optional(),
        endsAt: when.optional(),
        location: z.string().nullable().optional(),
        repeats: repeats.optional(),
        done: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, details, startsAt, endsAt, repeats: recurrence, ...rest }) => {
      try {
        const start = startsAt !== undefined ? parseWhen(startsAt, 'startsAt') : undefined;
        const end = endsAt !== undefined ? parseWhen(endsAt, 'endsAt') : undefined;
        const note = await updateNote(id, {
          ...rest,
          ...(details !== undefined ? { body: details } : {}),
          ...(recurrence !== undefined ? { recurrence } : {}),
          ...(start ? { startsAt: start.iso, allDay: start.allDay } : {}),
          ...(end ? { endsAt: end.iso } : {}),
        });
        if (!note) return toolError(`No note with id ${id}`);
        return text({ updated: true, ...noteForClaude(note) });
      } catch (err) {
        if (err instanceof NoteError) return toolError(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    'delete_note',
    {
      title: 'Delete a note, reminder or appointment',
      description:
        "Delete a saved note, reminder or appointment (find its id with list_notes). Use it when the user asks to delete or remove an item; that request is all it needs. The item goes for both people, along with its Google Calendar event (every occurrence, if it repeats), so when the request could match more than one item, check which one first. For a reminder that's been done, prefer update_note with done: true unless they ask for it gone.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id }) => {
      const note = await prisma.note.findUnique({ where: { id }, select: { title: true, kind: true } });
      if (!note || !(await deleteNote(id))) return toolError(`No note with id ${id}`);
      return text({ deleted: true, id, ...note });
    },
  );

  return server;
}
