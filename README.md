# Recipes

A personal recipe box. Mobile-first, with import from recipe links, plus a Claude connector (MCP) so recipes from Claude chats can be saved straight into it.

- `server/`: Fastify + Prisma (Postgres) API. In production it also serves the built web app and recipe images.
- `web/`: React + Vite app.

## Local development

Requires Node 22+ and a local Postgres.

```sh
cp server/.env.example server/.env  # then fill in DATABASE_URL and SESSION_SECRET
createdb -U postgres recipes  # or create the database however you like
npm install
npm run db:migrate -w server  # applies migrations and generates the Prisma client
npm run user:create -- you@example.com "Your Name" "a-good-password"
npm run dev                   # API on :3000, web on :5173
```

Open http://localhost:5173. To try it on your phone, open `http://<your-computer's-LAN-IP>:5173` on the same Wi-Fi.

### Trying the importer

```sh
cd server && npx tsx --env-file=.env src/scripts/tryImport.ts <url> [...more urls]
```

Prints what the importer extracts from each link without saving anything.

## How import works

1. The server fetches the page. It refuses private and internal addresses, and uses an honest User-Agent over HTTP/2, which gets through Cloudflare bot checks more often than pretending to be Chrome.
2. It reads schema.org `Recipe` JSON-LD, which most recipe sites include for Google. Ingredient groups from WP Recipe Maker blogs are recovered from the page HTML.
3. If there's no JSON-LD, it tries microdata.
4. If neither is present, and `ANTHROPIC_API_KEY` is set, Claude extracts the recipe from the page text. Recipes imported this way are flagged for review.
5. Images are downloaded and resized with `sharp` into `UPLOAD_DIR` (1200px WebP plus a 240px thumbnail).

Bulk imports are queued as `ImportJob` rows and processed one at a time by an in-process worker. Links that match an existing recipe's source URL, after tracking parameters are removed, are marked as duplicates.

## Cooking features

- **Scaling:** the servings stepper (or ½×–3× when a recipe has no serving count) rescales ingredient lines in the browser (`web/src/scale.ts`). It scales the leading amount and any other amount followed by a unit, leaves package sizes such as "2 (15 oz) cans" alone, and tidies kitchen volumes (6 tsp becomes 2 tbsp).
- **Timers:** times in steps become buttons (`web/src/durations.ts`). They run in-app, persist across reloads, and beep and vibrate when done. On iPhone they can instead start the Clock app through a "Recipe Timer" Shortcut (setup is in Settings).
- **Prep (mise en place):** "Start cooking" opens a prep screen first: the knife work to do up front, then one bowl per moment ingredients go in together ("add the garlic, nutmeg, salt and pepper" is one ramekin). Claude builds it the first time (`server/src/prep.ts`); it's cached per recipe and rebuilt when the ingredients or steps change. Bowls point at ingredient lines, so they follow the servings scaler, and cook mode shows each step's bowls under it.
- **Meals:** named, ordered sets of recipes ("Taco night", "Thanksgiving"), found under Recipes → Meals. Each recipe has its own amount within the meal, and the meal's servings stepper scales them all together. Adding a meal to the week plans every recipe, grouped under one card.
- **This week:** recipes on the plan remember their serving size and drop off 7 days after being added.
- **Groceries:** add from a recipe or the whole week, unticking what you already have, or type or paste items (one per line or comma, so a list copied from a text works). Items are saved at once, then tidied and sorted into store sections by Claude in the background (`server/src/groceries.ts`, Haiku by default via `GROCERY_MODEL`). Items bought before reuse their remembered aisle without an AI call. Without an API key items stay unsorted. The list polls every few seconds so both phones stay in sync.

## Claude connector (MCP)

The server exposes an MCP endpoint at `/mcp/<token>` with these tools:

| Tool | What it does |
|---|---|
| `save_recipe` | Saves a recipe from the conversation, with an optional `imageUrl` that the server downloads |
| `import_recipe_from_url` | Imports a recipe page through the same pipeline as the web app |
| `search_recipes` | Searches titles, descriptions, notes, tags and ingredients |
| `get_recipe` | Returns a full recipe |
| `update_recipe` | Partial update: only the fields you pass change |
| `get_this_week` / `add_to_this_week` | Read or add to the meal plan, with a servings multiplier |
| `list_meals` / `get_meal` / `create_meal` / `add_meal_to_week` | Browse and build meals, and plan a whole meal for a number of people |
| `get_grocery_list` / `add_to_grocery_list` | Read or add to the shared grocery list |

There's deliberately no delete tool.

To set it up, open **Settings** in the app (the account tab) and choose **Set up connector**. That generates the link and shows it once, with a copy button and instructions for adding it in Claude under **Settings → Connectors → Add custom connector**.

The token in the URL is the only auth, so treat the link like a password: anyone who has it can read and add recipes. **Generate a new link** revokes the old one, and **Turn off** disables the connector. Only a SHA-256 hash of the token is stored, and it's redacted from request logs.

### Changing the schema

Edit `server/prisma/schema.prisma`, then run `npm run db:migrate -w server -- --name what_changed`. Commit the new folder under `server/prisma/migrations/`.

## Deploying on Railway

1. Create a project from this GitHub repo, then add a **PostgreSQL** database to it.
2. On the app service, set these variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `SESSION_SECRET` = a long random string
   - `NODE_ENV` = `production`
   - `UPLOAD_DIR` = `<volume mount>/uploads`, e.g. `/app/data/uploads`
   - `PORT` = `8080` (and point the public domain at port 8080)
   - `ANTHROPIC_API_KEY` = optional, enables AI extraction
3. Attach a **volume** to the app service, for example at `/app/data`.
4. Under Networking, generate a public domain that targets port 8080.
5. Leave **Custom Start Command** empty (or set it to `npm start`). If Railway auto-detects the workspaces, it may fill in `npm run dev --workspace=web`, which runs the Vite dev server instead of the app.

`railway.json` sets the build (`npm run build`), start (`npm start`, which runs `prisma migrate deploy` first) and health check (`/api/health`).

### Users

Admins manage people from **Settings → People** in the app: add someone with a temporary password, reset a password, rename, make or remove an admin, or remove a person. Their recipes stay. Everyone can change their own password under **Settings → Account**. Everyone shares one recipe box.

### Creating the first user in production

The production database is only reachable inside Railway, so run the compiled script in the app container. With the Railway CLI linked to the app service:

```sh
railway ssh -- node server/dist/scripts/createUser.js you@example.com "Your Name" "password"
```

The first user is always an admin, and `--admin` makes any user one. Running the script again with the same email resets that user's password, which is useful if an admin is ever locked out.
